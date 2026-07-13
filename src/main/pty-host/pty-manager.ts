import { spawn as ptySpawn, type IPty } from 'node-pty'
import { spawnSync, execFileSync } from 'child_process'
import { randomUUID } from 'crypto'
import type { TerminalSpawnOpts } from '../../shared/ipc'
import { FlowController } from './flow-control'
import { buildChildEnv } from './path-env'
import { buildShellHook } from './shell-integration'

/* One GUID tags every child this host spawns (MORZ_SESSION) so a startup sweep
 * after a crash can identify and reap our orphans. */
export const SESSION_GUID = randomUUID()

const SCROLLBACK_MAX_CHARS = 200_000

/* ── ANSI stripper (stateful — escape sequences split across chunks) ── */
// CSI, OSC (BEL or ST terminated), DCS/SOS/PM/APC, single-char escapes.
const ESC_SEQ = '\\x1b(?:\\[[0-9;:?<=>]*[ -/]*[@-~]|\\][^\\x07\\x1b]*(?:\\x07|\\x1b\\\\)|[PX^_][^\\x1b]*\\x1b\\\\|[@-Z\\\\-_])'
const ANSI_RE = new RegExp(`${ESC_SEQ}|[\\x00-\\x08\\x0b\\x0c\\x0e-\\x1f]`, 'g')
/** anchored: does the tail (starting at its ESC) contain a COMPLETE escape sequence? */
const ESC_COMPLETE_RE = new RegExp(`^${ESC_SEQ}`)

export function createAnsiStripper(): (chunk: string) => string {
  let carry = ''
  return (chunk: string): string => {
    let s = carry + chunk
    carry = ''
    // hold back a trailing unterminated escape sequence for the next chunk
    const esc = s.lastIndexOf('\x1b')
    if (esc !== -1) {
      const tail = s.slice(esc)
      if (!ESC_COMPLETE_RE.test(tail) && tail.length < 4096) {
        carry = tail
        s = s.slice(0, esc)
      }
    }
    return s.replace(ANSI_RE, '')
  }
}

/* ── shell resolution ── */
function whereFirst(exe: string, path: string): string | null {
  try {
    const out = execFileSync('where.exe', [exe], {
      env: { ...process.env, Path: path },
      timeout: 5_000,
      windowsHide: true
    })
      .toString()
      .split(/\r?\n/)[0]
      .trim()
    return out || null
  } catch {
    return null
  }
}

export function resolveShell(shell: string | undefined, realPath: string): string {
  if (!shell) {
    return whereFirst('pwsh.exe', realPath) ?? 'powershell.exe'
  }
  if (/[\\/]/.test(shell)) return shell // absolute/relative path — trust it
  switch (shell.toLowerCase()) {
    case 'pwsh':
      return whereFirst('pwsh.exe', realPath) ?? 'powershell.exe'
    case 'powershell':
      return 'powershell.exe'
    case 'cmd':
      return 'cmd.exe'
    case 'wsl':
      return 'wsl.exe'
    default:
      return shell
  }
}

/* ── pane bookkeeping ── */
interface Pane {
  paneId: string
  pty: IPty
  flow: FlowController
  strip: (chunk: string) => string
  scrollback: string[] // ANSI-stripped ring buffer
  scrollbackChars: number
  shell: string
  cwd: string
  pid: number
}

export interface PaneSpawnedInfo {
  paneId: string
  pid: number
  shell: string
  cwd: string
  sessionGuid: string
}

export class PtyManager {
  private panes = new Map<string, Pane>()

  constructor(
    private readonly realPath: string,
    private readonly hooks: {
      onData(paneId: string, data: string): void
      onExit(paneId: string, exitCode: number, signal?: number): void
      onSpawned(info: PaneSpawnedInfo): void
    }
  ) {}

