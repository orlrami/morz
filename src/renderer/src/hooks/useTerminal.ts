/*
 * xterm lifecycle + PTY wiring (0.0.1 Slice 1).
 *
 * Sessions are cached at module level, keyed by paneId: App remounts the whole
 * Shell on theme change (key={version}) and StrictMode double-mounts in dev —
 * the Terminal instance and its PTY must survive both. Mount re-attaches the
 * existing DOM element; unmount only detaches. The PTY-host owns process
 * lifetime (tray-resident survival is Slice 2).
 *
 * Hot data flows over ONE MessagePort (PTY_PORT_CHANNEL) shared by all panes:
 * host→renderer {paneId,data}|{paneId,exitCode}, renderer→host {paneId,data}.
 */
import { useEffect, useRef, type RefObject } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebglAddon } from '@xterm/addon-webgl'
import { SerializeAddon } from '@xterm/addon-serialize'
import '@xterm/xterm/css/xterm.css'
import type { MorzApi } from '@shared/ipc'
import { activeXtermTheme, subscribeXtermTheme } from '@/lib/xterm-theme'
import { attachCommandBlocks } from '@/lib/terminal-blocks'
import { registerTerminalLinks } from '@/lib/terminal-links'
import { colors } from '@/lib/tokens'

interface Session {
  term: Terminal
  fit: FitAddon
  serialize: SerializeAddon
  nonce: string
  spawned: boolean
  exited: boolean
  /** Alt-screen buffer active — a full-screen TUI (vim/less/htop) owns the grid. */
  tui: boolean
}

const sessions = new Map<string, Session>()

/* ── framed-TUI: alt-screen buffer state, exposed for a pane chip ── */
const tuiListeners = new Map<string, Set<(tui: boolean) => void>>()

export function isTerminalTui(paneId: string): boolean {
  return sessions.get(paneId)?.tui ?? false
}

/** Fires when the pane enters/leaves the alt-screen buffer. Returns unsubscribe. */
export function subscribeTerminalTui(paneId: string, cb: (tui: boolean) => void): () => void {
  let set = tuiListeners.get(paneId)
  if (!set) {
    set = new Set()
    tuiListeners.set(paneId, set)
  }
  set.add(cb)
  return () => {
    set.delete(cb)
  }
}

/* ── micro-UX: font zoom + clipboard actions (shared by keys, wheel, menu) ── */
const FONT_MIN = 8
const FONT_MAX = 28
const FONT_DEFAULT = 13

function applyFontSize(paneId: string, size: number): void {
  const s = sessions.get(paneId)
  if (!s) return
  const next = Math.min(FONT_MAX, Math.max(FONT_MIN, size))
  if (next === s.term.options.fontSize) return
  s.term.options.fontSize = next
  s.fit.fit()
  // fit() only emits onResize when cols/rows change; nudge the PTY regardless
  // so the shell reflows even on same-grid font steps.
  if (s.spawned && !s.exited) ptyApi()?.resize(paneId, s.term.cols, s.term.rows)
}

export function zoomTerminal(paneId: string, delta: 1 | -1): void {
  const s = sessions.get(paneId)
  if (!s) return
  applyFontSize(paneId, (s.term.options.fontSize ?? FONT_DEFAULT) + delta)
}

export function resetTerminalZoom(paneId: string): void {
  applyFontSize(paneId, FONT_DEFAULT)
}

export function copyTerminalSelection(paneId: string): void {
  const sel = sessions.get(paneId)?.term.getSelection()
  if (sel) void navigator.clipboard.writeText(sel).catch(() => {})
}

/** Paste via term.paste() — xterm wraps in bracketed-paste when the app enabled it. */
export function pasteIntoTerminal(paneId: string): void {
  const s = sessions.get(paneId)
  if (!s || s.exited) return
  void navigator.clipboard
    .readText()
    .then((text) => {
      if (text) s.term.paste(text)
    })
    .catch(() => {})
}

/** Real PTY bridge, or null while the preload is still the Phase-0 stub. */
function ptyApi(): MorzApi['pty'] | null {
  const m = window.morz as Partial<MorzApi> | undefined
  return m?.pty && typeof m.pty.spawn === 'function' ? (m.pty as MorzApi['pty']) : null
}

/* ── PTY output relay (main → renderer via window.morz.pty.onData) ── */
let dataSubscribed = false

function ensurePort(): void {
  const pty = ptyApi()
  if (dataSubscribed || !pty) return
  dataSubscribed = true
  pty.onData((msg) => {
    const s = sessions.get(msg.paneId)
    if (!s) return
    if ('exitCode' in msg) {
      s.exited = true
      s.term.write(`\r\n\x1b[2m— process exited (${msg.exitCode}) —\x1b[0m\r\n`)
    } else {
      s.term.write(msg.data)
      // flow-control ack so the host resumes past its high watermark
      pty.ack(msg.paneId, msg.data.length)
    }
  })
}

function portWrite(paneId: string, data: string): void {
  ptyApi()?.write(paneId, data)
}

/* ── theme: one subscription updates every live terminal ── */
subscribeXtermTheme((theme) => {
  for (const s of sessions.values()) s.term.options.theme = theme
})

