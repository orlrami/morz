/*
 * w17/adapter-seam — the pure half of the bridge: OSC title extraction and the
 * title → activity classifier. Every case here is a trap the design doc calls
 * out (docs/in-progress/SEAM-DESIGN.md); if one of these regresses the seam
 * starts inventing agent states from ordinary shell output.
 *
 * Unit tests live under src/main by repo convention (src/shared is compiled by
 * the web tsconfig, which has no node types).
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createOscTitleScanner, MAX_TITLE_CHARS, scanOscTitles } from '../../shared/osc-title'
import {
  createTitleTracker,
  detectActivityFromTitle,
  normalizeTerminalTitle
} from '../../shared/agent-title-status'

/* ── OSC extraction ── */

test('extracts titles for OSC 0, 1 and 2, terminated by BEL or ST', () => {
  assert.deepEqual(scanOscTitles('\x1b]0;window\x07').titles, ['window'])
  assert.deepEqual(scanOscTitles('\x1b]1;icon\x07').titles, ['icon'])
  assert.deepEqual(scanOscTitles('\x1b]2;title\x1b\\').titles, ['title'])
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

test('over-long titles keep head AND tail — the trailing status word is the signal', () => {
  const long = `${'x'.repeat(4000)} Claude ready`
  const [title] = scanOscTitles(`\x1b]2;${long}\x07`).titles
  assert.equal(title.length, MAX_TITLE_CHARS)
  assert.ok(title.endsWith('Claude ready'), 'tail must survive truncation')
  assert.equal(detectActivityFromTitle(title), 'idle')
})

test('an unterminated sequence larger than the pending bound is dropped, not buffered', () => {
  const { titles, pending } = scanOscTitles(`\x1b]2;${'x'.repeat(70_000)}`)
  assert.deepEqual(titles, [])
  assert.equal(pending, '')
})

test('a megabyte paste with no titles yields nothing and terminates', () => {
  const paste = 'a'.repeat(1_000_000)
  assert.deepEqual(scanOscTitles(paste).titles, [])
})

/* ── classification ── */

test('agent glyphs classify structurally', () => {
  assert.equal(detectActivityFromTitle('✳ Claude Code'), 'idle')
  assert.equal(detectActivityFromTitle('⠋ Claude Code'), 'working')
  assert.equal(detectActivityFromTitle('✋ Gemini CLI'), 'waiting')
  assert.equal(detectActivityFromTitle('✦ Gemini CLI'), 'working')
  assert.equal(detectActivityFromTitle('◇ Gemini CLI'), 'idle')
})

test('a title with no agent token is not agent state', () => {
  assert.equal(detectActivityFromTitle('C:\\Projects\\morz'), null)
  assert.equal(detectActivityFromTitle('npm run build'), null)
  assert.equal(detectActivityFromTitle(''), null)
  assert.equal(detectActivityFromTitle('   '), null)
})

test('paths and hyphenated tokens never read as working or waiting — the boundary guard', () => {
  // These state words sit inside paths and compounds. Under a plain \b boundary
  // each would classify as working/waiting and move the agent's lifecycle state;
  // with the path-aware guard they fall through to the least-committal default.
  assert.equal(detectActivityFromTitle('claude ~/src/working'), 'idle')
  assert.equal(detectActivityFromTitle('codex run-permission-fix'), 'idle')
  assert.equal(detectActivityFromTitle('claude C:\\work\\thinking-cap'), 'idle')
  // the same words standing alone still classify
  assert.equal(detectActivityFromTitle('claude working'), 'working')
  assert.equal(detectActivityFromTitle('codex permission'), 'waiting')
})

test('the default for an agent-named title is idle — never working or waiting', () => {
  // A cwd title that happens to contain an agent name reaches the default. idle
  // is safe: it moves no lifecycle state. Guessing working/waiting would not be.
  assert.equal(detectActivityFromTitle('~/projects/codex-tools'), 'idle')
  assert.equal(detectActivityFromTitle('git log — claude-seam'), 'idle')
})

test('permission wording is waiting, not working', () => {
  assert.equal(detectActivityFromTitle('Claude — action required'), 'waiting')
  assert.equal(detectActivityFromTitle('codex: permission'), 'waiting')
})

test("Claude Code's own prefix conventions classify", () => {
  assert.equal(detectActivityFromTitle('. claude refactoring the store'), 'working')
  assert.equal(detectActivityFromTitle('* claude'), 'idle')
})

test('normalizeTerminalTitle collapses spinner frames to one stable string', () => {
  const frames = ['⠋ Claude', '⠙ Claude', '⠹ Claude', '⠸ Claude']
  const normalized = new Set(frames.map(normalizeTerminalTitle))
  assert.equal(normalized.size, 1, 'every spinner frame must normalize to one title')
  assert.equal(detectActivityFromTitle([...normalized][0]), 'working')
})

/* ── tracker edges ── */

test('the tracker fires only on change, and spinner frames are not changes', () => {
  const tracker = createTitleTracker()
  assert.equal(tracker.handle('⠋ Claude'), 'working')
  assert.equal(tracker.handle('⠙ Claude'), null, 'animation frame is not a transition')
  assert.equal(tracker.handle('⠹ Claude'), null)
  assert.equal(tracker.handle('✳ Claude'), 'idle')
  assert.equal(tracker.handle('✳ Claude'), null)
})

test('an unclassifiable title never overwrites a known activity', () => {
  const tracker = createTitleTracker()
  assert.equal(tracker.handle('⠋ Claude'), 'working')
  assert.equal(tracker.handle('C:\\Projects\\morz'), null)
  assert.equal(tracker.current(), 'working', 'transient internal titles must not clear state')
  assert.equal(tracker.handle('Claude — action required'), 'waiting')
})

test('seed adopts an activity without reporting a transition', () => {
  const tracker = createTitleTracker()
  tracker.seed('working')
  assert.equal(tracker.current(), 'working')
  assert.equal(tracker.handle('⠋ Claude'), null, 'already working — no duplicate event')
})
