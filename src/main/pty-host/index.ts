/*
 * Morz PTY-host — Electron utilityProcess entry (0.0.1 Slices 1+2).
 * Owns every PTY. Hot data flows straight to the renderer over a MessagePortMain;
 * control (spawn/resize/kill/list) arrives from main over process.parentPort.
 * The host outlives the window (tray-resident main keeps it alive), so closing
 * the window keeps shells/claude running and reopening reattaches via pty:list.
 */
import type { MessagePortMain } from 'electron'
import type { PtyPortMsg, TerminalSpawnOpts } from '../../shared/ipc'
import { PtyManager } from './pty-manager'
import { resolveRealPath } from './path-env'

type MainReq =
  | { type: 'renderer-port' } // ports[0] = renderer side channel (legacy)
  | { type: 'renderer-gone' }
  | { type: 'shutdown' }
  | { type: 'write'; paneId: string; data: string }
  | { type: 'ack'; paneId: string; bytes: number }
  | { type: 'attach'; paneId: string }
  | { type: 'req'; id: number; op: 'spawn' | 'resize' | 'kill' | 'list'; payload?: unknown }

interface ParentPortLike {
  on(event: 'message', listener: (e: { data: MainReq; ports: MessagePortMain[] }) => void): void
  postMessage(message: unknown): void
}

const parentPort = (process as unknown as { parentPort: ParentPortLike }).parentPort

let rendererPort: MessagePortMain | null = null
let manager: PtyManager | null = null

// PTY data/exit relays through main (parentPort) → webContents → renderer.
// (A direct utilityProcess↔renderer MessagePort did not entangle reliably here.)
const toRenderer = (msg: PtyPortMsg): void => {
  parentPort.postMessage({ type: 'pty', msg })
}

const init = (async () => {
  const realPath = await resolveRealPath()
  manager = new PtyManager(realPath, {
    onData: (paneId, data) => toRenderer({ type: 'data', paneId, data }),
    onTui: (paneId, tui) => toRenderer({ type: 'tui', paneId, tui }),
    onExit: (paneId, exitCode, signal) => {
      toRenderer({ type: 'exit', paneId, exitCode, signal })
      parentPort.postMessage({ type: 'exit', paneId, exitCode, signal })
    },
    onSpawned: (info) => parentPort.postMessage({ type: 'spawned', info })
  })
  parentPort.postMessage({ type: 'ready' })
  return manager
})()

function adoptRendererPort(port: MessagePortMain): void {
  try {
    rendererPort?.close()
  } catch {
    // previous window's port may already be dead
  }
  rendererPort = port
  port.on('message', (e) => {
    const msg = e.data as PtyPortMsg
    if (!manager || !msg || typeof msg !== 'object') return
    switch (msg.type) {
      case 'write':
        manager.write(msg.paneId, msg.data)
        break
      case 'ack':
        manager.ack(msg.paneId, msg.bytes)
        break
      case 'attach': {
        // replay ANSI-stripped scrollback so a reopened window shows history
        const scrollback = manager.scrollback(msg.paneId)
        if (scrollback) toRenderer({ type: 'data', paneId: msg.paneId, data: scrollback })
        const tui = manager.tuiState(msg.paneId)
        if (tui !== undefined) toRenderer({ type: 'tui', paneId: msg.paneId, tui })
        break
      }
    }
  })
  port.on('close', () => {
    if (rendererPort === port) {
      rendererPort = null
      manager?.detachAll()
    }
  })
  port.start()
  // Replay each live pane's scrollback to the freshly-connected renderer. Covers
  // (1) the first-spawn race where a pane emitted its prompt before this port was
  // adopted, and (2) Slice-2 reopen (window closed → reattach shows history).
  if (manager) {
    for (const paneId of manager.list()) {
      const scrollback = manager.scrollback(paneId)
      if (scrollback) toRenderer({ type: 'data', paneId, data: scrollback })
      const tui = manager.tuiState(paneId)
      if (tui !== undefined) toRenderer({ type: 'tui', paneId, tui })
    }
  }
}

async function handleReq(id: number, op: string, payload: unknown): Promise<void> {
  const mgr = await init
  try {
    let result: unknown
    switch (op) {
      case 'spawn':
        result = mgr.spawn(payload as TerminalSpawnOpts)
        break
      case 'resize': {
        const p = payload as { paneId: string; cols: number; rows: number }
        mgr.resize(p.paneId, p.cols, p.rows)
        result = { ok: true }
        break
      }
      case 'kill':
        mgr.kill((payload as { paneId: string }).paneId)
        result = { ok: true }
        break
      case 'list':
        result = mgr.list()
        break
      default:
        throw new Error(`unknown op ${op}`)
    }
    parentPort.postMessage({ type: 'res', id, ok: true, result })
  } catch (e) {
    parentPort.postMessage({ type: 'res', id, ok: false, error: (e as Error).message })
  }
}

parentPort.on('message', (e) => {
  const msg = e.data as MainReq & { paneId?: string; data?: string; bytes?: number }
  if (!msg || typeof msg !== 'object') return
  switch (msg.type) {
    case 'renderer-port':
      if (e.ports[0]) adoptRendererPort(e.ports[0])
      break
    case 'renderer-gone':
      manager?.detachAll()
      break
    case 'write':
      if (msg.paneId != null) manager?.write(msg.paneId, msg.data ?? '')
      break
    case 'ack':
      if (msg.paneId != null) manager?.ack(msg.paneId, msg.bytes ?? 0)
      break
    case 'attach':
      if (msg.paneId != null) {
        const sb = manager?.scrollback(msg.paneId)
        if (sb) toRenderer({ type: 'data', paneId: msg.paneId, data: sb })
        const tui = manager?.tuiState(msg.paneId)
        if (tui !== undefined) toRenderer({ type: 'tui', paneId: msg.paneId, tui })
      }
      break
    case 'req':
      void handleReq(msg.id, msg.op, msg.payload)
      break
    case 'shutdown':
      void init.then((mgr) => {
        mgr.killAll()
        process.exit(0)
      })
      break
  }
})
