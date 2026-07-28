import Database from 'better-sqlite3'
import { app, BrowserWindow } from 'electron'
import { mkdirSync } from 'fs'
import { join } from 'path'
import {
  MemoryApi,
  type MemoryEntry,
  type MemoryInjection as MemoryInjectionContract,
  type MemoryScope
} from '../../shared/memory'
import { notify } from '../services/notify-center'
import {
  ensureMemoryAuditTable,
  memoryAuditSuccessors,
  migrateMemoryFtsSchema,
  restoreEntry
} from './opset'
import { renderMemoryPreamble } from './render'
import { assertRestoreAllowed } from './apply'
import {
  MEMORY_SCOPES,
  cleanScopeRef,
  ensureMemoryDirectories,
  normalizeEntry,
  readEntryDocuments,
  validateId,
  writeEntryDocuments
} from './documents'

let db: Database.Database | null = null
let initialized = false
let initializing = false

function memoryRoot(): string {
  return join(app.getPath('appData'), 'Morz', 'memory')
}

function database(): Database.Database {
  if (db) return db
  const dir = join(app.getPath('appData'), 'Morz')
  mkdirSync(dir, { recursive: true })
  db = new Database(join(dir, 'morz.db'))
  db.pragma('journal_mode = WAL')
  return db
}

export function memoryDatabase(): Database.Database {
  initializeMemoryStore()
  return database()
}

function readAllEntries(reportInvalid = false): MemoryEntry[] {
  const { entries, invalid } = readEntryDocuments(memoryRoot())
  if (reportInvalid && invalid > 0) {
    notify({
      id: 'app:memory-index',
      level: 'warning',
      source: 'app',
      title: 'Some memory files could not be indexed',
      detail: `${invalid} invalid memory file${invalid === 1 ? '' : 's'} remain on disk and were skipped.`
    })
  }
  return entries
}

const INDEX_INSERT = `
  INSERT INTO memory_fts (id, title, body, valid_at, invalid_at, created_at, expired_at, source_run_id)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`

function indexValues(entry: MemoryEntry): unknown[] {
  return [
    entry.id,
    entry.title,
    entry.body,
    entry.validAt ?? entry.createdAt,
    entry.invalidAt ?? null,
    entry.createdAt,
    entry.expiredAt ?? null,
    entry.sourceRunId ?? null
  ]
}

function rebuildIndex(): void {
  const store = database()
  const entries = readAllEntries(true)
  store.transaction(() => {
    store.prepare('DELETE FROM memory_fts').run()
    const insert = store.prepare(INDEX_INSERT)
    for (const entry of entries) insert.run(...indexValues(entry))
  })()
}

export function initializeMemoryStore(): void {
  if (initialized || initializing) return
  initializing = true
  try {
    ensureMemoryDirectories(memoryRoot())
    // w15/memory-opset — bi-temporal columns via rename-copy-drop (see opset.ts);
    // the markdown re-index below backfills the temporal values.
    migrateMemoryFtsSchema(database())
    database().exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
        id UNINDEXED, title, body,
        valid_at UNINDEXED, invalid_at UNINDEXED, created_at UNINDEXED,
        expired_at UNINDEXED, source_run_id UNINDEXED,
        tokenize = 'unicode61'
      );
    `)
    ensureMemoryAuditTable(database())
    rebuildIndex()
    initialized = true
  } finally {
    initializing = false
  }
}

function ensureInitialized(): void {
  if (!initialized) initializeMemoryStore()
}

export function emitMemoryChanged(): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send(MemoryApi.changed)
  }
}

export function listMemory(scope?: MemoryScope, scopeRef?: string): MemoryEntry[] {
  ensureInitialized()
  if (scope !== undefined && !MEMORY_SCOPES.has(scope)) throw new Error('Invalid memory scope')
  const filterScopeRef = scopeRef === undefined ? undefined : cleanScopeRef(scopeRef)
  return readAllEntries()
    .filter((entry) => scope === undefined || entry.scope === scope)
    .filter((entry) => filterScopeRef === undefined || entry.scopeRef === filterScopeRef)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id))
}

export function getMemory(idValue: unknown): MemoryEntry | null {
  ensureInitialized()
  const id = validateId(idValue)
  const matches = readAllEntries().filter((entry) => entry.id === id)
  return matches.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0] ?? null
}

/** Markdown is the durable source of truth (write ordering lives in documents.ts). */
export function writeMemoryEntries(entries: MemoryEntry[], removeIds: string[] = []): void {
  ensureInitialized()
  writeEntryDocuments(memoryRoot(), entries, removeIds)
}

/** Rebuild the disposable FTS rows only after all Markdown writes land. */
export function indexMemoryEntries(entries: MemoryEntry[], removeIds: string[] = []): void {
  ensureInitialized()
  const normalized = entries.map((entry) => normalizeEntry(entry, null))
  const ids = new Set([...removeIds.map(validateId), ...normalized.map((entry) => entry.id)])
  const store = database()
  store.transaction(() => {
    const remove = store.prepare('DELETE FROM memory_fts WHERE id = ?')
    for (const id of ids) remove.run(id)
    const insert = store.prepare(INDEX_INSERT)
    for (const entry of normalized) insert.run(...indexValues(entry))
  })()
}

function saveMemory(value: unknown): MemoryEntry {
  ensureInitialized()
  const candidate = value && typeof value === 'object' ? value as Record<string, unknown> : null
  const id = validateId(candidate?.id)
  const entry = normalizeEntry(value, getMemory(id))
  writeMemoryEntries([entry])
  indexMemoryEntries([entry])
  emitMemoryChanged()
  return entry
}

export function setMemoryEnabled(idValue: unknown, enabled: unknown): MemoryEntry {
  if (typeof enabled !== 'boolean') throw new Error('enabled must be a boolean')
  const entry = getMemory(idValue)
  if (!entry) throw new Error('Memory entry not found')
  return saveMemory({ ...entry, enabled })
}

function ftsQuery(value: unknown, mode: 'AND' | 'OR' = 'AND'): string | null {
  if (typeof value !== 'string') throw new Error('Search query must be a string')
  const tokens = value.normalize('NFKC').match(/[\p{L}\p{N}]+/gu)?.slice(0, 12) ?? []
  return tokens.length
    ? tokens.map((token) => `"${token.replace(/"/g, '""')}"`).join(` ${mode} `)
    : null
}

