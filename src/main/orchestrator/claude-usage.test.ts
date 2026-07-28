/*
 * w17/adapter-seam — transcript attribution and incremental accounting.
 *
 * These are regressions for the round-1 adversarial review. Metering used to
 * sum every JSONL in the slugged project directory and report a running TOTAL,
 * which meant: two different worktrees sharing a slug were added together, a
 * forked session's copied history was counted twice, and a read that came back
 * lower than the previous one was added again in full.
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

import { createTranscriptReader, projectSlug } from './claude-usage'

const root = mkdtempSync(join(tmpdir(), 'morz-usage-'))
after(() => rmSync(root, { recursive: true, force: true }))

let seq = 0

interface RecordOpts {
  cwd: string
  id?: string | null
  input?: number
  output?: number
  cacheCreate?: number
  cacheRead?: number
  timestamp?: string
  type?: string
}

function record(opts: RecordOpts): string {
  const usage: Record<string, number> = {}
  if (opts.input !== undefined) usage.input_tokens = opts.input
  if (opts.output !== undefined) usage.output_tokens = opts.output
  if (opts.cacheCreate !== undefined) usage.cache_creation_input_tokens = opts.cacheCreate
  if (opts.cacheRead !== undefined) usage.cache_read_input_tokens = opts.cacheRead
  const message: Record<string, unknown> = { usage }
  if (opts.id !== null) message.id = opts.id ?? `msg-${(seq += 1)}`
  return JSON.stringify({
    type: opts.type ?? 'assistant',
    cwd: opts.cwd,
    timestamp: opts.timestamp,
    message
  })
}

/** A real on-disk worktree plus its transcript file, under one fixture root. */
function fixture(name: string): { home: string; worktree: string; write(...lines: string[]): void } {
  const home = mkdtempSync(join(root, 'home-'))
  const worktree = join(home, 'wt', name)
  mkdirSync(worktree, { recursive: true })
  const dir = join(home, '.claude', 'projects', projectSlug(worktree))
  mkdirSync(dir, { recursive: true })
  return {
    home,
    worktree,
    write(...lines: string[]): void {
      writeFileSync(join(dir, 'session.jsonl'), lines.join('\n') + '\n', 'utf8')
    }
  }
}

test('counts input, output and BOTH cache fields, like the lane meter', async () => {
  const f = fixture('cache')
  f.write(record({ cwd: f.worktree, input: 100, output: 20, cacheCreate: 5, cacheRead: 400 }))
  const reader = createTranscriptReader({ worktree: f.worktree, root: f.home, since: 0 })

  assert.deepEqual(await reader.read(), { inputTokens: 505, outputTokens: 20 })
})

test('a second read returns null — a total is never re-reported', async () => {
  const f = fixture('delta')
  f.write(record({ cwd: f.worktree, input: 10, output: 1 }))
  const reader = createTranscriptReader({ worktree: f.worktree, root: f.home, since: 0 })

  assert.deepEqual(await reader.read(), { inputTokens: 10, outputTokens: 1 })
  assert.equal(await reader.read(), null, 'nothing new to report')
})

test('only NEW records are reported, as a delta', async () => {
  const f = fixture('incremental')
  const first = record({ cwd: f.worktree, input: 10, output: 1 })
  f.write(first)
  const reader = createTranscriptReader({ worktree: f.worktree, root: f.home, since: 0 })
  await reader.read()

  f.write(first, record({ cwd: f.worktree, input: 7, output: 2 }))
  assert.deepEqual(await reader.read(), { inputTokens: 7, outputTokens: 2 })
})

test('a transcript that reads SHORTER than before adds nothing', async () => {
  const f = fixture('shrink')
  const keep = record({ cwd: f.worktree, input: 50, output: 5 })
  f.write(keep, record({ cwd: f.worktree, input: 50, output: 5 }))
  const reader = createTranscriptReader({ worktree: f.worktree, root: f.home, since: 0 })
  assert.deepEqual(await reader.read(), { inputTokens: 100, outputTokens: 10 })

  f.write(keep) // rotated/truncated — the old code re-added the whole new total
  assert.equal(await reader.read(), null)
})

