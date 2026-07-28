import Database from 'better-sqlite3'
import { app, BrowserWindow } from 'electron'
import { createHash, randomUUID } from 'crypto'
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'fs'
import { basename, dirname, join, resolve } from 'path'
import {
  MemoryApi,
  memoryWriteRejection,
  type MemoryEntry,
  type MemoryInjection as MemoryInjectionContract,
  type MemoryKind,
  type MemoryScope
} from '../../shared/memory'
import { notify } from '../services/notify-center'
import {
  ensureMemoryAuditTable,
  expireEntry,
  migrateMemoryFtsSchema,
  renderInjectionLines,
  restoreEntry
} from './opset'

const SCOPES = new Set<MemoryScope>(['global', 'project', 'space', 'agent'])
const KINDS = new Set<MemoryKind>(['rule', 'skill', 'fact'])
const ORIGINS = new Set<MemoryEntry['origin']>(['user', 'learned'])
const ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const MAX_ID = 120
const MAX_TITLE = 240
const MAX_BODY = 50_000
const MAX_SCOPE_REF = 2_000
const INJECTION_BUDGET = 2_000

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

function cleanString(value: unknown, field: string, max: number, allowEmpty = false): string {
  if (typeof value !== 'string') throw new Error(`${field} must be a string`)
  const clean = value.replace(/\r\n/g, '\n').replace(/\u0000/g, '')
  if ((!allowEmpty && !clean.trim()) || clean.length > max) throw new Error(`Invalid ${field}`)
  return clean
}

function cleanTimestamp(value: unknown, field: string): string {
  const timestamp = cleanString(value, field, 40)
  const parsed = Date.parse(timestamp)
  if (!Number.isFinite(parsed)) throw new Error(`Invalid ${field}`)
  return new Date(parsed).toISOString()
}

function cleanTitle(value: unknown): string {
  const title = cleanString(value, 'title', MAX_TITLE).trim()
  if (/\r|\n|[\u0001-\u0008\u000b\u000c\u000e-\u001f]/.test(title)) {
    throw new Error('Memory title must be one line')
  }
  return title
}

function validateId(value: unknown): string {
  const id = cleanString(value, 'memory id', MAX_ID)
  if (!ID_PATTERN.test(id)) throw new Error('Memory id must be a kebab-case slug')
  return id
}

function validateScopeRef(scope: MemoryScope, value: unknown): string | undefined {
  if (scope === 'global') {
    if (value !== undefined && value !== null && value !== '') {
      throw new Error('Global memory cannot have a scopeRef')
    }
    return undefined
  }
  return cleanString(value, 'scopeRef', MAX_SCOPE_REF)
}

function normalizeEntry(value: unknown, existing?: MemoryEntry | null): MemoryEntry {
  if (!value || typeof value !== 'object') throw new Error('Invalid memory entry')
  const input = value as Record<string, unknown>
  if (!SCOPES.has(input.scope as MemoryScope)) throw new Error('Invalid memory scope')
  if (!KINDS.has(input.kind as MemoryKind)) throw new Error('Invalid memory kind')
  if (!ORIGINS.has(input.origin as MemoryEntry['origin'])) throw new Error('Invalid memory origin')
  if (typeof input.enabled !== 'boolean') throw new Error('enabled must be a boolean')
  const scope = input.scope as MemoryScope
  const now = new Date().toISOString()
  const optionalTimestamp = (field: 'validAt' | 'invalidAt' | 'expiredAt'): string | undefined =>
    input[field] === undefined || input[field] === null || input[field] === ''
      ? undefined
      : cleanTimestamp(input[field], field)
  const sourceRunId = input.sourceRunId === undefined || input.sourceRunId === null || input.sourceRunId === ''
    ? undefined
    : cleanString(input.sourceRunId, 'sourceRunId', 200).trim()
  const source = input.source === undefined || input.source === null || input.source === ''
    ? undefined
    : cleanString(input.source, 'source', 32_768).trim()
  return {
    id: validateId(input.id),
    scope,
    scopeRef: validateScopeRef(scope, input.scopeRef),
    kind: input.kind as MemoryKind,
    title: cleanTitle(input.title),
    body: cleanString(input.body, 'body', MAX_BODY, true),
    origin: input.origin as MemoryEntry['origin'],
    createdAt: existing?.createdAt ?? cleanTimestamp(input.createdAt ?? now, 'createdAt'),
    updatedAt: existing ? now : cleanTimestamp(input.updatedAt ?? now, 'updatedAt'),
    enabled: input.enabled,
    // w15/memory-opset — bi-temporal fields survive round-trips untouched.
    validAt: optionalTimestamp('validAt'),
    invalidAt: optionalTimestamp('invalidAt'),
    expiredAt: optionalTimestamp('expiredAt'),
    sourceRunId,
    source,
    // w17/context-blocks — absent stays absent so unlocked facts serialize
    // exactly as they did before the flag existed.
    readOnly: input.readOnly === true ? true : undefined
  }
}

