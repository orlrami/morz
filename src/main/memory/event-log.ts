import { app } from 'electron'
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { appendFile, mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import type {
  MemoryEventCli,
  MemoryEventLogStats,
  MemoryEventMeta,
  MemoryEventMode,
  MemoryEventOutcome,
  MemoryEventSessionKind,
  MemoryEventType,
  MemoryEventWriteStatus,
  MemoryInvocationEvent
} from '../../shared/memory'

export const EVENT_LOG_FILE = 'memory-events.jsonl'
/** Hidden so directory scans keyed on `memory-events` never treat it as a generation. */
export const EVENT_LOG_LOCK_FILE = '.memory-events.lock'
export const EVENT_LOG_MAX_BYTES = 5 * 1024 * 1024
export const EVENT_LOG_MAX_RECORD_BYTES = 64 * 1024
export const EVENT_LOG_KEEP_FILES = 2
/** A lock older than this belonged to a process that died mid-rotation. */
export const EVENT_LOG_LOCK_STALE_MS = 30_000
/** Total time an append waits for another instance before giving up (fail-closed). */
export const EVENT_LOG_LOCK_WAIT_MS = 1_000

export type {
  MemoryEventCli,
  MemoryEventLogStats,
  MemoryEventMeta,
  MemoryEventMode,
  MemoryEventOutcome,
  MemoryEventSessionKind,
  MemoryEventType,
  MemoryEventWriteStatus,
  MemoryInvocationEvent
} from '../../shared/memory'

export interface MemoryEventFilter {
  since?: number
  cli?: MemoryEventCli
}

export interface MemoryEventLogOptions {
  directory: string
  maxFileBytes?: number
  maxRecordBytes?: number
  keepFiles?: number
  getMode?: () => MemoryEventMode
}

export interface ClaudeInvocationContext {
  sessionKind: Extract<MemoryEventSessionKind, 'lane' | 'dispatched'>
  agentId?: string
  spaceId?: string
}

export interface DispatchedInvocationContext {
  cli: MemoryEventCli
  agentId?: string
  spaceId?: string
}

const SESSION_KINDS = new Set<MemoryEventSessionKind>(['lane', 'dispatched', 'planner'])
const CLIS = new Set<MemoryEventCli>(['claude', 'codex', 'agy', 'opencode'])
const EVENT_TYPES = new Set<MemoryEventType>(['spawn', 'exit', 'tool', 'block', 'interrupt'])
const OUTCOMES = new Set<MemoryEventOutcome>(['ok', 'error', 'blocked', 'unknown'])
/** No path separators or drive colons, so an identifier can never carry a filesystem path. */
const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const SAFE_TOOL_NAME = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/
/** Model ids are vendor slugs; anything else is opaque data and gets dropped. */
const SAFE_MODEL = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/
const MEMORY_EVENT_MODES = new Set<MemoryEventMode>(['manual', 'assisted', 'orchestrated'])
const SIGNALS = new Set([
  'SIGABRT', 'SIGALRM', 'SIGBREAK', 'SIGBUS', 'SIGCHLD', 'SIGCONT', 'SIGFPE',
  'SIGHUP', 'SIGILL', 'SIGINT', 'SIGKILL', 'SIGPIPE', 'SIGQUIT', 'SIGSEGV',
  'SIGSTOP', 'SIGTERM', 'SIGTRAP', 'SIGTSTP', 'SIGTTIN', 'SIGTTOU', 'SIGUSR1',
  'SIGUSR2', 'SIGWINCH'
])
const MAX_PENDING_TOOL_IDS = 256
const MAX_TOOL_ID_LENGTH = 256

const SECRET_PATTERNS: RegExp[] = [
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{16,}\b/gi,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\b[A-Z][A-Z0-9_]{1,63}\s*=\s*["']?[A-Za-z0-9+/=_-]{20,}["']?/g,
  /\bignore\s+(?:all\s+|any\s+|the\s+)?(?:previous|prior|above)\s+instructions?\b/gi,
  /\b(?:reveal|print|return|exfiltrate)\s+(?:the\s+)?system\s+prompt\b/gi,
  /<\s*\/?\s*(?:system|developer|assistant)\b[^>]*>/gi
]

/**
 * Profile roots on all three platforms, so a path in a free-form message never
 * carries the account name. Deliberately independent of `homedir()`, which only
 * matches one separator form and only this machine.
 *
 * Anchored to an actual absolute-path boundary: the root has to start the
 * string or follow a delimiter, so `mcp/Users/list` and a URL path like
 * `https://example.com/home/alice` are left alone.
 */
const PROFILE_ROOT = /(^|[\s"'`(<[,;=])(?:[A-Za-z]:)?[\\/]{1,2}(?:Users|home)[\\/]+[^\\/\s"'`)\]>]+/gi

/*
 * Canonicalization must run before any pattern: NFKC folds compatibility
 * lookalikes, and default-ignorable/format characters are deleted so a key
 * written as `sk-proj-<ZWSP>ABC...` cannot walk past a word-boundary pattern
 * and still be recoverable by deleting the invisible character.
 *
 * Ranges are built at runtime rather than written as escapes in a character
 * class, so this source file stays free of invisible characters.
 */
const IGNORABLE_RANGES: Array<[number, number]> = [
  [0x0000, 0x0008], [0x000b, 0x000c], [0x000e, 0x001f], [0x007f, 0x009f],
  [0x00ad, 0x00ad], [0x034f, 0x034f], [0x061c, 0x061c], [0x115f, 0x1160],
  [0x17b4, 0x17b5], [0x180b, 0x180f], [0x200b, 0x200f], [0x202a, 0x202e],
  [0x2060, 0x206f], [0x3164, 0x3164], [0xfe00, 0xfe0f], [0xfeff, 0xfeff],
  [0xffa0, 0xffa0], [0xfff0, 0xfff8], [0xe0000, 0xe0fff]
]

function characterClass(ranges: Array<[number, number]>, flags: string): RegExp {
  const body = ranges
    .map(([from, to]) => `\\u{${from.toString(16)}}-\\u{${to.toString(16)}}`)
    .join('')
  return new RegExp(`[${body}]`, flags)
}

const DEFAULT_IGNORABLE = characterClass(IGNORABLE_RANGES, 'gu')
const BINARY_BYTES = characterClass([[0x0000, 0x0008], [0x000e, 0x001f], [0xfffd, 0xfffd]], 'u')
/** Bounded so an ordinary long token never turns into an expensive decode. */
const BASE64_CANDIDATE = /[A-Za-z0-9+/=_-]{24,512}/g

function canonicalize(value: string): string {
  return value.normalize('NFKC').replace(DEFAULT_IGNORABLE, '')
}

function matchesSecret(value: string): boolean {
  return SECRET_PATTERNS.some((pattern) => {
    pattern.lastIndex = 0
    return pattern.test(value)
  })
}

/**
 * Also scans a whitespace-compacted view. Canonicalization removes invisible
 * separators but keeps ordinary spaces and newlines, so a key wrapped as
 * `sk-proj-\n1234...` would otherwise read as two harmless fragments.
 */
function containsSecret(value: string): boolean {
  return matchesSecret(value) || matchesSecret(value.replace(/\s+/g, ''))
}

/** Decodes a base64/base64url run to text, or undefined when it is not text. */
function decodeCandidate(candidate: string): string | undefined {
  const body = candidate.replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '')
  if (body.length < 24 || body.length % 4 === 1) return undefined
  const decoded = Buffer.from(body, 'base64').toString('utf8')
  if (decoded.length === 0 || BINARY_BYTES.test(decoded)) return undefined
  return canonicalize(decoded)
}

/**
 * Catches secrets that survived plaintext scanning by being base64-wrapped.
 * One decode level only; deeper nesting is not claimed to be covered.
 */
function redactEncodedSecrets(value: string): string {
  return value.replace(BASE64_CANDIDATE, (candidate) => {
    const decoded = decodeCandidate(candidate)
    return decoded !== undefined && containsSecret(decoded) ? '[redacted]' : candidate
  })
}

/** Keeps attribution without the payload: unsafe shapes become a stable digest. */
function hashIdentifier(value: string): string {
  return `h-${createHash('sha256').update(value).digest('hex').slice(0, 16)}`
}

/**
 * Every persisted string goes through here.
 *
 * Known limitation: scanning is per record, so a secret deliberately split
 * across two records cannot be detected. That is why the record shape carries
 * no free-form text — `meta` is enum/shape validated and `cwd` is never
 * persisted, so there is no field an attacker can stream a secret through.
 *
 * Exported so the adversarial corpus can assert on redaction itself rather
 * than on the field validators that sit in front of it.
 */
export function redactText(value: string, maxLength: number): string {
  let clean = value.replace(/\u0000/g, '').replace(/\r\n/g, '\n')
  clean = canonicalize(clean)
  for (const pattern of SECRET_PATTERNS) clean = clean.replace(pattern, '[redacted]')
  return redactEncodedSecrets(clean).slice(0, maxLength)
}

/**
 * For free-form text such as an error message, the only place a real filesystem
 * path still travels. Enum- and shape-checked fields deliberately skip the
 * profile rewrite: a tool name like `mcp/Users/list` is not a path, and
 * rewriting it would turn a legitimate name into `[redacted]`.
 */
export function redactMessage(value: string, maxLength: number): string {
  return redactText(value, maxLength).replace(PROFILE_ROOT, '$1~')
}

function cleanIdentifier(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined
  const clean = redactText(value, maxLength)
  return SAFE_IDENTIFIER.test(clean) ? clean : hashIdentifier(clean)
}

function cleanToolName(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined
  const clean = redactText(value, 128)
  return SAFE_TOOL_NAME.test(clean) ? clean : '[redacted]'
}

function finiteNonNegative(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : undefined
}

function normalizeMeta(value: unknown): MemoryEventMeta | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const input = value as Record<string, unknown>
  const meta: MemoryEventMeta = {}
  if (typeof input.exitCode === 'number' && Number.isInteger(input.exitCode)) {
    meta.exitCode = input.exitCode
  }
  if (typeof input.signal === 'string' && SIGNALS.has(input.signal)) meta.signal = input.signal
  if (input.phase === 'start' || input.phase === 'result') meta.phase = input.phase
  if (input.source === 'structured' || input.source === 'pty') {
    meta.source = input.source
  } else if (input.source !== undefined) {
    meta.source = '[redacted]'
  }
  if (typeof input.model === 'string') {
    const model = redactText(input.model, 64)
    if (SAFE_MODEL.test(model)) meta.model = model
  }
  // `cwd` is never persisted: it leaks profile names, and agentId/spaceId already attribute.
  return Object.keys(meta).length > 0 ? meta : undefined
}

function normalizeEvent(value: unknown): MemoryInvocationEvent | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const input = value as Record<string, unknown>
  if (input.v !== 1) return null
  if (typeof input.ts !== 'number' || !Number.isFinite(input.ts) || input.ts < 0) return null
  if (!SESSION_KINDS.has(input.sessionKind as MemoryEventSessionKind)) return null
  if (!CLIS.has(input.cli as MemoryEventCli)) return null
  if (!EVENT_TYPES.has(input.event as MemoryEventType)) return null
  if (input.outcome !== undefined && !OUTCOMES.has(input.outcome as MemoryEventOutcome)) return null

  const normalized: MemoryInvocationEvent = {
    v: 1,
    ts: Math.floor(input.ts),
    sessionKind: input.sessionKind as MemoryEventSessionKind,
    cli: input.cli as MemoryEventCli,
    event: input.event as MemoryEventType
  }
  const agentId = cleanIdentifier(input.agentId, 160)
  const spaceId = cleanIdentifier(input.spaceId, 256)
  const name = cleanToolName(input.name)
  const durationMs = finiteNonNegative(input.durationMs)
  const meta = normalizeMeta(input.meta)
  if (agentId) normalized.agentId = agentId
  if (spaceId) normalized.spaceId = spaceId
  if (name) normalized.name = name
  if (input.outcome !== undefined) normalized.outcome = input.outcome as MemoryEventOutcome
  if (durationMs !== undefined) normalized.durationMs = durationMs
  if (meta) normalized.meta = meta
  return normalized
}

/*
 * Serializing writers, in two layers.
 *
 * In-process: one promise chain per directory. Now that writes are async they
 * really can interleave, and two stores sharing a directory must not burn each
 * other's lock wait.
 *
 * Cross-process: an ownership-stamped lockfile. Nothing is ever unlinked at the
 * shared path, because the file sitting there when we looked may not be the file
 * sitting there when we act. Both takeover and release instead rename to a
 * private tombstone first — rename is the one atomic primitive available, so
 * whatever we move is exactly what we then inspect — and only delete it once the
 * token inside matches the identity the decision was made about. A mismatch
 * means we moved someone else's lock, so we put it back.
 */
const directoryQueues = new Map<string, Promise<unknown>>()

function enqueue<T>(directory: string, fn: () => Promise<T>): Promise<T> {
  const previous = directoryQueues.get(directory) ?? Promise.resolve()
  const next = previous.then(fn, fn)
  directoryQueues.set(directory, next.catch(() => undefined))
  return next
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code
}

async function readToken(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return undefined
  }
}