function createSession(paneId: string): Session {
  const term = new Terminal({
    allowProposedApi: true,
    cursorBlink: true,
    cursorStyle: 'bar',
    fontFamily: '"JetBrains Mono Variable", "JetBrains Mono", Consolas, monospace',
    fontSize: 13,
    lineHeight: 1.25,
    letterSpacing: 0,
    scrollback: 8000,
    theme: activeXtermTheme()
  })
  const fit = new FitAddon()
  const serialize = new SerializeAddon()
  term.loadAddon(fit)
  term.loadAddon(serialize)

  const nonce = crypto.randomUUID()
  attachCommandBlocks(term, nonce)
  registerTerminalLinks(term)

  const session: Session = {
    term,
    fit,
    serialize,
    nonce,
    spawned: false,
    exited: false,
    tui: false
  }

  term.buffer.onBufferChange((buf) => {
    const tui = buf.type === 'alternate'
    if (tui === session.tui) return
    session.tui = tui
    for (const cb of tuiListeners.get(paneId) ?? []) cb(tui)
  })

  // copy-on-select (setting-less default for 0.0.1)
  term.onSelectionChange(() => {
    const sel = term.getSelection()
    if (sel) void navigator.clipboard.writeText(sel).catch(() => {})
  })

  // Ctrl+= / Ctrl+- / Ctrl+0 zoom, Ctrl+V paste — consume so xterm never
  // forwards the raw control sequence to the shell.
  term.attachCustomKeyEventHandler((ev) => {
    if (ev.type !== 'keydown' || !ev.ctrlKey || ev.altKey || ev.metaKey) return true
    switch (ev.key) {
      case '=':
      case '+':
        zoomTerminal(paneId, 1)
        return false
      case '-':
        zoomTerminal(paneId, -1)
        return false
      case '0':
        resetTerminalZoom(paneId)
        return false
      case 'v':
      case 'V':
        pasteIntoTerminal(paneId)
        return false
      default:
        return true
    }
  })

  term.onData((data) => {
    if (!session.exited) portWrite(paneId, data)
  })
  term.onResize(({ cols, rows }) => {
    if (session.spawned && !session.exited) ptyApi()?.resize(paneId, cols, rows)
  })

  sessions.set(paneId, session)
  return session
}

function spawn(session: Session, paneId: string, shell?: string, cwd?: string): void {
  if (session.spawned) return
  session.spawned = true
  const pty = ptyApi()
  if (!pty) {
    session.term.writeln('\x1b[2m— PTY host offline (renderer dev mode) —\x1b[0m')
    return
  }
  ensurePort()
  void pty
    .spawn({
      paneId,
      shell,
      cwd,
      cols: session.term.cols,
      rows: session.term.rows,
      env: { MORZ_BLOCK_NONCE: session.nonce }
    })
    .then(({ ok }) => {
      if (!ok) {
        session.exited = true
        session.term.writeln(`\x1b[31m— failed to spawn ${shell ?? 'shell'} —\x1b[0m`)
      }
    })
    .catch(() => {
      session.exited = true
      session.term.writeln('\x1b[31m— PTY spawn error —\x1b[0m')
    })
}

export interface UseTerminalOpts {
  shell?: string
  cwd?: string
}

export function useTerminal(
  paneId: string,
  opts?: UseTerminalOpts
): { containerRef: RefObject<HTMLDivElement> } {
  const containerRef = useRef<HTMLDivElement>(null)
  const shell = opts?.shell
  const cwd = opts?.cwd

  useEffect(() => {
    const el = containerRef.current
    if (!el) return

    const session = sessions.get(paneId) ?? createSession(paneId)
    const { term, fit } = session

    if (term.element) {
      el.appendChild(term.element) // re-attach after Shell remount / StrictMode
    } else {
      term.open(el)
      try {
        const webgl = new WebglAddon()
        webgl.onContextLoss(() => webgl.dispose()) // silent DOM-renderer fallback
        term.loadAddon(webgl)
      } catch {
        /* WebGL unavailable — DOM renderer is fine */
      }
    }
    term.options.theme = activeXtermTheme()
    el.style.background = colors.page

    fit.fit()
    spawn(session, paneId, shell, cwd)

    const ro = new ResizeObserver(() => {
      if (el.clientWidth > 0 && el.clientHeight > 0) fit.fit()
    })
    ro.observe(el)

    // ctrl+wheel zoom — capture so xterm's viewport scroll never sees it
    const onWheel = (ev: WheelEvent): void => {
      if (!ev.ctrlKey) return
      ev.preventDefault()
      ev.stopPropagation()
      zoomTerminal(paneId, ev.deltaY < 0 ? 1 : -1)
    }
    el.addEventListener('wheel', onWheel, { passive: false, capture: true })

    return () => {
      ro.disconnect()
      el.removeEventListener('wheel', onWheel, { capture: true })
      // Detach only — session + PTY survive remounts. Kill is an explicit
      // pane-close affordance (post-0.0.1 UI) or PTY-host lifecycle.
      if (term.element && term.element.parentElement === el) {
        el.removeChild(term.element)
      }
    }
  }, [paneId, shell, cwd])

  return { containerRef }
}

/** Serialized scrollback for Slice 2 session save. */
export function serializeTerminal(paneId: string): string | null {
  const s = sessions.get(paneId)
  return s ? s.serialize.serialize() : null
}