function scopeRefDirectory(scopeRef: string): string {
  const readable = scopeRef
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'scope'
  const digest = createHash('sha256').update(scopeRef).digest('hex').slice(0, 12)
  return `${readable}-${digest}`
}

function pathForEntry(entry: MemoryEntry): string {
  const scopeDir = join(memoryRoot(), entry.scope)
  if (entry.scope === 'global') return join(scopeDir, `${entry.id}.md`)
  return join(scopeDir, scopeRefDirectory(entry.scopeRef!), `${entry.id}.md`)
}

function serialize(entry: MemoryEntry): string {
  const fields: [keyof MemoryEntry, unknown][] = [
    ['id', entry.id],
    ['scope', entry.scope],
    ...(entry.scopeRef ? ([['scopeRef', entry.scopeRef]] as [keyof MemoryEntry, unknown][]) : []),
    ['kind', entry.kind],
    ['title', entry.title],
    ['origin', entry.origin],
    ['createdAt', entry.createdAt],
    ['updatedAt', entry.updatedAt],
    ['enabled', entry.enabled],
    ...(['validAt', 'invalidAt', 'expiredAt', 'sourceRunId', 'source', 'readOnly'] as const)
      .filter((key) => entry[key] !== undefined)
      .map((key) => [key, entry[key]] as [keyof MemoryEntry, unknown])
  ]
  const frontmatter = fields.map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join('\n')
  return `---\n${frontmatter}\n---\n${entry.body}`
}

function parseScalar(value: string): unknown {
  try {
    return JSON.parse(value)
  } catch {
    return value.trim()
  }
}

function parseMemoryFile(path: string): MemoryEntry {
  const source = readFileSync(path, 'utf8')
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/.exec(source)
  if (!match) throw new Error('Missing memory frontmatter')
  const metadata: Record<string, unknown> = Object.create(null) as Record<string, unknown>
  const allowed = new Set([
    'id', 'scope', 'scopeRef', 'kind', 'title', 'origin', 'createdAt', 'updatedAt', 'enabled',
    'validAt', 'invalidAt', 'expiredAt', 'sourceRunId', 'source', 'readOnly'
  ])
  for (const line of match[1].split(/\r?\n/)) {
    const separator = line.indexOf(':')
    if (separator <= 0) throw new Error('Invalid memory frontmatter')
    const key = line.slice(0, separator).trim()
    if (!allowed.has(key)) continue
    metadata[key] = parseScalar(line.slice(separator + 1).trim())
  }
  const entry = normalizeEntry({ ...metadata, body: match[2] })
  if (basename(path) !== `${entry.id}.md`) throw new Error('Memory filename does not match its id')
  const actualPath = resolve(path)
  const canonicalPath = resolve(pathForEntry(entry))
  const samePath = process.platform === 'win32'
    ? actualPath.toLowerCase() === canonicalPath.toLowerCase()
    : actualPath === canonicalPath
  if (!samePath) throw new Error('Memory frontmatter does not match its canonical scope path')
  return entry
}

function entryFiles(): string[] {
  const files: string[] = []
  const walk = (dir: string, depth: number): void => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    for (const entry of entries) {
      const path = join(dir, entry.name)
      if (entry.isFile() && entry.name.endsWith('.md')) files.push(path)
      else if (entry.isDirectory() && depth < 2) walk(path, depth + 1)
    }
  }
  for (const scope of SCOPES) walk(join(memoryRoot(), scope), 0)
  return files
}

