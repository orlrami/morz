/*
 * OSC terminal-title extraction (w17/adapter-seam).
 *
 * Agent CLIs announce their own state in the terminal title. This module pulls
 * `ESC ] 0|1|2 ; <title> BEL|ST` out of a raw PTY chunk and hands the titles to
 * the classifier in agent-title-status.ts. Design notes in
 * docs/in-progress/SEAM-DESIGN.md.
 *
 * Approach ported from Orca (onorca.dev, MIT); see
 * docs/research/ORCA-COMPETITOR-RESEARCH.md §P2.1.3 for the original mechanics.
 *
 * Deliberately hand-rolled rather than a regex: raw PTY chunks routinely carry
 * megabyte pastes, and a global regex over every chunk is both slow and prone
 * to matching inside pasted content.
 */

/** OSC commands that set a window/icon title: ESC ] 0 ;  ESC ] 1 ;  ESC ] 2 ; */
const TITLE_COMMANDS = new Set(['0', '1', '2'])

/**
 * Over-long titles keep head AND tail: the trailing status word is the signal,
 * so a naive prefix clip throws away the part we classify on.
 */
export const MAX_TITLE_CHARS = 1024
/** A split sequence waits for the next chunk; a malformed one must not grow forever. */
const MAX_PENDING_CHARS = 64 * 1024
/** Ring bound: a pathological chunk keeps its most recent titles, in order. */
const MAX_TITLES_PER_CHUNK = 4096

const BEL = '\x07'
const ESC = '\x1b'
const OSC = '\x1b]'
const ST = '\x1b\\'

function boundTitle(title: string): string {
  if (title.length <= MAX_TITLE_CHARS) return title
  const half = MAX_TITLE_CHARS / 2
  return title.slice(0, half) + title.slice(title.length - half)
}

export interface OscTitleScan {
  titles: string[]
  /** Incomplete trailing sequence to prepend to the next chunk ('' when none). */
  pending: string
}

/**
 * Every title in `data`, in byte order. Order matters: a `working → idle` pair
 * coalesced into one chunk is invisible if you only read the last title.
 */
export function scanOscTitles(data: string): OscTitleScan {
  const titles: string[] = []
  let index = 0

  while (index < data.length) {
    const start = data.indexOf(OSC, index)
    if (start === -1) {
      // a lone trailing ESC may be the first byte of a split `ESC ]`
      return { titles, pending: data.endsWith(ESC) ? ESC : '' }
    }
    const command = data[start + 2]
    if (command === undefined) return { titles, pending: data.slice(start) }
    if (!TITLE_COMMANDS.has(command)) {
      // some other OSC (shell integration, clipboard, …) — keep scanning past it
      index = start + 2
      continue
    }
    const separator = data[start + 3]
    if (separator === undefined) return { titles, pending: data.slice(start) }
    if (separator !== ';') {
      index = start + 2
      continue
    }

    const body = start + 4
    const bel = data.indexOf(BEL, body)
    const st = data.indexOf(ST, body)
    let end: number
    let terminatorLength: number
    if (bel !== -1 && (st === -1 || bel < st)) {
      end = bel
      terminatorLength = BEL.length
    } else if (st !== -1) {
      end = st
      terminatorLength = ST.length
    } else {
      // unterminated — carry it, unless it has grown past anything plausible
      const pending = data.slice(start)
      return { titles, pending: pending.length > MAX_PENDING_CHARS ? '' : pending }
    }

    titles.push(boundTitle(data.slice(body, end)))
    index = end + terminatorLength
  }

  return { titles, pending: '' }
}

export interface OscTitleScanner {
  /** Feed one PTY chunk; returns its titles in byte order. Never throws. */
  push(chunk: string): string[]
}

/** Stateful across chunks — a title routinely splits over two `onData` calls. */
export function createOscTitleScanner(): OscTitleScanner {
  let carry = ''
  return {
    push(chunk: string): string[] {
      const { titles, pending } = scanOscTitles(carry + chunk)
      carry = pending
      return titles.length > MAX_TITLES_PER_CHUNK
        ? titles.slice(titles.length - MAX_TITLES_PER_CHUNK)
        : titles
    }
  }
}