/** The token of an abandoned lock, or undefined when the lock is live or gone. */
async function abandonedToken(path: string): Promise<string | undefined> {
  try {
    const info = await stat(path)
    if (Date.now() - info.mtimeMs <= EVENT_LOG_LOCK_STALE_MS) return undefined
    return await readToken(path)
  } catch {
    return undefined // It vanished; the next create attempt wins it honestly.
  }
}

/**
 * Moves a lock aside and deletes it only if it is still the one identified by
 * `expected`. Rename of a missing source fails, so of any number of contenders
 * exactly one moves the file; validating the moved copy is what stops a lock
 * that was released and replaced in the meantime from being stolen.
 */
async function discardIfOwned(path: string, tombstone: string, expected: string): Promise<void> {
  try {
    await rename(path, tombstone)
  } catch {
    return // Someone else moved it first; fall back to a plain create.
  }
  if ((await readToken(tombstone)) === expected) {
    await rm(tombstone, { force: true })
    return
  }
  // Not the lock we judged: put it back rather than destroy a live holder's.
  try {
    await rename(tombstone, path)
  } catch {
    // A third lock already holds the path, so restoring would clobber it.
    await rm(tombstone, { force: true })
  }
}

async function acquire(path: string, token: string): Promise<boolean> {
  const deadline = Date.now() + EVENT_LOG_LOCK_WAIT_MS
  for (;;) {
    try {
      const handle = await open(path, 'wx')
      try {
        await handle.writeFile(token, 'utf8')
      } finally {
        await handle.close()
      }
      // Read back: only a lock still carrying our token is ours to release.
      return (await readFile(path, 'utf8')) === token
    } catch (error) {
      if (errorCode(error) !== 'EEXIST') throw error
      const abandoned = await abandonedToken(path)
      if (abandoned !== undefined) {
        await discardIfOwned(path, `${path}.stale-${token}`, abandoned)
        // Bounded even if a skewed clock makes every lock look abandoned.
        if (Date.now() >= deadline) return false
        continue
      }
      if (Date.now() >= deadline) return false
      await delay(25)
    }
  }
}

