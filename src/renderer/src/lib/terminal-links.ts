/*
 * 3-tier terminal link pipeline (0.0.1 Slice 3, emit side).
 * Priority: morz:// OSC-8 (core linkHandler) → stat-verified file paths with
 * file:line:col grammar (link provider, registered first) → URLs via
 * strictUrlRegex (link provider, registered second — xterm uses the first
 * provider that returns links for a cell).
 * All activation is Ctrl/Shift-gated. File hits emit 'open-file' on app-events;
 * Agent 3's IDE pane renders them.
 */
import type { IBufferLine, IDisposable, ILink, Terminal } from '@xterm/xterm'
import { openFile } from './open-file'
import type { OpenFileEvent } from '@shared/ipc'
import { colors } from './tokens'

/* Conservative URL matcher (scheme required — no bare-domain false positives). */
export const strictUrlRegex =
  /(?:https?|ftp|file):\/\/[-\w.]+(?::\d+)?(?:\/[\w\-./%?#=&+~@:!$'()*,;[\]]*)?/g

/*
 * File-path candidates. Grammar handled:
 *   C:\dir\file.ts:12:5   C:/dir/file.ts:12   \\wsl$\Ubuntu\home\x.py
 *   /mnt/c/dir/file.rs(3,7)   src/foo/bar.tsx:3:1   ./rel\file.go
 * Drive-letter colon is part of the path, not a line number.
 */
const filePathRegex =
  /(?:(?:[A-Za-z]:[\\/]|\\\\[\w$.-]+\\|\/(?!\/)|~[\\/]|\.{1,2}[\\/])[\w\-.~$@+%() \\/]*[\w\-.$@+%)]|[\w\-.~$@+]+(?:[\\/][\w\-.~$@+%()]+)+)(?::\d+(?::\d+)?|\(\d+(?:[,:]\d+)?\))?/g

/** `path:line:col`, `path:line`, or `path(line,col)` suffix. */
const lineColRegex = /^(.*?)(?::(\d+)(?::(\d+))?|\((\d+)(?:[,:](\d+))?\))$/

export function parseFileTarget(raw: string): OpenFileEvent | null {
  // Strip common wrappers the shell prints around paths.
  let text = raw.replace(/^["'`<[]+/, '').replace(/["'`>\],;]+$/, '')
  // A trailing `)` is only real if the text has a matching `(` (the `(12,5)` grammar).
  if (text.endsWith(')') && !text.includes('(')) text = text.slice(0, -1)
  text = text.replace(/\.+$/, '')
  if (!text) return null
  const m = lineColRegex.exec(text)
  let path = text
  let line: number | undefined
  let col: number | undefined
  if (m && m[1]) {
    // `C:` alone is a drive, not a line-number host.
    const isDriveOnly = /^[A-Za-z]$/.test(m[1])
    if (!isDriveOnly) {
      path = m[1]
      line = m[2] ? Number(m[2]) : m[4] ? Number(m[4]) : undefined
      col = m[3] ? Number(m[3]) : m[5] ? Number(m[5]) : undefined
    }
  }
  path = path.replace(/[.,;]+$/, '')
  if (path.length < 2) return null
  return { path, line, col }
}

/* ── stat verification (FileApi.read as existence probe, memoized) ── */
const statCache = new Map<string, { ok: boolean; at: number }>()
const STAT_TTL = 10_000
const STAT_CACHE_MAX = 500

async function pathExists(path: string): Promise<boolean> {
  const hit = statCache.get(path)
  if (hit && performance.now() - hit.at < STAT_TTL) return hit.ok
  const file = (window.morz as { file?: { read(p: string): Promise<unknown> } } | undefined)?.file
  let ok: boolean
  if (!file || typeof file.read !== 'function') {
    ok = true // FileService not wired yet (stub preload) — trust the grammar
  } else {
    try {
      await file.read(path)
      ok = true
    } catch {
      ok = false
    }
  }
  if (statCache.size >= STAT_CACHE_MAX) statCache.clear()
  statCache.set(path, { ok, at: performance.now() })
  return ok
}

/* ── shared helpers ── */
const isGated = (e: MouseEvent): boolean => e.ctrlKey || e.shiftKey || e.metaKey

function translateLine(term: Terminal, y: number): IBufferLine | undefined {
  return term.buffer.active.getLine(y - 1)
}

/** Unwrap the full logical line (wrapped rows joined) + start offset of row y. */
function logicalLine(term: Terminal, y: number): { text: string; startY: number } {
  let startY = y
  while (startY > 1 && translateLine(term, startY)?.isWrapped) startY--
  // Untrimmed rows keep every row exactly `cols` wide so match indexes map
  // 1:1 onto buffer cells; only the final text is right-trimmed.
  let endY = startY
  let text = translateLine(term, startY)?.translateToString(false) ?? ''
  while (translateLine(term, endY + 1)?.isWrapped) {
    endY++
    text += translateLine(term, endY)?.translateToString(false) ?? ''
  }
  return { text: text.trimEnd(), startY }
}

function rangeFor(
  term: Terminal,
  startY: number,
  index: number,
  length: number
): ILink['range'] {
  const cols = term.cols
  const sx = index % cols
  const sy = startY + Math.floor(index / cols)
  const ex = (index + length - 1) % cols
  const ey = startY + Math.floor((index + length - 1) / cols)
  return { start: { x: sx + 1, y: sy }, end: { x: ex + 1, y: ey } }
}

const underline = (el?: HTMLElement): void => {
  if (!el) return
  el.style.textDecoration = 'underline dotted'
  el.style.textDecorationColor = colors.bronzeHot
  el.style.cursor = 'pointer'
}
const clearUnderline = (el?: HTMLElement): void => {
  if (!el) return
  el.style.textDecoration = ''
  el.style.cursor = ''
}

/* ── tier 2: stat-verified file paths ── */
function fileLinkProvider(term: Terminal) {
  return {
    provideLinks(y: number, callback: (links: ILink[] | undefined) => void): void {
      const { text, startY } = logicalLine(term, y)
      if (!text) return callback(undefined)
      const candidates: { index: number; length: number; target: OpenFileEvent }[] = []
      filePathRegex.lastIndex = 0
      let m: RegExpExecArray | null
      while ((m = filePathRegex.exec(text)) !== null) {
        const target = parseFileTarget(m[0])
        if (target) candidates.push({ index: m.index, length: m[0].length, target })
      }
      if (candidates.length === 0) return callback(undefined)
      void Promise.all(candidates.map((c) => pathExists(c.target.path))).then((oks) => {
        const links: ILink[] = candidates
          .filter((_, i) => oks[i])
          .map((c) => ({
            range: rangeFor(term, startY, c.index, c.length),
            text: text.substr(c.index, c.length),
            decorations: { pointerCursor: false, underline: false },
            activate: (e: MouseEvent) => {
              if (!isGated(e)) return
              void openFile(c.target.path, c.target.line)
            },
            hover: (e: MouseEvent, _t: string) => {
              if (isGated(e)) underline((e.target as HTMLElement) ?? undefined)
            },
            leave: (e: MouseEvent) => clearUnderline((e.target as HTMLElement) ?? undefined)
          }))
        callback(links.length ? links : undefined)
      })
    }
  }
}

/* ── tier 3: URLs ── */
function urlLinkProvider(term: Terminal) {
  return {
    provideLinks(y: number, callback: (links: ILink[] | undefined) => void): void {
      const { text, startY } = logicalLine(term, y)
      if (!text) return callback(undefined)
      const links: ILink[] = []
      strictUrlRegex.lastIndex = 0
      let m: RegExpExecArray | null
      while ((m = strictUrlRegex.exec(text)) !== null) {
        const url = m[0]
        links.push({
          range: rangeFor(term, startY, m.index, url.length),
          text: url,
          activate: (e: MouseEvent) => {
            if (!isGated(e)) return
            window.open(url, '_blank') // main's setWindowOpenHandler routes/denies
          }
        })
      }
      callback(links.length ? links : undefined)
    }
  }
}

/* ── tier 1: morz:// OSC-8 hyperlinks via the core link handler ── */
function activateOsc8(e: MouseEvent, uri: string): void {
  if (!isGated(e)) return
  if (uri.startsWith('morz://')) {
    try {
      const u = new URL(uri)
      const path = u.searchParams.get('path')
      if (u.host === 'open' && path) {
        void openFile(
          path,
          u.searchParams.get('line') ? Number(u.searchParams.get('line')) : undefined
        )
      }
    } catch {
      /* malformed morz:// — ignore */
    }
    return
  }
  window.open(uri, '_blank')
}

/**
 * Wire all three tiers onto a terminal. Returns a disposer.
 * Registration order = priority (xterm serves the first provider with links).
 */
export function registerTerminalLinks(term: Terminal): IDisposable {
  term.options.linkHandler = { activate: activateOsc8, allowNonHttpProtocols: true }
  const d1 = term.registerLinkProvider(fileLinkProvider(term))
  const d2 = term.registerLinkProvider(urlLinkProvider(term))
  return {
    dispose(): void {
      d1.dispose()
      d2.dispose()
    }
  }
}
