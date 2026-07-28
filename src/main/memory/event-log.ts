import { app } from 'electron'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync
} from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const EVENT_LOG_FILE = 'memory-events.jsonl'
export const EVENT_LOG_MAX_BYTES = 5 * 1024 * 1024
export const EVENT_LOG_MAX_RECORD_BYTES = 64 * 1024
export const EVENT_LOG_KEEP_FILES = 2

export type MemoryEventSessionKind = 'lane' | 'dispatched' | 'planner'
export type MemoryEventCli = 'claude' | 'codex' | 'agy' | 'opencode'
export type MemoryEventType = 'spawn' | 'exit' | 'tool' | 'block' | 'interrupt'
export type MemoryEventOutcome = 'ok' | 'error' | 'blocked' | 'unknown'
export type MemoryEventMode = 'manual' | 'assisted' | 'orchestrated'

/** Deliberately small: raw args, environment, prompts and file contents have no slot. */
export interface MemoryEventMeta {
  exitCode?: number
  signal?: string
  phase?: 'start' | 'result'
  source?: 'structured' | 'pty' | '[redacted]'
  model?: string
  cwd?: string
}

export interface MemoryInvocationEvent {
  v: 1
  ts: number
  sessionKind: MemoryEventSessionKind
  cli: MemoryEventCli
  agentId?: string
  spaceId?: string
  event: MemoryEventType
  name?: string
  outcome?: MemoryEventOutcome
  durationMs?: number
  meta?: MemoryEventMeta
}

export interface MemoryEventFilter {
  since?: number
  cli?: MemoryEventCli
}

export interface MemoryEventLogStats {
  count: number
  bytes: number
}

export interface MemoryEventWriteContext {
  mode?: MemoryEventMode
}

export interface MemoryEventLogOptions {
  directory: string
  maxFileBytes?: number
  maxRecordBytes?: number
  keepFiles?: number
}

const SESSION_KINDS = new Set<MemoryEventSessionKind>(['lane', 'dispatched', 'planner'])
const CLIS = new Set<MemoryEventCli>(['claude', 'codex', 'agy', 'opencode'])
const EVENT_TYPES = new Set<MemoryEventType>(['spawn', 'exit', 'tool', 'block', 'interrupt'])
const OUTCOMES = new Set<MemoryEventOutcome>(['ok', 'error', 'blocked', 'unknown'])
const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/~-]*$/
const SAFE_TOOL_NAME = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/

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

function writeAllowed(context: MemoryEventWriteContext): boolean {
  if (context.mode === 'manual') return false
  return process.env.MORZ_E2E !== '1' || process.env.MORZ_E2E_MEMORY_EVENT_LOG === '1'
}

export class MemoryEventLog {
  private readonly maxFileBytes: number
  private readonly maxRecordBytes: number
  private readonly keepFiles: number

  constructor(private readonly options: MemoryEventLogOptions) {
    this.maxFileBytes = Math.max(1, Math.floor(options.maxFileBytes ?? EVENT_LOG_MAX_BYTES))
    this.maxRecordBytes = Math.max(1, Math.floor(options.maxRecordBytes ?? EVENT_LOG_MAX_RECORD_BYTES))
    this.keepFiles = Math.max(1, Math.floor(options.keepFiles ?? EVENT_LOG_KEEP_FILES))
  }

  append(value: MemoryInvocationEvent, context: MemoryEventWriteContext = {}): boolean {
    if (!writeAllowed(context)) return false
    const normalized = normalizeEvent(value)
    if (!normalized) return false
    const line = `${JSON.stringify(normalized)}\n`
    const bytes = Buffer.byteLength(line, 'utf8')
    if (bytes > this.maxRecordBytes || bytes > this.maxFileBytes) return false

    mkdirSync(this.options.directory, { recursive: true })
    const current = this.pathFor(0)
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

  private pathFor(generation: number): string {
    return join(
      this.options.directory,
      generation === 0 ? EVENT_LOG_FILE : `memory-events.${generation}.jsonl`
    )
  }
}

let activeLog: MemoryEventLog | null = null

function defaultLog(): MemoryEventLog {
  if (!activeLog) {
    activeLog = new MemoryEventLog({ directory: join(app.getPath('appData'), 'Morz') })
  }
  return activeLog
}

/** Fire-and-forget call sites use this fail-closed wrapper; events never break a run. */
export function logMemoryEvent(
  value: MemoryInvocationEvent,
  context: MemoryEventWriteContext = {}
): boolean {
  try {
    return defaultLog().append(value, context)
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
