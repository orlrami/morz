/*
 * AgyAdapter (0.0.3, w5/adapters) — owner: Agent 4.
 * Antigravity's `agy` CLI has NO headless mode (verified 1.0.14+: piped/exec
 * invocations produce empty output — Pro auth needs a TTY). So this adapter is
 * PTY injection: spawn agy inside a real ConPTY via node-pty, deliver prompts
 * as a bracketed paste (ESC[200~ … ESC[201~ + CR, so multiline prompts don't
 * auto-submit line by line), and stream the RAW terminal output as delta
 * events.
 *
 * Turn detection = prompt-idle heuristic: after a send, the first output chunk
 * is the marker that agy woke up; from then on every chunk re-arms a 2s timer,
 * and when the PTY stays silent for 2s the turn is declared done ('result').
 * DOCUMENTED LIMITS of that heuristic:
 *  - deltas contain TUI noise: the echoed paste, ANSI redraws, spinners.
 *    Consumers wanting clean text must strip ANSI (pty-manager has a stripper).
 *  - if agy sits silent >2s MID-turn (no spinner redraw while a slow model
 *    thinks), 'result' fires early. A later chunk re-opens nothing — callers
 *    see extra deltas after result. Treat result as advisory, not a hard gate.
 *  - 'result' carries no token/cost data — agy never reports usage on the TTY.
 *  - no permission events: agy renders its own consent UI in the TUI; approve
 *    it by sending the keystroke it asks for (e.g. send('y')).
 * This is the best available contract until agy ships a machine interface.
 *
 * Electron-free by design: scripts/adapters-smoke.mjs drives this module in
 * plain node. node-pty stays a direct dependency here — pty-manager (the
 * terminal host) is NOT touched.
 */
import { spawn as ptySpawn, type IPty } from 'node-pty'
import { spawn, execFileSync } from 'child_process'
import type { AdapterEvent } from '../../shared/ipc'
import type {
  AdapterEventListener,
  AdapterPermissionListener,
  AdapterStartOpts,
  AgentAdapter
} from './types'

const IDLE_MS = 2_000
const PASTE_START = '\x1b[200~'
const PASTE_END = '\x1b[201~'

interface AgyLane {
  agentId: string
  cwd: string
  pty: IPty
  /** A send happened and 'result' has not fired yet. */
  turnOpen: boolean
  /** First output after the send = the marker that arms the idle timer. */
  sawMarker: boolean
  idleTimer: NodeJS.Timeout | null
  /** Pending delayed-CR submit (see send()). */
  crTimer: NodeJS.Timeout | null
  disposed: boolean
}

const lanes = new Map<string, AgyLane>()
const eventListeners = new Set<AdapterEventListener>()
const permissionListeners = new Set<AdapterPermissionListener>()

function emit(agentId: string, event: AdapterEvent): void {
  for (const l of eventListeners) l(agentId, event)
}

function clearIdle(lane: AgyLane): void {
  if (lane.idleTimer) {
    clearTimeout(lane.idleTimer)
    lane.idleTimer = null
  }
}

function armIdle(lane: AgyLane): void {
  clearIdle(lane)
  lane.idleTimer = setTimeout(() => {
    lane.idleTimer = null
    if (lane.disposed || !lane.turnOpen) return
    lane.turnOpen = false
    lane.sawMarker = false
    emit(lane.agentId, { type: 'result' }) // no usage available on a TTY (see header)
  }, IDLE_MS)
}

function onData(lane: AgyLane, data: string): void {
  if (lane.disposed) return
  emit(lane.agentId, { type: 'delta', text: data })
  if (lane.turnOpen) {
    lane.sawMarker = true
    armIdle(lane)
  }
}

/** ConPTY does NOT search PATH (verified: bare 'agy' → "File not found") —
 * resolve the absolute exe up front. Cached after first hit. */
let agyExe: string | null = null
function resolveAgy(): string {
  if (agyExe) return agyExe
  if (process.platform === 'win32') {
    try {
      const hit = execFileSync('where.exe', ['agy'], { timeout: 5_000, windowsHide: true })
        .toString()
        .split(/\r?\n/)[0]
        .trim()
      if (hit) agyExe = hit
    } catch {
      // fall through — spawn will surface the failure as an exit event
    }
  }
  return (agyExe ??= 'agy')
}