function readAllEntries(reportInvalid = false): MemoryEntry[] {
  const entries: MemoryEntry[] = []
  let invalid = 0
  for (const path of entryFiles()) {
    try {
      entries.push(parseMemoryFile(path))
    } catch (error) {
      invalid += 1
      console.warn('[morz] skipped invalid memory file:', path, error)
    }
  }
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

function replaceIndex(entry: MemoryEntry): void {
  const store = database()
  store.transaction(() => {
    store.prepare('DELETE FROM memory_fts WHERE id = ?').run(entry.id)
    store.prepare(INDEX_INSERT).run(...indexValues(entry))
  })()
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
    const root = memoryRoot()
    mkdirSync(root, { recursive: true })
    for (const scope of SCOPES) mkdirSync(join(root, scope), { recursive: true })
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
  if (scope !== undefined && !SCOPES.has(scope)) throw new Error('Invalid memory scope')
  const cleanScopeRef = scopeRef === undefined
    ? undefined
    : cleanString(scopeRef, 'scopeRef', MAX_SCOPE_REF)
  return readAllEntries()
    .filter((entry) => scope === undefined || entry.scope === scope)
    .filter((entry) => cleanScopeRef === undefined || entry.scopeRef === cleanScopeRef)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id))
}

export function getMemory(idValue: unknown): MemoryEntry | null {
  ensureInitialized()
  const id = validateId(idValue)
  const matches = readAllEntries().filter((entry) => entry.id === id)
  return matches.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0] ?? null
}

export function saveMemory(value: unknown): MemoryEntry {
  ensureInitialized()
  const candidate = value && typeof value === 'object' ? value as Record<string, unknown> : null
  const id = validateId(candidate?.id)
  const existing = getMemory(id)
  const entry = normalizeEntry(value, existing)
  // w17/context-blocks — read-only is enforced here, on the one path every
  // write funnels through (Settings saves, enable toggles, approved op-set
  // updates), so no producer can quietly rewrite a locked fact. The guard runs
  // on the NORMALIZED candidate so an unlock is compared field by field against
  // what is stored — unlocking and rewriting in one call is not an unlock.
  const rejection = memoryWriteRejection(existing, entry)
  if (rejection) throw new Error(rejection)
  const target = pathForEntry(entry)
  mkdirSync(dirname(target), { recursive: true })
  const temporary = join(dirname(target), `.${entry.id}.${randomUUID()}.tmp`)
  try {
    writeFileSync(temporary, serialize(entry), { encoding: 'utf8', flag: 'wx' })
    renameSync(temporary, target)
  } finally {
    rmSync(temporary, { force: true })
  }
  for (const path of entryFiles()) {
    if (path !== target && basename(path) === `${entry.id}.md`) rmSync(path, { force: true })
  }
  replaceIndex(entry)
  emitMemoryChanged()
  return entry
}

export function removeMemory(idValue: unknown): void {
  ensureInitialized()
  const id = validateId(idValue)
  const rejection = memoryWriteRejection(getMemory(id), null)
  if (rejection) throw new Error(rejection)
  for (const path of entryFiles()) {
    if (basename(path) === `${id}.md`) rmSync(path, { force: true })
  }
  database().prepare('DELETE FROM memory_fts WHERE id = ?').run(id)
  emitMemoryChanged()
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

/** w15/memory-opset — UPDATE/DELETE soft-expire: row kept, auditable, restorable. */
export function expireMemory(idValue: unknown, sourceRunId?: string): MemoryEntry {
  const entry = getMemory(idValue)
  if (!entry) throw new Error('Memory entry not found')
  if (entry.expiredAt) return entry
  return saveMemory(expireEntry(entry, new Date().toISOString(), sourceRunId))
}

export function restoreMemory(idValue: unknown): MemoryEntry {
  const entry = getMemory(idValue)
  if (!entry) throw new Error('Memory entry not found')
  if (!entry.expiredAt) return entry
  return saveMemory(restoreEntry(entry))
}

function renderInjection(opts: { projectRoot?: string; spaceId?: string; agentId?: string }): string {
  const chain = [
    ...listMemory('global'),
    ...(opts.projectRoot ? listMemory('project', opts.projectRoot) : []),
    ...(opts.spaceId ? listMemory('space', opts.spaceId) : []),
    ...(opts.agentId ? listMemory('agent', opts.agentId) : [])
  ]
  // w15/memory-opset — pure renderer handles dedup, priority, the budget, and
  // validity windows for superseded facts ("used X until <date>").
  return renderInjectionLines(chain, INJECTION_BUDGET)
}

export const MemoryInjection: MemoryInjectionContract = {
  render: renderInjection
}
