/*
 * w17/adapter-seam — the pure half of the bridge: OSC title extraction and the
 * title → activity classifier. Every case here is a trap the design doc calls
 * out (docs/in-progress/SEAM-DESIGN.md); if one of these regresses the seam
 * starts inventing agent states from ordinary shell output.
 *
 * Several are regressions for the round-1 adversarial review: the classifier
 * used to read ownership AFTER the glyphs and substring-match agent names, and
 * the OSC scanner used to accept only BEL and `ESC \` as terminators, which let
 * text xterm never rendered as a title reach the classifier.
 *
 * Unit tests live under src/main by repo convention (src/shared is compiled by
 * the web tsconfig, which has no node types).
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  createOscTitleScanner,
  MAX_TITLE_CHARS,
  MAX_TITLES_PER_CHUNK,
  scanOscTitles
} from '../../shared/osc-title'
import {
  createTitleTracker,
  detectActivityFromTitle,
  normalizeTerminalTitle
} from '../../shared/agent-title-status'

const ST = '\x1b\\'
const C1_ST = String.fromCharCode(0x9c)
const C1_OSC = String.fromCharCode(0x9d)

/* ── OSC extraction ── */

test('extracts titles for OSC 0, 1 and 2, terminated by BEL or ST', () => {
  assert.deepEqual(scanOscTitles('\x1b]0;window\x07').titles, ['window'])
  assert.deepEqual(scanOscTitles('\x1b]1;icon\x07').titles, ['icon'])
  assert.deepEqual(scanOscTitles(`\x1b]2;title${ST}`).titles, ['title'])
})

test('accepts C1 ST and the C1 OSC introducer', () => {
  assert.deepEqual(scanOscTitles(`\x1b]2;title${C1_ST}`).titles, ['title'])
  assert.deepEqual(scanOscTitles(`${C1_OSC}2;title\x07`).titles, ['title'])
})

test('any ESC ends the OSC string, as xterm renders it', () => {
  // Codex round-1 repro: the trailing text is NOT part of the title, and
  // treating it as one classified an idle agent as waiting.
  const { titles } = scanOscTitles('\x1b]2;Claude idle\x1bX permission\x07')
  assert.deepEqual(titles, ['Claude idle'])
  assert.equal(detectActivityFromTitle(titles[0]), 'idle')
})

test('a terminating ESC is reconsidered as the next introducer, not swallowed', () => {
  // Round-2 repro: consuming the bare ESC ate the whole sequence behind it, so
  // a CLI chaining title writes without BEL lost every title but the first.
  assert.deepEqual(scanOscTitles('\x1b]2;first\x1b]2;second\x07').titles, ['first', 'second'])
  // the same shape carrying the signal that actually matters
  assert.deepEqual(scanOscTitles('\x1b]2;⠋ Claude\x1b]2;✳ Claude\x07').titles, [
    '⠋ Claude',
    '✳ Claude'
  ])
  // three chained, the last ST-terminated
  assert.deepEqual(scanOscTitles(`\x1b]2;a\x1b]2;b\x1b]2;c${ST}`).titles, ['a', 'b', 'c'])
})

test('CAN and SUB abort the sequence — the title is discarded, not truncated', () => {
  assert.deepEqual(scanOscTitles('\x1b]2;Claude working\x18').titles, [])
  assert.deepEqual(scanOscTitles('\x1b]2;Claude working\x1a').titles, [])
  // and scanning resumes cleanly afterwards
  assert.deepEqual(scanOscTitles('\x1b]2;abort\x18\x1b]2;✳ Claude\x07').titles, ['✳ Claude'])
})

test('returns every title in byte order — a coalesced transition must stay visible', () => {
  const chunk = '\x1b]2;⠋ Claude\x07some output\x1b]2;✳ Claude\x07'
  assert.deepEqual(scanOscTitles(chunk).titles, ['⠋ Claude', '✳ Claude'])
})

