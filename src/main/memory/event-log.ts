import { app } from 'electron'
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
import { homedir } from 'node:os'
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
export const EVENT_LOG_MAX_BYTES = 5 * 1024 * 1024
export const EVENT_LOG_MAX_RECORD_BYTES = 64 * 1024
export const EVENT_LOG_KEEP_FILES = 2

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
  cwd?: string
}

const SESSION_KINDS = new Set<MemoryEventSessionKind>(['lane', 'dispatched', 'planner'])
const CLIS = new Set<MemoryEventCli>(['claude', 'codex', 'agy', 'opencode'])
const EVENT_TYPES = new Set<MemoryEventType>(['spawn', 'exit', 'tool', 'block', 'interrupt'])
const OUTCOMES = new Set<MemoryEventOutcome>(['ok', 'error', 'blocked', 'unknown'])
const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/~-]*$/
const SAFE_TOOL_NAME = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/
const MEMORY_EVENT_MODES = new Set<MemoryEventMode>(['manual', 'assisted', 'orchestrated'])
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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function redactText(value: string, maxLength: number): string {
  let clean = value.replace(/\u0000/g, '').replace(/\r\n/g, '\n')
  const home = homedir()
  if (home) clean = clean.replace(new RegExp(escapeRegExp(home), 'gi'), '~')
  for (const pattern of SECRET_PATTERNS) clean = clean.replace(pattern, '[redacted]')
  return clean.slice(0, maxLength)
}

function cleanIdentifier(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined
  const clean = redactText(value, maxLength)
  return SAFE_IDENTIFIER.test(clean) ? clean : '[redacted]'
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
  if (typeof input.signal === 'string') meta.signal = redactText(input.signal, 32)
  if (input.phase === 'start' || input.phase === 'result') meta.phase = input.phase
  if (input.source === 'structured' || input.source === 'pty') {
    meta.source = input.source
  } else if (input.source !== undefined) {
    meta.source = '[redacted]'
  }
  if (typeof input.model === 'string') meta.model = redactText(input.model, 128)
  if (typeof input.cwd === 'string') meta.cwd = redactText(input.cwd, 512)
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
    const current = this.pathFor(0)
    this.repairTruncatedTail(current)
    const currentBytes = existsSync(current) ? statSync(current).size : 0
    if (currentBytes > 0 && currentBytes + bytes > this.maxFileBytes) this.rotate()
    appendFileSync(current, line, { encoding: 'utf8', mode: 0o600 })
    return true
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
    for (let generation = 0; generation < this.keepFiles; generation++) {
      rmSync(this.pathFor(generation), { force: true })
    }
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
        events.push(this.toolEvent(ts, name, block.is_error === true ? 'error' : 'ok', 'result'))
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
        ...(event === 'spawn' && context.cwd ? { cwd: context.cwd } : {}),
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