async function release(path: string, token: string): Promise<void> {
  await discardIfOwned(path, `${path}.done-${token}`, token)
}

/**
 * Runs `fn` as the only writer for `directory`, or returns `fallback` if the
 * wait expires. Creating the directory happens inside the queued operation, so
 * a clear can never overtake a first append that is still creating it.
 *
 * Exported for the lock regressions, which need to act from inside a held
 * critical section.
 */
export function withDirectoryLock<T>(
  directory: string,
  fallback: T,
  fn: () => Promise<T>
): Promise<T> {
  return enqueue(directory, async () => {
    await mkdir(directory, { recursive: true })
    const path = join(directory, EVENT_LOG_LOCK_FILE)
    const token = `${process.pid}-${randomBytes(8).toString('hex')}`
    if (!(await acquire(path, token))) return fallback
    try {
      return await fn()
    } finally {
      await release(path, token)
    }
  })
}

function writeAllowed(getMode: () => MemoryEventMode): boolean {
  let mode: MemoryEventMode
  try {
    mode = getMode()
  } catch {
    return false
  }
  if (mode === 'manual') return false
  return process.env.MORZ_E2E !== '1' || process.env.MORZ_E2E_MEMORY_EVENT_LOG === '1'
}

async function fileBytes(path: string): Promise<number> {
  try {
    return (await stat(path)).size
  } catch {
    return 0
  }
}

