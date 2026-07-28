/*
 * Markdown is the durable source of truth for memory. This module owns the
 * document layer alone — validation, the canonical scope path, serialization,
 * and the non-atomic write/prune sequence — with the memory root injected so
 * it stays electron-free (like opset.ts) and node:test can drive it against a
 * temporary directory. store.ts wires it to the real appData root, the FTS
 * index, and the notification centre.
 */
import { createHash, randomUUID } from 'crypto'
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'fs'
import { basename, dirname, join, resolve } from 'path'
import type { MemoryEntry, MemoryKind, MemoryScope } from '../../shared/memory'

export const MEMORY_SCOPES = new Set<MemoryScope>(['global', 'project', 'space', 'agent'])
const KINDS = new Set<MemoryKind>(['rule', 'skill', 'fact'])
const ORIGINS = new Set<MemoryEntry['origin']>(['user', 'learned'])
const ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const MAX_ID = 120
const MAX_TITLE = 240
const MAX_BODY = 50_000
const MAX_SCOPE_REF = 2_000

/** Every durable step of a write: the crash boundaries a retry must survive. */
export type MemoryWriteStep = { phase: 'write' | 'prune'; id: string }

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

export function validateId(value: unknown): string {
  const id = cleanString(value, 'memory id', MAX_ID)
  if (!ID_PATTERN.test(id)) throw new Error('Memory id must be a kebab-case slug')
  return id
}

export function cleanScopeRef(value: unknown): string {
  return cleanString(value, 'scopeRef', MAX_SCOPE_REF)
}

function validateScopeRef(scope: MemoryScope, value: unknown): string | undefined {
  if (scope === 'global') {
    if (value !== undefined && value !== null && value !== '') {
      throw new Error('Global memory cannot have a scopeRef')
    }
    return undefined
  }
  return cleanScopeRef(value)
}

export function normalizeEntry(value: unknown, existing?: MemoryEntry | null): MemoryEntry {
  if (!value || typeof value !== 'object') throw new Error('Invalid memory entry')
  const input = value as Record<string, unknown>
  if (!MEMORY_SCOPES.has(input.scope as MemoryScope)) throw new Error('Invalid memory scope')
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
  const optionalLink = (field: 'supersedesId' | 'supersededBy'): string | undefined =>
    input[field] === undefined || input[field] === null || input[field] === ''
      ? undefined
      : validateId(input[field])
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
    supersedesId: optionalLink('supersedesId'),
    supersededBy: optionalLink('supersededBy')
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

export function pathForEntry(root: string, entry: MemoryEntry): string {
  const scopeDir = join(root, entry.scope)
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
    ...([
      'validAt',
      'invalidAt',
      'expiredAt',
      'sourceRunId',
      'source',
      'supersedesId',
      'supersededBy'
    ] as const)
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

function parseMemoryFile(root: string, path: string): MemoryEntry {
  const source = readFileSync(path, 'utf8')
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/.exec(source)
  if (!match) throw new Error('Missing memory frontmatter')
  const metadata: Record<string, unknown> = Object.create(null) as Record<string, unknown>
  const allowed = new Set([
    'id', 'scope', 'scopeRef', 'kind', 'title', 'origin', 'createdAt', 'updatedAt', 'enabled',
    'validAt', 'invalidAt', 'expiredAt', 'sourceRunId', 'source', 'supersedesId', 'supersededBy'
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
  const canonicalPath = resolve(pathForEntry(root, entry))
  if (!sameResolvedPath(actualPath, canonicalPath)) {
    throw new Error('Memory frontmatter does not match its canonical scope path')
  }
  return entry
}

function entryFiles(root: string): string[] {
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
  for (const scope of MEMORY_SCOPES) walk(join(root, scope), 0)
  return files
}

function sameResolvedPath(left: string, right: string): boolean {
  const a = resolve(left)
  const b = resolve(right)
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
}

export function ensureMemoryDirectories(root: string): void {
  mkdirSync(root, { recursive: true })
  for (const scope of MEMORY_SCOPES) mkdirSync(join(root, scope), { recursive: true })
}

export function readEntryDocuments(root: string): { entries: MemoryEntry[]; invalid: number } {
  const entries: MemoryEntry[] = []
  let invalid = 0
  for (const path of entryFiles(root)) {
    try {
      entries.push(parseMemoryFile(root, path))
    } catch (error) {
      invalid += 1
      console.warn('[morz] skipped invalid memory file:', path, error)
    }
  }
  return { entries, invalid }
}

/**
 * Multi-entry UPDATEs write the archived revision and successor before removing
 * the old clean-id document. The sequence is deliberately NOT atomic — a
 * process can die between any two documents — so `step` exposes each boundary
 * for crash tests, and every write is a rename onto a fully written temp file.
 */
export function writeEntryDocuments(
  root: string,
  entries: MemoryEntry[],
  removeIds: string[] = [],
  step?: (point: MemoryWriteStep) => void
): void {
  const normalized = entries.map((entry) => normalizeEntry(entry, null))
  const ids = new Set(normalized.map((entry) => entry.id))
  if (ids.size !== normalized.length) throw new Error('Memory write contains duplicate ids')
  const targets = normalized.map((entry) => ({ entry, path: pathForEntry(root, entry) }))

  for (const { entry, path: target } of targets) {
    mkdirSync(dirname(target), { recursive: true })
    const temporary = join(dirname(target), `.${entry.id}.${randomUUID()}.tmp`)
    try {
      writeFileSync(temporary, serialize(entry), { encoding: 'utf8', flag: 'wx' })
      renameSync(temporary, target)
    } finally {
      rmSync(temporary, { force: true })
    }
    step?.({ phase: 'write', id: entry.id })
  }

  const pruneIds = new Set([...removeIds.map(validateId), ...ids])
  for (const path of entryFiles(root)) {
    const id = basename(path, '.md')
    if (!pruneIds.has(id)) continue
    const canonicalTarget = targets.find(({ entry }) => entry.id === id)?.path
    if (canonicalTarget && sameResolvedPath(path, canonicalTarget)) continue
    rmSync(path, { force: true })
    step?.({ phase: 'prune', id })
  }
}
