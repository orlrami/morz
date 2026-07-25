import { spawn as ptySpawn, type IPty } from 'node-pty'
import { spawnSync, execFileSync } from 'child_process'
import { randomUUID } from 'crypto'
import type { TerminalSpawnOpts } from '../../shared/ipc'
import { FlowController } from './flow-control'
import { buildChildEnv } from './path-env'
import { buildShellHook } from './shell-integration'
import { isKnownTuiProcess } from './tui-registry' // w4/finish

/* One GUID tags every child this host spawns (MORZ_SESSION) so a startup sweep
 * after a crash can identify and reap our orphans. */
export const SESSION_GUID = randomUUID()

const SCROLLBACK_MAX_CHARS = 200_000
const INPUT_COMMAND_MAX_CHARS = 512 // w4/finish
const MAX_DIRECT_ARGS = 64
const MAX_DIRECT_ARG_CHARS = 16_000
const MAX_DIRECT_ARGS_CHARS = 32_000

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
    // w5/bugfix: interactive Claude pane runs the real CLI as the pane process
    // (framed TUI). PATH-resolve so ConPTY gets a concrete executable.
    case 'claude':
      return whereFirst('claude', realPath) ?? 'claude'
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

function directArgs(value: unknown): string[] | null {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > MAX_DIRECT_ARGS) return null
  let total = 0
  const args: string[] = []
  for (const candidate of value) {
    if (
      typeof candidate !== 'string' ||
      candidate.includes('\0') ||
      candidate.length > MAX_DIRECT_ARG_CHARS
    ) {
      return null
    }
    total += candidate.length
    if (total > MAX_DIRECT_ARGS_CHARS) return null
    args.push(candidate)
  }
  return args
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
  argv: string[] // w11/lanes-runs — exact spawn arguments, never environment values
  cwd: string
  pid: number
  tui: boolean // w4/finish
  inputLine: string // w4/finish
  blockNonce?: string // w4/finish
  oscCarry: string // w4/finish
}

export interface PaneSpawnedInfo {
  paneId: string
  pid: number
  shell: string
  argv: string[]
  foreground?: string
  cwd: string
  sessionGuid: string
}

export class PtyManager {
  private panes = new Map<string, Pane>()

  constructor(
    private readonly realPath: string,
    private readonly hooks: {
      onData(paneId: string, data: string): void
      onTui(paneId: string, tui: boolean): void // w4/finish
      onExit(paneId: string, exitCode: number, signal?: number): void
      onSpawned(info: PaneSpawnedInfo): void
    }
  ) {}