export class MemoryEventLog {
  private readonly maxFileBytes: number
  private readonly maxRecordBytes: number
  private readonly keepFiles: number
  private readonly getMode: () => MemoryEventMode
  private droppedEvents = 0

  constructor(private readonly options: MemoryEventLogOptions) {
    this.maxFileBytes = Math.max(1, Math.floor(options.maxFileBytes ?? EVENT_LOG_MAX_BYTES))
    this.maxRecordBytes = Math.max(1, Math.floor(options.maxRecordBytes ?? EVENT_LOG_MAX_RECORD_BYTES))
    this.keepFiles = Math.max(1, Math.floor(options.keepFiles ?? EVENT_LOG_KEEP_FILES))
    this.getMode = options.getMode ?? (() => 'manual')
  }

  /**
   * Async on purpose: the lock wait used to park the Electron main thread, and
   * every caller already fires and forgets, so awaiting costs them nothing.
   */
  async append(value: MemoryInvocationEvent): Promise<MemoryEventWriteStatus> {
    if (!writeAllowed(this.getMode)) return 'skipped-mode'
    const normalized = normalizeEvent(value)
    if (!normalized) return this.drop('dropped-invalid')
    const line = `${JSON.stringify(normalized)}\n`
    const bytes = Buffer.byteLength(line, 'utf8')
    if (bytes > this.maxRecordBytes || bytes > this.maxFileBytes) return this.drop('dropped-oversized')

    // A filesystem failure anywhere in the write path is a lost event like any
    // other, so it is counted and reported rather than thrown at a caller that
    // deliberately ignores the result.
    const status = await withDirectoryLock<MemoryEventWriteStatus>(
      this.options.directory,
      'dropped-lock',
      async () => {
        const current = this.pathFor(0)
        await this.repairTruncatedTail(current)
        const currentBytes = await fileBytes(current)
        if (currentBytes > 0 && currentBytes + bytes > this.maxFileBytes) await this.rotate()
        await appendFile(current, line, { encoding: 'utf8', mode: 0o600 })
        return 'ok'
      }
    ).catch(() => 'dropped-io' as const)
    return status === 'ok' ? status : this.drop(status)
  }