function start(opts: AdapterStartOpts): { agentId: string } {
  stop(opts.agentId)
  let pty: IPty
  try {
    pty = ptySpawn(resolveAgy(), [], {
      name: 'xterm-256color',
      cols: 120,
      rows: 32,
      cwd: opts.cwd,
      env: process.env as Record<string, string>
    })
  } catch (err) {
    // ConPTY throws synchronously when the exe is missing — surface it as
    // events instead of crashing the caller.
    emit(opts.agentId, { type: 'error', message: (err as Error).message })
    emit(opts.agentId, { type: 'exit', code: null })
    return { agentId: opts.agentId }
  }
  const lane: AgyLane = {
    agentId: opts.agentId,
    cwd: opts.cwd,
    pty,
    turnOpen: false,
    sawMarker: false,
    idleTimer: null,
    crTimer: null,
    disposed: false
  }
  lanes.set(opts.agentId, lane)
  pty.onData((d) => onData(lane, d))
  pty.onExit(({ exitCode }) => {
    if (lanes.get(opts.agentId) !== lane) return // replaced by a restart
    lane.disposed = true
    clearIdle(lane)
    lanes.delete(opts.agentId)
    emit(opts.agentId, { type: 'exit', code: exitCode })
  })
  // No session/model introspection on a TTY — init just marks the lane live.
  emit(opts.agentId, { type: 'init', cli: 'agy', sessionId: null, model: null })
  return { agentId: opts.agentId }
}

const CR_DELAY_MS = 250

function send(agentId: string, text: string): void {
  const lane = lanes.get(agentId)
  if (!lane || lane.disposed) return
  lane.turnOpen = true
  lane.sawMarker = false
  clearIdle(lane)
  if (lane.crTimer) clearTimeout(lane.crTimer)
  // CR must be a SEPARATE, delayed write. Glued to the paste in one chunk the
  // Ink input swallows it with the paste burst and never submits (verified
  // agy 1.1.2: paste+CR in one write → prompt never echoes; paste, ~250ms,
  // then CR → submits and answers).
  lane.pty.write(PASTE_START + text + PASTE_END)
  lane.crTimer = setTimeout(() => {
    lane.crTimer = null
    if (!lane.disposed) lane.pty.write('\r')
  }, CR_DELAY_MS)
}

function interrupt(agentId: string): void {
  const lane = lanes.get(agentId)
  if (!lane || lane.disposed) return
  clearIdle(lane)
  if (lane.crTimer) {
    clearTimeout(lane.crTimer)
    lane.crTimer = null
  }
  lane.turnOpen = false
  lane.sawMarker = false
  lane.pty.write('\x03') // ^C — agy cancels the running turn, stays alive
}

function stop(agentId: string): void {
  const lane = lanes.get(agentId)
  if (!lane) return
  lane.disposed = true
  clearIdle(lane)
  if (lane.crTimer) {
    clearTimeout(lane.crTimer)
    lane.crTimer = null
  }
  lanes.delete(agentId)
  try {
    lane.pty.write('\x03') // polite cancel first
    lane.pty.kill()
  } catch {
    // pty already dead
  }
  // Belt and braces: ConPTY kill usually reaps children, but agy spawns node
  // workers — sweep the whole tree on Windows.
  if (process.platform === 'win32' && lane.pty.pid) {
    spawn('taskkill', ['/pid', String(lane.pty.pid), '/T', '/F'], { windowsHide: true })
  }
  emit(agentId, { type: 'exit', code: null })
}

export const agyAdapter: AgentAdapter = {
  cli: 'agy',
  start,
  send,
  interrupt,
  stop,
  onEvent(listener) {
    eventListeners.add(listener)
    return () => eventListeners.delete(listener)
  },
  // Never called (agy consent lives in its own TUI) — see header.
  onPermission(listener: AdapterPermissionListener) {
    permissionListeners.add(listener)
    return () => permissionListeners.delete(listener)
  }
}
