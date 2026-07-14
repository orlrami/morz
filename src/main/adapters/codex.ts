/*
 * CodexAdapter (0.0.3, w5/adapters) — owner: Agent 4.
 * Drives the user's `codex` CLI headless: one `codex exec --json` process PER
 * TURN (codex has no long-lived stdin session in exec mode). Thread continuity
 * comes from `codex exec resume <thread_id>` — the first turn's thread.started
 * id is captured and every later send resumes it.
 *
 * CRITICAL (verified codex-cli 0.144.3): stdin must be 'ignore'. With an open
 * stdin pipe codex prints "Reading additional input from stdin..." and blocks
 * forever waiting for EOF.
 *
 * Turn lifecycle vs events: each turn's child exiting 0 after turn.completed
 * is an implementation detail — consumers see 'result', NOT 'exit'. 'exit'
 * fires only on stop() or an abnormal (non-zero, un-completed) turn.
 *
 * Electron-free by design: scripts/adapters-smoke.mjs drives this module in
 * plain node.
 */
import { spawn, type ChildProcess } from 'child_process'
import type { AdapterEvent } from '../../shared/ipc'
import type {
  AdapterEventListener,
  AdapterPermissionListener,
  AdapterStartOpts,
  AgentAdapter
} from './types'

interface CodexLane {
  agentId: string
  cwd: string
  threadId: string | null
  child: ChildProcess | null
  buf: string
  stderrTail: string
  /** Prompts queued while a turn is in flight (codex = one process per turn). */
  queue: string[]
  /** Current turn reached turn.completed — a clean zero-exit is expected. */
  turnCompleted: boolean
  stopping: boolean
}

const lanes = new Map<string, CodexLane>()
const eventListeners = new Set<AdapterEventListener>()
const permissionListeners = new Set<AdapterPermissionListener>()

function emit(agentId: string, event: AdapterEvent): void {
  for (const l of eventListeners) l(agentId, event)
}

function treeKill(pid: number | undefined): void {
  if (!pid) return
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true })
  } else {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // already gone
    }
  }
}

/** Map one codex NDJSON event onto the normalized union (null = skip). */
function normalizeCodexEvent(lane: CodexLane, raw: Record<string, unknown>): AdapterEvent | null {
  switch (raw.type) {
    case 'thread.started': {
      if (typeof raw.thread_id === 'string') lane.threadId = raw.thread_id
      return { type: 'init', cli: 'codex', sessionId: lane.threadId, model: null }
    }
    case 'item.completed': {
      const item = raw.item as { type?: string; text?: string } | undefined
      if (!item) return null
      if (item.type === 'agent_message' && typeof item.text === 'string') {
        return { type: 'message', role: 'assistant', text: item.text }
      }
      if (item.type === 'reasoning') return null
      return { type: 'tool', name: item.type ?? 'unknown', detail: item }
    }
    case 'turn.completed': {
      lane.turnCompleted = true
      const usage = raw.usage as
        | { input_tokens?: number; output_tokens?: number; total_cost_usd?: number }
        | undefined
      return {
        type: 'result',
        inputTokens: usage?.input_tokens,
        outputTokens: usage?.output_tokens,
        costUsd: typeof usage?.total_cost_usd === 'number' ? usage.total_cost_usd : undefined
      }
    }
    case 'turn.failed': {
      const err = raw.error as { message?: string } | undefined
      return { type: 'error', message: err?.message ?? 'codex turn failed' }
    }
    case 'error':
      return { type: 'error', message: String(raw.message ?? 'codex error') }
    default:
      return null // thread/turn bookkeeping, item.started/updated deltas — not mapped yet
  }
}