  /** Drops are counted, never silent — Settings surfaces the total. */
  private drop(status: MemoryEventWriteStatus): MemoryEventWriteStatus {
    this.droppedEvents += 1
    return status
  }

  readEvents(filter: MemoryEventFilter = {}): MemoryInvocationEvent[] {
    const events: MemoryInvocationEvent[] = []
    for (let generation = this.keepFiles - 1; generation >= 0; generation--) {
      const path = this.pathFor(generation)
      if (!existsSync(path)) continue
      const raw = readFileSync(path, 'utf8')
      for (const line of raw.split('\n')) {
        if (!line) continue
        try {
          const parsed = normalizeEvent(JSON.parse(line) as unknown)
          if (!parsed) continue
          if (filter.since !== undefined && parsed.ts < filter.since) continue
          if (filter.cli !== undefined && parsed.cli !== filter.cli) continue
          events.push(parsed)
        } catch {
          // A crash may leave the final append truncated. Keep every valid line.
        }
      }
    }
    return events
  }

  stats(): MemoryEventLogStats {
    let bytes = 0
    for (let generation = 0; generation < this.keepFiles; generation++) {
      const path = this.pathFor(generation)
      if (existsSync(path)) bytes += statSync(path).size
    }
    return { count: this.readEvents().length, bytes, dropped: this.droppedEvents }
  }

  /**
   * Always queued, even when the directory does not exist yet: an append that
   * is still creating it must not be overtaken by a clear that reports success.
   * Rejects rather than pretending, when another writer holds the lock.
   */
  async clear(): Promise<void> {
    const cleared = await withDirectoryLock(this.options.directory, false, async () => {
      for (let generation = 0; generation < this.keepFiles; generation++) {
        await rm(this.pathFor(generation), { force: true })
      }
      return true
    })
    if (!cleared) throw new Error('Event log is busy: clear timed out waiting for the writer lock')
    this.droppedEvents = 0
  }

  private async rotate(): Promise<void> {
    if (this.keepFiles === 1) {
      await rm(this.pathFor(0), { force: true })
      return
    }
    await rm(this.pathFor(this.keepFiles - 1), { force: true })
    for (let generation = this.keepFiles - 2; generation >= 0; generation--) {
      try {
        await rename(this.pathFor(generation), this.pathFor(generation + 1))
      } catch (error) {
        if (errorCode(error) !== 'ENOENT') throw error
      }
    }
  }