test('ignores non-title OSC sequences and surrounding plain text', () => {
  const chunk = 'ready> \x1b]133;A\x07\x1b]2;✳ Claude\x07\x1b]9999;{"state":"done"}\x07tail'
  assert.deepEqual(scanOscTitles(chunk).titles, ['✳ Claude'])
})

test('a title split across chunks is carried, not lost', () => {
  const scanner = createOscTitleScanner()
  assert.deepEqual(scanner.push('\x1b]2;⠋ Cla'), [])
  assert.deepEqual(scanner.push('ude Code\x07'), ['⠋ Claude Code'])
})

test('a sequence split mid-introducer is carried', () => {
  const scanner = createOscTitleScanner()
  assert.deepEqual(scanner.push('output\x1b'), [])
  assert.deepEqual(scanner.push(']2;✳ Claude\x07'), ['✳ Claude'])
})

test('an ESC at the chunk edge is carried — ST and a bare ESC end the title differently', () => {
  const scanner = createOscTitleScanner()
  assert.deepEqual(scanner.push('\x1b]2;✳ Claude\x1b'), [], 'cannot yet tell ST from a new escape')
  assert.deepEqual(scanner.push('\\'), ['✳ Claude'], 'it was ST')

  const other = createOscTitleScanner()
  assert.deepEqual(other.push('\x1b]2;✳ Claude\x1b'), [])
  assert.deepEqual(other.push('X'), ['✳ Claude'], 'it was a bare ESC — title still ends there')
})

test('over-long titles keep head AND tail — the trailing status word is the signal', () => {
  const long = `${'x'.repeat(4000)} Claude ready`
  const [title] = scanOscTitles(`\x1b]2;${long}\x07`).titles
  assert.equal(title.length, MAX_TITLE_CHARS)
  assert.ok(title.endsWith('Claude ready'), 'the tail must survive truncation')
  assert.equal(detectActivityFromTitle(title), 'idle')
})

test('an unterminated sequence larger than the pending bound is dropped, not buffered', () => {
  const { titles, pending } = scanOscTitles(`\x1b]2;${'x'.repeat(70_000)}`)
  assert.deepEqual(titles, [])
  assert.equal(pending, '')
})

test('titles per chunk are bounded, keeping the most recent in order', () => {
  let chunk = ''
  for (let i = 0; i < MAX_TITLES_PER_CHUNK + 50; i += 1) chunk += `\x1b]2;t${i}\x07`
  const { titles } = scanOscTitles(chunk)
  assert.equal(titles.length, MAX_TITLES_PER_CHUNK)
  assert.equal(titles[titles.length - 1], `t${MAX_TITLES_PER_CHUNK + 49}`, 'newest kept')
  assert.equal(titles[0], 't50', 'oldest dropped, order preserved')
})

test('a megabyte paste with no titles yields nothing and terminates', () => {
  const paste = 'a'.repeat(1_000_000)
  assert.deepEqual(scanOscTitles(paste).titles, [])
})

/* ── ownership: the classifier must fail closed ── */

test('an unowned title is never a state, whatever glyph it carries', () => {
  // All three were misclassified before ownership moved ahead of the glyphs.
  assert.equal(detectActivityFromTitle('✋ build paused'), null)
  assert.equal(detectActivityFromTitle('⠋ docs'), null)
  assert.equal(detectActivityFromTitle('permission — C:\\projects\\claude-tools'), null)
})

test('agent names are boundary-matched, so paths and compounds are not ownership', () => {
  assert.equal(detectActivityFromTitle('claude-tools ready'), null)
  assert.equal(detectActivityFromTitle('~/codex/ready'), null)
  assert.equal(detectActivityFromTitle('C:\\work\\opencode\\idle'), null)
  // the same names standing alone DO own the title
  assert.equal(detectActivityFromTitle('Claude Code — ready'), 'idle')
})