test('records from a colliding worktree slug are not counted', async () => {
  // `<home>/wt/foo-bar` and `<home>/wt/foo/bar` slug to the SAME directory name
  const home = mkdtempSync(join(root, 'home-'))
  const mine = join(home, 'wt', 'foo-bar')
  const other = join(home, 'wt', 'foo', 'bar')
  mkdirSync(mine, { recursive: true })
  mkdirSync(other, { recursive: true })
  assert.equal(projectSlug(mine), projectSlug(other), 'the slug collision is real')

  const dir = join(home, '.claude', 'projects', projectSlug(mine))
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'session.jsonl'),
    [
      record({ cwd: mine, input: 10, output: 1 }),
      record({ cwd: other, input: 999, output: 999 })
    ].join('\n') + '\n',
    'utf8'
  )

  const reader = createTranscriptReader({ worktree: mine, root: home, since: 0 })
  assert.deepEqual(
    await reader.read(),
    { inputTokens: 10, outputTokens: 1 },
    "the neighbour's tokens must not land on this agent"
  )
})

test('a forked session that copies history is not double-counted', async () => {
  const f = fixture('fork')
  const shared = record({ cwd: f.worktree, id: 'msg-shared', input: 30, output: 3 })
  const dir = join(f.home, '.claude', 'projects', projectSlug(f.worktree))
  writeFileSync(join(dir, 'original.jsonl'), shared + '\n', 'utf8')
  // the fork copies the same record verbatim, then adds its own
  writeFileSync(
    join(dir, 'forked.jsonl'),
    [shared, record({ cwd: f.worktree, id: 'msg-new', input: 4, output: 1 })].join('\n') + '\n',
    'utf8'
  )

  const reader = createTranscriptReader({ worktree: f.worktree, root: f.home, since: 0 })
  assert.deepEqual(
    await reader.read(),
    { inputTokens: 34, outputTokens: 4 },
    'the shared record counts once, not twice'
  )
})

test('records that cannot prove ownership or identity are skipped', async () => {
  const f = fixture('failclosed')
  f.write(
    JSON.stringify({ type: 'assistant', message: { usage: { input_tokens: 500 } } }), // no cwd
    record({ cwd: f.worktree, id: null, input: 500 }), // no id — cannot dedupe a fork
    record({ cwd: f.worktree, input: 1, output: 1, type: 'user' }), // not an assistant turn
    'not json at all',
    record({ cwd: f.worktree, input: 6, output: 2 }) // the only countable one
  )
  const reader = createTranscriptReader({ worktree: f.worktree, root: f.home, since: 0 })

  assert.deepEqual(await reader.read(), { inputTokens: 6, outputTokens: 2 })
})

test('records stamped before the run started belong to an earlier run', async () => {
  const f = fixture('since')
  f.write(
    record({ cwd: f.worktree, input: 900, timestamp: '2020-01-01T00:00:00.000Z' }),
    record({ cwd: f.worktree, input: 8, output: 2, timestamp: '2030-01-01T00:00:00.000Z' })
  )
  const reader = createTranscriptReader({
    worktree: f.worktree,
    root: f.home,
    since: Date.parse('2025-01-01T00:00:00.000Z')
  })

  assert.deepEqual(await reader.read(), { inputTokens: 8, outputTokens: 2 })
})

test('no transcript directory reports null, not zero', async () => {
  const home = mkdtempSync(join(root, 'home-'))
  const worktree = join(home, 'wt', 'absent')
  mkdirSync(worktree, { recursive: true })
  const reader = createTranscriptReader({ worktree, root: home, since: 0 })

  assert.equal(await reader.read(), null)
})