  private async repairTruncatedTail(path: string): Promise<void> {
    const size = await fileBytes(path)
    if (size === 0) return

    const handle = await open(path, 'r+')
    try {
      const finalByte = Buffer.allocUnsafe(1)
      await handle.read(finalByte, 0, 1, size - 1)
      if (finalByte[0] === 0x0a) return

      let truncateAt: number | undefined
      const chunkBytes = 64 * 1024
      for (let cursor = size; cursor > 0;) {
        const start = Math.max(0, cursor - chunkBytes)
        const chunk = Buffer.allocUnsafe(cursor - start)
        await handle.read(chunk, 0, chunk.length, start)
        const newline = chunk.lastIndexOf(0x0a)
        if (newline >= 0) {
          truncateAt = start + newline + 1
          break
        }
        cursor = start
      }
      await handle.truncate(truncateAt ?? 0)
    } finally {
      await handle.close()
    }
  }

  private pathFor(generation: number): string {
    return join(
      this.options.directory,
      generation === 0 ? EVENT_LOG_FILE : `memory-events.${generation}.jsonl`
    )
  }
}

/**
 * Correlates Claude's structured tool_use/tool_result blocks without retaining
 * tool inputs or result bodies. PTY text is intentionally never inspected.
 */
export class ClaudeInvocationTracker {
  private readonly toolNames = new Map<string, string>()

  constructor(private readonly context: ClaudeInvocationContext) {}

  observe(value: unknown, ts = Date.now()): MemoryInvocationEvent[] {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return []
    const input = value as Record<string, unknown>
    if (input.type !== 'assistant' && input.type !== 'user') return []
    const message = input.message
    if (!message || typeof message !== 'object' || Array.isArray(message)) return []
    const content = (message as Record<string, unknown>).content
    if (!Array.isArray(content)) return []

    const events: MemoryInvocationEvent[] = []
    for (const item of content) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) continue
      const block = item as Record<string, unknown>
      if (input.type === 'assistant' && block.type === 'tool_use') {
        const id =
          typeof block.id === 'string' && block.id.length <= MAX_TOOL_ID_LENGTH
            ? block.id
            : undefined
        const name = cleanToolName(block.name)
        if (id && name) {
          this.toolNames.set(id, name)
          while (this.toolNames.size > MAX_PENDING_TOOL_IDS) {
            const oldest = this.toolNames.keys().next().value
            if (typeof oldest !== 'string') break
            this.toolNames.delete(oldest)
          }
        }
        events.push(this.toolEvent(ts, name, 'unknown', 'start'))
      } else if (input.type === 'user' && block.type === 'tool_result') {
        const id =
          typeof block.tool_use_id === 'string' && block.tool_use_id.length <= MAX_TOOL_ID_LENGTH
            ? block.tool_use_id
            : undefined
        const name = id ? this.toolNames.get(id) : undefined
        if (id) this.toolNames.delete(id)
        // Only an explicit boolean is a claim about the result; absent or
        // malformed status stays 'unknown' rather than being called success.
        const outcome: MemoryEventOutcome =
          block.is_error === true ? 'error' : block.is_error === false ? 'ok' : 'unknown'
        events.push(this.toolEvent(ts, name, outcome, 'result'))
      }
    }
    return events
  }

  private toolEvent(
    ts: number,
    name: string | undefined,
    outcome: MemoryEventOutcome,
    phase: 'start' | 'result'
  ): MemoryInvocationEvent {
    return {
      v: 1,
      ts,
      sessionKind: this.context.sessionKind,
      cli: 'claude',
      ...(this.context.agentId ? { agentId: this.context.agentId } : {}),
      ...(this.context.spaceId ? { spaceId: this.context.spaceId } : {}),
      event: 'tool',
      ...(name ? { name } : {}),
      outcome,
      meta: { phase, source: 'structured' }
    }
  }
}

export class DispatchedInvocationTracker {
  private readonly sessions = new Map<
    string,
    DispatchedInvocationContext & { startedAt: number }
  >()

  spawn(
    paneId: string,
    context: DispatchedInvocationContext,
    ts = Date.now()
  ): MemoryInvocationEvent {
    this.sessions.set(paneId, { ...context, startedAt: ts })
    return this.lifecycleEvent('spawn', context, ts, undefined)
  }