test('an unrecognized title fails closed instead of defaulting to idle', () => {
  assert.equal(detectActivityFromTitle('Claude Code'), null)
  assert.equal(detectActivityFromTitle('claude ~/src/working'), null)
  assert.equal(detectActivityFromTitle('codex run-permission-fix'), null)
  assert.equal(detectActivityFromTitle('', 'claude'), null)
})

test('the launching CLI establishes ownership, so a nameless agent title still reads', () => {
  // Claude Code usually titles itself with the TASK, not its own name — the
  // dispatcher always knows which CLI it launched, so that is the owner.
  assert.equal(detectActivityFromTitle('⠋ refactoring the store', 'claude'), 'working')
  assert.equal(detectActivityFromTitle('✳ waiting for input', 'claude'), 'idle')
  assert.equal(detectActivityFromTitle('✋ build paused', 'agy'), 'waiting')
})

test('glyphs are anchored to the leading position and scoped to their CLI', () => {
  assert.equal(detectActivityFromTitle('✳ Claude Code'), 'idle')
  assert.equal(detectActivityFromTitle('⠋ Claude Code'), 'working')
  assert.equal(detectActivityFromTitle('✋ Gemini CLI'), 'waiting')
  assert.equal(detectActivityFromTitle('✦ Gemini CLI'), 'working')
  assert.equal(detectActivityFromTitle('◇ Gemini CLI'), 'idle')
  // not in the canonical leading position → not a marker
  assert.equal(detectActivityFromTitle('Claude Code ✳'), null)
  assert.equal(detectActivityFromTitle('build ✋ Gemini', 'claude'), null)
})

test('keyword rules require a NAMED agent — those words are ordinary English', () => {
  assert.equal(detectActivityFromTitle('Claude — action required'), 'waiting')
  assert.equal(detectActivityFromTitle('codex: permission'), 'waiting')
  // same words, no name: a codex-launched pane running anything else
  assert.equal(detectActivityFromTitle('action required', 'codex'), null)
  assert.equal(detectActivityFromTitle('npm run build — running', 'codex'), null)
})

test("Claude Code's own prefix conventions classify, scoped to claude", () => {
  assert.equal(detectActivityFromTitle('. claude refactoring the store'), 'working')
  assert.equal(detectActivityFromTitle('* claude'), 'idle')
  assert.equal(detectActivityFromTitle('. deploying', 'claude'), 'working')
  assert.equal(detectActivityFromTitle('. deploying', 'agy'), null, 'not agy vocabulary')
})

test('normalizeTerminalTitle collapses spinner frames to one stable string', () => {
  const frames = ['⠋ Claude', '⠙ Claude', '⠹ Claude', '⠸ Claude']
  const normalized = new Set(frames.map(normalizeTerminalTitle))
  assert.equal(normalized.size, 1, 'every spinner frame must normalize to one title')
  assert.equal(detectActivityFromTitle([...normalized][0]), 'working')
})

/* ── tracker edges ── */

test('the tracker fires only on change, and spinner frames are not changes', () => {
  const tracker = createTitleTracker('claude')
  assert.equal(tracker.handle('⠋ Claude'), 'working')
  assert.equal(tracker.handle('⠙ Claude'), null, 'an animation frame is not a transition')
  assert.equal(tracker.handle('⠹ Claude'), null)
  assert.equal(tracker.handle('✳ Claude'), 'idle')
  assert.equal(tracker.handle('✳ Claude'), null)
})

test('an unclassifiable title never overwrites a known activity', () => {
  const tracker = createTitleTracker('claude')
  assert.equal(tracker.handle('⠋ Claude'), 'working')
  assert.equal(tracker.handle('C:\\Projects\\morz'), null)
  assert.equal(tracker.current(), 'working', 'transient internal titles must not clear state')
  assert.equal(tracker.handle('Claude — action required'), 'waiting')
})

test('seed adopts an activity without reporting a transition', () => {
  const tracker = createTitleTracker('claude')
  tracker.seed('working')
  assert.equal(tracker.current(), 'working')
  assert.equal(tracker.handle('⠋ Claude'), null, 'already working — no duplicate event')
})
