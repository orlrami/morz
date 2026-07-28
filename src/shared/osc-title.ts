/*
 * OSC terminal-title extraction (w17/adapter-seam).
 *
 * Agent CLIs announce their own state in the terminal title. This module pulls
 * `ESC ] 0|1|2 ; <title> <terminator>` out of a raw PTY chunk and hands the
 * titles to the classifier in agent-title-status.ts. Design notes in
 * docs/in-progress/SEAM-DESIGN.md.
 *
 * Approach ported from Orca (onorca.dev, MIT); see
 * docs/research/ORCA-COMPETITOR-RESEARCH.md §P2.1.3 for the original mechanics.
 *
 * Deliberately hand-rolled rather than a regex: raw PTY chunks routinely carry
 * megabyte pastes, and a global regex over every chunk is both slow and prone
 * to matching inside pasted content.
 *
 * Termination follows xterm, because xterm is what renders the same bytes and a
 * divergence means Morz classifies text the user never saw as a title. An OSC
 * string ends at BEL, at C1 ST (0x9C), at `ESC \`, or at ANY other ESC — the
 * escape both ends this string and begins the next sequence. CAN (0x18) and
 * SUB (0x1A) abort it, discarding the title outright. Both C0 (`ESC ]`) and C1
 * (0x9D) introducers are accepted.
 */

/** OSC commands that set a window/icon title: ESC ] 0 ;  ESC ] 1 ;  ESC ] 2 ; */
const TITLE_COMMANDS = new Set(['0', '1', '2'])

/**
 * Over-long titles keep head AND tail: the trailing status word is the signal,
 * so a naive prefix clip throws away the part we classify on. The bound is
 * applied while slicing out of the chunk, so an enormous title is never
 * materialized in full first.
 */
export const MAX_TITLE_CHARS = 1024
const HALF_TITLE = MAX_TITLE_CHARS / 2
/** A split sequence waits for the next chunk; a malformed one must not grow forever. */
const MAX_PENDING_CHARS = 64 * 1024
/** Ring bound: a pathological chunk keeps its most recent titles, in order. */
export const MAX_TITLES_PER_CHUNK = 4096

const BEL = 0x07
const CAN = 0x18
const SUB = 0x1a
const ESC = 0x1b
const C1_ST = 0x9c
const C1_OSC = 0x9d
const ESC_CHAR = '\x1b'
const OSC_C0 = '\x1b]'
const OSC_C1 = String.fromCharCode(C1_OSC)

/** Fixed-capacity ring: O(1) push, keeps the most recent titles in order. */
function createTitleRing(capacity: number): {
  push(title: string): void
  drain(): string[]
} {
  const slots = new Array<string>(capacity)
  let head = 0
  let count = 0
  return {
    push(title: string): void {
      slots[(head + count) % capacity] = title
      if (count < capacity) count += 1
      else head = (head + 1) % capacity
    },
    drain(): string[] {
      const out: string[] = []
      for (let i = 0; i < count; i += 1) out.push(slots[(head + i) % capacity])
      return out
    }
  }
}

export interface OscTitleScan {
  titles: string[]
  /** Incomplete trailing sequence to prepend to the next chunk ('' when none). */
  pending: string
}

/** Earliest OSC introducer at or after `from`, with its length. */
function findIntroducer(data: string, from: number): { start: number; length: number } | null {
  const c0 = data.indexOf(OSC_C0, from)
  const c1 = data.indexOf(OSC_C1, from)
  if (c0 === -1 && c1 === -1) return null
  if (c0 === -1) return { start: c1, length: 1 }
  if (c1 === -1) return { start: c0, length: 2 }
  return c0 < c1 ? { start: c0, length: 2 } : { start: c1, length: 1 }
}

/**
 * Every title in `data`, in byte order. Order matters: a `working → idle` pair
 * coalesced into one chunk is invisible if you only read the last title.
 */
export function scanOscTitles(data: string): OscTitleScan {
  const ring = createTitleRing(MAX_TITLES_PER_CHUNK)
  let index = 0

  const carry = (start: number): OscTitleScan => {
    const pending = data.slice(start)
    return { titles: ring.drain(), pending: pending.length > MAX_PENDING_CHARS ? '' : pending }
  }

  while (index < data.length) {
    const introducer = findIntroducer(data, index)
    if (!introducer) {
      // a lone trailing ESC may be the first byte of a split `ESC ]`
      return { titles: ring.drain(), pending: data.endsWith(ESC_CHAR) ? ESC_CHAR : '' }
    }
    const { start, length } = introducer

    const command = data[start + length]
    if (command === undefined) return carry(start)
    if (!TITLE_COMMANDS.has(command)) {
      // some other OSC (shell integration, clipboard, …) — keep scanning past it
      index = start + length
      continue
    }
    const separator = data[start + length + 1]
    if (separator === undefined) return carry(start)
    if (separator !== ';') {
      index = start + length
      continue
    }

    const body = start + length + 2
    let cursor = body
    let end = -1
    let consumed = 0
    let aborted = false

    while (cursor < data.length) {
      const code = data.charCodeAt(cursor)
      if (code === BEL || code === C1_ST) {
        end = cursor
        consumed = 1
        break
      }
      if (code === CAN || code === SUB) {
        // xterm discards the sequence entirely — so do we
        end = cursor
        consumed = 1
        aborted = true
        break
      }
      if (code === ESC) {
        // `ESC \` is ST and belongs to this sequence. Any OTHER escape both
        // ends this string and introduces the next one, so it is consumed by
        // neither — scanning resumes ON it. Consuming it swallowed a chained
        // `ESC]2;first ESC]2;second BEL` down to just "first".
        // At the chunk edge we cannot yet tell the two apart, so we carry.
        if (cursor + 1 >= data.length) return carry(start)
        end = cursor
        consumed = data[cursor + 1] === '\\' ? 2 : 0
        break
      }
      cursor += 1
    }

    if (end === -1) return carry(start) // unterminated — wait for the next chunk

    if (!aborted) {
      const size = end - body
      ring.push(
        size <= MAX_TITLE_CHARS
          ? data.slice(body, end)
          : data.slice(body, body + HALF_TITLE) + data.slice(end - HALF_TITLE, end)
      )
    }
    index = end + consumed
  }

  return { titles: ring.drain(), pending: '' }
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
      return titles
    }
  }
}