function onStdout(lane: CodexLane, chunk: Buffer): void {
  lane.buf += chunk.toString('utf8')
  let nl: number
  while ((nl = lane.buf.indexOf('\n')) !== -1) {
    const line = lane.buf.slice(0, nl).trim()
    lane.buf = lane.buf.slice(nl + 1)
    if (!line) continue
    let raw: Record<string, unknown>
    try {
      raw = JSON.parse(line) as Record<string, unknown>
    } catch {
      emit(lane.agentId, { type: 'error', message: `unparseable codex line: ${line.slice(0, 200)}` })
      continue
    }
    const normalized = normalizeCodexEvent(lane, raw)
    if (normalized) emit(lane.agentId, normalized)
  }
}

function spawnTurn(lane: CodexLane, text: string): void {
  const args = lane.threadId
    ? ['exec', 'resume', lane.threadId, '--json', '--cd', lane.cwd, text]
    : ['exec', '--json', '--cd', lane.cwd, text]
  // codex is a native .exe on every install channel we support — no shell shim.
  const child = spawn('codex', args, {
    cwd: lane.cwd,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'] // stdin MUST be ignored (see header)
  })
  lane.child = child
  lane.buf = ''
  lane.stderrTail = ''
  lane.turnCompleted = false
  child.stdout?.on('data', (d: Buffer) => onStdout(lane, d))
  child.stderr?.on('data', (d: Buffer) => {
    lane.stderrTail = (lane.stderrTail + d.toString('utf8')).slice(-2000)
  })
  child.on('error', (err) => {
    if (lanes.get(lane.agentId) === lane) {
      emit(lane.agentId, { type: 'error', message: err.message })
    }
  })
  child.on('close', (code) => {
    if (lanes.get(lane.agentId) !== lane || lane.child !== child) return
    lane.child = null
    if (code !== 0 && !lane.turnCompleted) {
      emit(lane.agentId, {
        type: 'error',
        message: `codex exited ${code}: ${lane.stderrTail.trim().slice(-500) || 'no stderr'}`
      })
      emit(lane.agentId, { type: 'exit', code })
      return
    }
    const next = lane.queue.shift()
    if (next !== undefined) spawnTurn(lane, next)
  })
}

function start(opts: AdapterStartOpts): { agentId: string } {
  stop(opts.agentId)
  lanes.set(opts.agentId, {
    agentId: opts.agentId,
    cwd: opts.cwd,
    threadId: opts.resume ?? null,
    child: null,
    buf: '',
    stderrTail: '',
    queue: [],
    turnCompleted: false,
    stopping: false
  })
  return { agentId: opts.agentId }
}

function send(agentId: string, text: string): void {
  const lane = lanes.get(agentId)
  if (!lane || lane.stopping) return
  if (lane.child) lane.queue.push(text)
  else spawnTurn(lane, text)
}

/** Cancels the in-flight turn AND drops queued prompts (a queued prompt after
 * an interrupt would resume a context the owner just rejected). */
function interrupt(agentId: string): void {
  const lane = lanes.get(agentId)
  if (!lane) return
  lane.queue = []
  if (lane.child) {
    lane.turnCompleted = true // suppress the abnormal-exit error path
    treeKill(lane.child.pid)
  }
}

function stop(agentId: string): void {
  const lane = lanes.get(agentId)
  if (!lane) return
  lane.stopping = true
  lane.queue = []
  lanes.delete(agentId) // close handler goes silent past this point (restart-safe)
  if (lane.child) {
    treeKill(lane.child.pid)
    emit(agentId, { type: 'exit', code: null })
  }
}

export const codexAdapter: AgentAdapter = {
  cli: 'codex',
  start,
  send,
  interrupt,
  stop,
  onEvent(listener) {
    eventListeners.add(listener)
    return () => eventListeners.delete(listener)
  },
  // codex exec never round-trips permissions to us — its approval policy is
  // config-side (~/.codex/config.toml). Listener registered but never called.
  onPermission(listener: AdapterPermissionListener) {
    permissionListeners.add(listener)
    return () => permissionListeners.delete(listener)
  }
}