export function searchMemory(query: unknown, limitValue?: unknown): MemoryEntry[] {
  ensureInitialized()
  const queryText = ftsQuery(query)
  if (!queryText) return []
  const limit = limitValue === undefined
    ? 20
    : typeof limitValue === 'number' && Number.isInteger(limitValue)
      ? Math.min(100, Math.max(1, limitValue))
      : (() => { throw new Error('Invalid search limit') })()
  // Soft-expired rows stay indexed for audit but never surface in search.
  const rows = database()
    .prepare('SELECT id FROM memory_fts WHERE memory_fts MATCH ? AND expired_at IS NULL ORDER BY bm25(memory_fts) LIMIT ?')
    .all(queryText, limit) as { id: string }[]
  return rows.map(({ id }) => getMemory(id)).filter((entry): entry is MemoryEntry => entry !== null)
}

/**
 * w15/memory-opset — top-k retrieval for op-set reconciliation. OR-matching
 * (bm25-ranked), unlike the user-facing AND search: a contradicting candidate
 * shares only some tokens with the fact it supersedes.
 */
export function searchMemoryNeighbors(query: unknown, limit = 10): MemoryEntry[] {
  ensureInitialized()
  const queryText = ftsQuery(query, 'OR')
  if (!queryText) return []
  const rows = database()
    .prepare('SELECT id FROM memory_fts WHERE memory_fts MATCH ? AND expired_at IS NULL ORDER BY bm25(memory_fts) LIMIT ?')
    .all(queryText, Math.min(20, Math.max(1, limit))) as { id: string }[]
  return rows.map(({ id }) => getMemory(id)).filter((entry): entry is MemoryEntry => entry !== null)
}

export function restoreMemory(idValue: unknown): MemoryEntry {
  ensureInitialized()
  const id = validateId(idValue)
  // One Markdown pass and one audit scan feed the whole chain walk.
  const entries = new Map<string, MemoryEntry>()
  for (const value of readAllEntries()) {
    const seen = entries.get(value.id)
    if (!seen || seen.updatedAt.localeCompare(value.updatedAt) < 0) entries.set(value.id, value)
  }
  const entry = entries.get(id) ?? null
  if (!entry) throw new Error('Memory entry not found')
  if (!entry.expiredAt) return entry
  assertRestoreAllowed(entry, { entries, auditSuccessors: memoryAuditSuccessors(database()) })
  return saveMemory(restoreEntry(entry))
}

function renderInjection(opts: { projectRoot?: string; spaceId?: string; agentId?: string }): string {
  const chain = [
    ...listMemory('global'),
    ...(opts.projectRoot ? listMemory('project', opts.projectRoot) : []),
    ...(opts.spaceId ? listMemory('space', opts.spaceId) : []),
    ...(opts.agentId ? listMemory('agent', opts.agentId) : [])
  ]
  // w17/renderer-core — the canonical renderer handles dedup, priority, and
  // the budget. Superseded facts are excluded there, not here.
  return renderMemoryPreamble(chain)
}

export const MemoryInjection: MemoryInjectionContract = {
  render: renderInjection
}
