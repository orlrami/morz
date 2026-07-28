import { app } from 'electron'
import { createHash } from 'node:crypto'
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  truncateSync
} from 'node:fs'
import { join } from 'node:path'
import type {
  MemoryEventCli,
  MemoryEventLogStats,
  MemoryEventMeta,
  MemoryEventMode,
  MemoryEventOutcome,
  MemoryEventSessionKind,
  MemoryEventType,
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
 * Profile roots on all three platforms, so a path that reaches a persisted
 * field never carries the account name. Deliberately independent of
 * `homedir()`, which only matches one separator form and only this machine.
 */
const PROFILE_ROOT = /(?:[A-Za-z]:)?[\\/]{1,2}(?:Users|home)[\\/]+[^\\/\s"']+/gi

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

function containsSecret(value: string): boolean {
  return SECRET_PATTERNS.some((pattern) => {
    pattern.lastIndex = 0
    return pattern.test(value)
  })
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
  clean = canonicalize(clean).replace(PROFILE_ROOT, '~')
  for (const pattern of SECRET_PATTERNS) clean = clean.replace(pattern, '[redacted]')
  return redactEncodedSecrets(clean).slice(0, maxLength)
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
 * Serializing writers. Every log operation is synchronous, so within one
 * process the only way to re-enter is nesting (append -> rotate); `heldLocks`
 * covers that and keeps a second store instance from taking the lockfile it
 * already owns. The lockfile is what stops a second Morz instance from
 * rotating, repairing or truncating the same file concurrently.
 */
const heldLocks = new Set<string>()
const sleepSignal = new Int32Array(new SharedArrayBuffer(4))

function sleepSync(ms: number): void {
  Atomics.wait(sleepSignal, 0, 0, ms)
}

function lockIsStale(path: string): boolean {
  try {
    return Date.now() - statSync(path).mtimeMs > EVENT_LOG_LOCK_STALE_MS
  } catch {
    return false // It vanished; the next create attempt wins it honestly.
  }
}

/** Runs `fn` as the only writer for `directory`, or returns `fallback` if the wait expires. */
function withDirectoryLock<T>(directory: string, fallback: T, fn: () => T): T {
  if (heldLocks.has(directory)) return fn()
  const path = join(directory, EVENT_LOG_LOCK_FILE)
  const deadline = Date.now() + EVENT_LOG_LOCK_WAIT_MS
  for (;;) {
    try {
      closeSync(openSync(path, 'wx'))
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      if (lockIsStale(path)) {
        rmSync(path, { force: true })
        continue
      }
      if (Date.now() >= deadline) return fallback
      sleepSync(25)
    }
  }
  heldLocks.add(directory)
  try {
    return fn()
  } finally {
    heldLocks.delete(directory)
    rmSync(path, { force: true })
  }
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

export class MemoryEventLog {
  private readonly maxFileBytes: number
  private readonly maxRecordBytes: number
  private readonly keepFiles: number
  private readonly getMode: () => MemoryEventMode

  constructor(private readonly options: MemoryEventLogOptions) {
    this.maxFileBytes = Math.max(1, Math.floor(options.maxFileBytes ?? EVENT_LOG_MAX_BYTES))
    this.maxRecordBytes = Math.max(1, Math.floor(options.maxRecordBytes ?? EVENT_LOG_MAX_RECORD_BYTES))
    this.keepFiles = Math.max(1, Math.floor(options.keepFiles ?? EVENT_LOG_KEEP_FILES))
    this.getMode = options.getMode ?? (() => 'manual')
  }

  append(value: MemoryInvocationEvent): boolean {
    if (!writeAllowed(this.getMode)) return false
    const normalized = normalizeEvent(value)
    if (!normalized) return false
    const line = `${JSON.stringify(normalized)}\n`
    const bytes = Buffer.byteLength(line, 'utf8')
    if (bytes > this.maxRecordBytes || bytes > this.maxFileBytes) return false

    mkdirSync(this.options.directory, { recursive: true })
    return withDirectoryLock(this.options.directory, false, () => {
      const current = this.pathFor(0)
      this.repairTruncatedTail(current)
      const currentBytes = existsSync(current) ? statSync(current).size : 0
      if (currentBytes > 0 && currentBytes + bytes > this.maxFileBytes) this.rotate()
      appendFileSync(current, line, { encoding: 'utf8', mode: 0o600 })
      return true
    })
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
    return { count: this.readEvents().length, bytes }
  }

  clear(): void {
    if (!existsSync(this.options.directory)) return
    withDirectoryLock(this.options.directory, undefined, () => {
      for (let generation = 0; generation < this.keepFiles; generation++) {
        rmSync(this.pathFor(generation), { force: true })
      }
    })
  }

  private rotate(): void {
    if (this.keepFiles === 1) {
      rmSync(this.pathFor(0), { force: true })
      return
    }
    rmSync(this.pathFor(this.keepFiles - 1), { force: true })
    for (let generation = this.keepFiles - 2; generation >= 0; generation--) {
      const source = this.pathFor(generation)
      if (existsSync(source)) renameSync(source, this.pathFor(generation + 1))
    }
  }

  private repairTruncatedTail(path: string): void {
    if (!existsSync(path)) return
    const size = statSync(path).size
    if (size === 0) return

    const fd = openSync(path, 'r')
    let truncateAt: number | undefined
    try {
      const finalByte = Buffer.allocUnsafe(1)
      readSync(fd, finalByte, 0, 1, size - 1)
      if (finalByte[0] === 0x0a) return

      const chunkBytes = 64 * 1024
      for (let cursor = size; cursor > 0;) {
        const start = Math.max(0, cursor - chunkBytes)
        const chunk = Buffer.allocUnsafe(cursor - start)
        readSync(fd, chunk, 0, chunk.length, start)
        const newline = chunk.lastIndexOf(0x0a)
        if (newline >= 0) {
          truncateAt = start + newline + 1
          break
        }
        cursor = start
      }
      truncateAt ??= 0
    } finally {
      closeSync(fd)
    }
    truncateSync(path, truncateAt)
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

/** Fire-and-forget call sites use this fail-closed wrapper; events never break a run. */
export function logMemoryEvent(
  value: MemoryInvocationEvent
): boolean {
  try {
    return defaultLog().append(value)
  } catch (error) {
    const message = error instanceof Error ? redactText(error.message, 200) : 'unknown error'
    console.warn(`[morz] memory event log write failed: ${message}`)
    return false
  }
}

export function readEvents(filter: MemoryEventFilter = {}): MemoryInvocationEvent[] {
  return defaultLog().readEvents(filter)
}

export function eventLogStats(): MemoryEventLogStats {
  return defaultLog().stats()
}

export function clearEventLog(): void {
  defaultLog().clear()
}

export function logDispatchedSpawn(
  paneId: string,
  context: DispatchedInvocationContext
): void {
  logMemoryEvent(dispatchedTracker.spawn(paneId, context))
}

export function logDispatchedExit(paneId: string, exitCode: number | null): void {
  const event = dispatchedTracker.exit(paneId, exitCode)
  if (event) logMemoryEvent(event)
}

export function logDispatchedInterrupt(paneId: string): void {
  const event = dispatchedTracker.interrupt(paneId)
  if (event) logMemoryEvent(event)
}