  spawn(opts: TerminalSpawnOpts): { ok: boolean; error?: string } {
    const existing = this.panes.get(opts.paneId)
    if (existing) {
      this.hooks.onTui(opts.paneId, existing.tui) // w4/finish: rehydrate renderer state
      return { ok: true } // idempotent — reattach path
    }
    const file = resolveShell(opts.shell, this.realPath)
    const requestedArgs = directArgs(opts.argv)
    if (!requestedArgs) return { ok: false, error: 'invalid process arguments' }
    const cwd = opts.cwd ?? process.env.USERPROFILE ?? 'C:\\'
    const env = buildChildEnv(this.realPath, SESSION_GUID, opts.env)
    // OSC-133 block-mark hook (default ON, env kill-switch)
    const hookOff =
      opts.argv !== undefined ||
      process.env.MORZ_NO_SHELL_HOOK === '1' || opts.env?.MORZ_NO_SHELL_HOOK === '1'
    const hook = hookOff ? null : buildShellHook(file, env)
    if (hook?.env) Object.assign(env, hook.env)
    const args = opts.argv !== undefined ? requestedArgs : (hook?.args ?? [])
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
      argv: [...args],
      cwd,
      pid: pty.pid,
      // w4/finish: direct TUI spawns are known before node-pty reports a title.
      tui: isKnownTuiProcess([file, ...args].join(' ')),
      inputLine: '',
      blockNonce: env.MORZ_BLOCK_NONCE,
      oscCarry: ''
    }
    pty.onData((data) => {
      this.refreshTui(pane, data) // w4/finish
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
      if (pane.tui) this.hooks.onTui(opts.paneId, false) // w4/finish
      this.hooks.onExit(opts.paneId, exitCode, signal)
    })
    this.panes.set(opts.paneId, pane)
    this.hooks.onSpawned(this.spawnedInfo(pane)) // w11/lanes-runs
    // w5/dispatch: ConPTY reports pid 0 until its datapipe connects (node-pty
    // updates the getter on 'ready_datapipe') — re-sample so the journal,
    // killTree and the dispatcher's taskkill fallback get the real pid.
    if (pane.pid <= 0) {
      const resample = setInterval(() => {
        if (!this.panes.has(opts.paneId)) return clearInterval(resample)
        const pid = pane.pty.pid
        if (pid > 0) {
          clearInterval(resample)
          pane.pid = pid
          this.hooks.onSpawned(this.spawnedInfo(pane)) // w11/lanes-runs
        }
      }, 50)
      setTimeout(() => clearInterval(resample), 10_000)
    }
    this.hooks.onTui(opts.paneId, pane.tui) // w4/finish
    return { ok: true }
  }

  // w11/lanes-runs — journal only non-secret process identity. `pty.process`
  // is best-effort: Unix backends may report the foreground child while
  // Windows ConPTY commonly reports the configured shell/terminal name.
  private spawnedInfo(pane: Pane): PaneSpawnedInfo {
    let foreground: string | undefined
    try {
      const processName = pane.pty.process
      if (typeof processName === 'string' && processName.trim()) foreground = processName.trim()
    } catch {
      // Dying PTYs can reject process-title access; shell + argv stay authoritative.
    }
    return {
      paneId: pane.paneId,
      pid: pane.pid,
      shell: pane.shell,
      argv: [...pane.argv],
      foreground,
      cwd: pane.cwd,
      sessionGuid: SESSION_GUID
    }
  }

  // w4/finish: transition-only sampling; no process tree or polling loop.
  private setTui(pane: Pane, tui: boolean): void {
    if (tui === pane.tui) return
    pane.tui = tui
    this.hooks.onTui(pane.paneId, tui)
  }

  // w4/finish: node-pty reports active process titles on supported backends.
  // The Windows backend reports only its configured terminal name, so a
  // bounded input-line match sets TUI on launch and the signed prompt clears it.
  private refreshTui(pane: Pane, data: string): void {
    const signedPrompt = pane.blockNonce
      ? `\x1b]133;A;nonce=${pane.blockNonce}\x07`
      : ''
    const promptInput = pane.oscCarry + data
    const promptReturned = signedPrompt !== '' && promptInput.includes(signedPrompt)
    pane.oscCarry = signedPrompt ? promptInput.slice(-(signedPrompt.length - 1)) : ''

    let activeProcessTui = false
    try {
      activeProcessTui = isKnownTuiProcess(pane.pty.process)
    } catch {
      // A dying PTY can reject title access; fail closed to normal terminal mode.
    }
    if (promptReturned) this.setTui(pane, false)
    else if (activeProcessTui) this.setTui(pane, true)
  }

  // w4/finish: tiny spawned-command fallback, not process-tree tracking.
  private trackInput(pane: Pane, data: string): void {
    for (const ch of data) {
      if (ch === '\r' || ch === '\n') {
        if (isKnownTuiProcess(pane.inputLine)) this.setTui(pane, true)
        pane.inputLine = ''
      } else if (ch === '\b' || ch === '\x7f') {
        pane.inputLine = pane.inputLine.slice(0, -1)
      } else if (ch >= ' ' && pane.inputLine.length < INPUT_COMMAND_MAX_CHARS) {
        pane.inputLine += ch
      }
    }
  }

  write(paneId: string, data: string): void {
    const pane = this.panes.get(paneId)
    if (!pane) return
    this.trackInput(pane, data) // w4/finish
    pane.pty.write(data)
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

  /** Current known-process TUI state for renderer reattachment. */
  tuiState(paneId: string): boolean | undefined {
    return this.panes.get(paneId)?.tui
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
    if (pane.tui) this.hooks.onTui(paneId, false) // w4/finish
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