  spawn(opts: TerminalSpawnOpts): { ok: boolean; error?: string } {
    if (this.panes.has(opts.paneId)) return { ok: true } // idempotent — reattach path
    const file = resolveShell(opts.shell, this.realPath)
    const cwd = opts.cwd ?? process.env.USERPROFILE ?? 'C:\\'
    const env = buildChildEnv(this.realPath, SESSION_GUID, opts.env)
    // OSC-133 block-mark hook (default ON, env kill-switch)
    const hookOff =
      process.env.MORZ_NO_SHELL_HOOK === '1' || opts.env?.MORZ_NO_SHELL_HOOK === '1'
    const hook = hookOff ? null : buildShellHook(file, env)
    if (hook?.env) Object.assign(env, hook.env)
    const args = hook?.args ?? []
    const base = {
      name: 'xterm-256color',
      cols: opts.cols,
      rows: opts.rows,
      cwd,
      env,
      handleFlowControl: true
    }
    let pty: IPty
    try {
      // prefer the bundled conpty.dll (modern ConPTY regardless of Windows build)
      pty = ptySpawn(file, args, { ...base, useConptyDll: true })
    } catch {
      try {
        pty = ptySpawn(file, args, base)
      } catch (e) {
        return { ok: false, error: `spawn failed for ${file}: ${(e as Error).message}` }
      }
    }
    const pane: Pane = {
      paneId: opts.paneId,
      pty,
      flow: new FlowController(pty),
      strip: createAnsiStripper(),
      scrollback: [],
      scrollbackChars: 0,
      shell: file,
      cwd,
      pid: pty.pid
    }
    pty.onData((data) => {
      const clean = pane.strip(data)
      if (clean) {
        pane.scrollback.push(clean)
        pane.scrollbackChars += clean.length
        while (pane.scrollbackChars > SCROLLBACK_MAX_CHARS && pane.scrollback.length > 1) {
          pane.scrollbackChars -= pane.scrollback.shift()!.length
        }
      }
      pane.flow.sent(data.length)
      this.hooks.onData(opts.paneId, data)
    })
    pty.onExit(({ exitCode, signal }) => {
      this.panes.delete(opts.paneId)
      this.hooks.onExit(opts.paneId, exitCode, signal)
    })
    this.panes.set(opts.paneId, pane)
    this.hooks.onSpawned({
      paneId: opts.paneId,
      pid: pty.pid,
      shell: file,
      cwd,
      sessionGuid: SESSION_GUID
    })
    return { ok: true }
  }

  write(paneId: string, data: string): void {
    this.panes.get(paneId)?.pty.write(data)
  }

  ack(paneId: string, bytes: number): void {
    this.panes.get(paneId)?.flow.ack(bytes)
  }

  resize(paneId: string, cols: number, rows: number): void {
    const pane = this.panes.get(paneId)
    if (!pane || cols < 1 || rows < 1) return
    try {
      pane.pty.resize(cols, rows)
    } catch {
      // resize on a dying pty throws — pane exit event follows anyway
    }
  }

  /** ANSI-stripped scrollback for reattach replay. */
  scrollback(paneId: string): string {
    return this.panes.get(paneId)?.scrollback.join('') ?? ''
  }

  list(): string[] {
    return [...this.panes.keys()]
  }

  /** Renderer detached (window closed): unclog flow control so PTYs keep running. */
  detachAll(): void {
    for (const pane of this.panes.values()) pane.flow.reset()
  }

  kill(paneId: string): void {
    const pane = this.panes.get(paneId)
    if (!pane) return
    this.panes.delete(paneId)
    killTree(pane.pid)
    try {
      pane.pty.kill()
    } catch {
      // already gone
    }
  }

  killAll(): void {
    for (const paneId of [...this.panes.keys()]) this.kill(paneId)
  }
}

/** Kill the whole child process tree — the practical Job-Object stand-in
 * (a real Job Object needs a native module; revisit post-0.0.1). */
export function killTree(pid: number): void {
  try {
    spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], {
      timeout: 10_000,
      windowsHide: true
    })
  } catch {
    // best effort
  }
}