  exit(paneId: string, exitCode: number | null, ts = Date.now()): MemoryInvocationEvent | null {
    const session = this.sessions.get(paneId)
    if (!session) return null
    this.sessions.delete(paneId)
    return this.lifecycleEvent('exit', session, ts, ts - session.startedAt, exitCode)
  }

  interrupt(paneId: string, ts = Date.now()): MemoryInvocationEvent | null {
    const session = this.sessions.get(paneId)
    if (!session) return null
    return {
      ...this.lifecycleEvent('interrupt', session, ts, ts - session.startedAt),
      outcome: 'unknown'
    }
  }

  private lifecycleEvent(
    event: Extract<MemoryEventType, 'spawn' | 'exit' | 'interrupt'>,
    context: DispatchedInvocationContext,
    ts: number,
    durationMs: number | undefined,
    exitCode?: number | null
  ): MemoryInvocationEvent {
    return {
      v: 1,
      ts,
      sessionKind: 'dispatched',
      cli: context.cli,
      ...(context.agentId ? { agentId: context.agentId } : {}),
      ...(context.spaceId ? { spaceId: context.spaceId } : {}),
      event,
      outcome: 'unknown',
      ...(durationMs === undefined ? {} : { durationMs }),
      meta: {
        source: 'pty',
        ...(exitCode === undefined || exitCode === null ? {} : { exitCode })
      }
    }
  }
}

let activeLog: MemoryEventLog | null = null
let activeMode: MemoryEventMode = 'manual'
const dispatchedTracker = new DispatchedInvocationTracker()

export function setMemoryEventMode(value: unknown): MemoryEventMode {
  if (!MEMORY_EVENT_MODES.has(value as MemoryEventMode)) {
    activeMode = 'manual'
    throw new Error('Invalid memory event mode')
  }
  activeMode = value as MemoryEventMode
  return activeMode
}

function defaultLog(): MemoryEventLog {
  if (!activeLog) {
    activeLog = new MemoryEventLog({
      directory: join(app.getPath('appData'), 'Morz'),
      getMode: () => activeMode
    })
  }
  return activeLog
}

/** One line per window, so a jammed lock cannot flood the console. */
const DROP_WARNING_INTERVAL_MS = 60_000
let lastDropWarningAt = 0
let dropsSinceWarning = 0

function warnAboutDrop(status: MemoryEventWriteStatus): void {
  dropsSinceWarning += 1
  const now = Date.now()
  if (now - lastDropWarningAt < DROP_WARNING_INTERVAL_MS) return
  lastDropWarningAt = now
  console.warn(
    `[morz] memory event log dropped ${dropsSinceWarning} event(s); most recent: ${status}`
  )
  dropsSinceWarning = 0
}

/** Fire-and-forget call sites use this fail-closed wrapper; events never break a run. */
export async function logMemoryEvent(
  value: MemoryInvocationEvent
): Promise<MemoryEventWriteStatus> {
  let status: MemoryEventWriteStatus
  try {
    status = await defaultLog().append(value)
  } catch (error) {
    // append() counts its own filesystem failures; this covers the rest
    // (a log that cannot even be constructed), which are drops all the same.
    const message = error instanceof Error ? redactMessage(error.message, 200) : 'unknown error'
    console.warn(`[morz] memory event log write failed: ${message}`)
    warnAboutDrop('dropped-io')
    return 'dropped-io'
  }
  if (status !== 'ok' && status !== 'skipped-mode') warnAboutDrop(status)
  return status
}

export function readEvents(filter: MemoryEventFilter = {}): MemoryInvocationEvent[] {
  return defaultLog().readEvents(filter)
}

export function eventLogStats(): MemoryEventLogStats {
  return defaultLog().stats()
}

export function clearEventLog(): Promise<void> {
  return defaultLog().clear()
}

export function logDispatchedSpawn(
  paneId: string,
  context: DispatchedInvocationContext
): void {
  void logMemoryEvent(dispatchedTracker.spawn(paneId, context))
}

export function logDispatchedExit(paneId: string, exitCode: number | null): void {
  const event = dispatchedTracker.exit(paneId, exitCode)
  if (event) void logMemoryEvent(event)
}

export function logDispatchedInterrupt(paneId: string): void {
  const event = dispatchedTracker.interrupt(paneId)
  if (event) void logMemoryEvent(event)
}
