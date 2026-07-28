/*
 * w17/adapter-seam — the event mapper: PTY chunk → normalized events → run-store
 * lifecycle + metering. Deps are injected, so this exercises the real mapping
 * with no electron, no sqlite and no PTY.
 *
 * The harness models the ledger's real transition rules (running ⇄ blocked,
 * terminal states refuse), because several of these tests are about the bridge
 * reconciling against the ledger rather than trusting its own cache.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createPaneBridge, type PaneBridgeEvent } from './pane-bridge'
import type { TranscriptReader, TranscriptUsage } from './claude-usage'

const title = (text: string): string => `\x1b]2;${text}\x07`

/** Deferred transcript reader: the spec decides when each read resolves. */
function deferredReader(): {
  reader: TranscriptReader
  pending: ((usage: TranscriptUsage | null) => void)[]
} {
  const pending: ((usage: TranscriptUsage | null) => void)[] = []
  return {
    pending,
    reader: {
      read: () =>
        new Promise<TranscriptUsage | null>((resolve) => {
          pending.push(resolve)
        })
    }
  }
}

interface Harness {
  bridge: ReturnType<typeof createPaneBridge>
  events: PaneBridgeEvent[]
  states: string[]
  usage: { agentId: string; tokens: number }[]
  pushes: string[]
  /** Runs the bridge asked to durably mark as under-metered. */
  gaps: string[]
  reads: number
  ledger: Map<string, string>
  settle(): Promise<void>
}

/** `reads` supplies the usage for each successive read (past the end ⇒ null). */
function harness(
  reads: (TranscriptUsage | null)[] = [],
  reader?: TranscriptReader,
  opts: { finalizeTimeoutMs?: number } = {}
): Harness {
  const ledger = new Map<string, string>([['run-1/solo', 'running']])
  const h: Harness = {
    bridge: null as never,
    events: [],
    states: [],
    usage: [],
    pushes: [],
    gaps: [],
    reads: 0,
    ledger,
    settle: async () => {
      for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve))
    }
  }
  h.bridge = createPaneBridge({
    setAgentState: (runId, agentId, state) => {
      const key = `${runId}/${agentId}`
      const current = ledger.get(key)
      // the real store's guarded transition: only these edges exist
      const legal =
        (current === 'running' && state === 'blocked') ||
        (current === 'blocked' && state === 'running')
      if (!legal) throw new Error(`illegal agent transition: ${current} → ${state}`)
      ledger.set(key, state)
      h.states.push(state)
    },
    getAgentState: (runId, agentId) => ledger.get(`${runId}/${agentId}`) ?? null,
    trackUsage: (_runId, agentId, tokens) => h.usage.push({ agentId, tokens }),
    createUsageReader: () =>
      reader ?? {
        read: async () => {
          const next = reads[h.reads] ?? null
          h.reads += 1
          return next
        }
      },
    push: (runId) => h.pushes.push(runId),
    markMeteringGap: (runId) => h.gaps.push(runId),
    now: () => 1000,
    finalizeTimeoutMs: opts.finalizeTimeoutMs
  })
  h.bridge.onEvent((event) => h.events.push(event))
  return h
}

function register(h: Harness, worktree: string | null = 'C:\\wt\\solo'): void {
  h.bridge.registerPane({
    runId: 'run-1',
    agentId: 'solo',
    cli: 'claude',
    paneId: 'pane-1',
    worktree
  })
}

const activities = (h: Harness): string[] =>
  h.events.filter((e) => e.type === 'state').map((e) => (e as { activity: string }).activity)

/* ── mapping ── */

test('registering a pane emits spawn', () => {
  const h = harness()
  register(h)
  assert.deepEqual(h.events, [
    { type: 'spawn', runId: 'run-1', agentId: 'solo', cli: 'claude', paneId: 'pane-1', at: 1000 }
  ])
})

test('titles map to state events and drive the lifecycle', () => {
  const h = harness()
  register(h)
  h.bridge.observe('pane-1', title('⠋ Claude Code'))
  h.bridge.observe('pane-1', title('Claude — action required'))

  assert.deepEqual(activities(h), ['working', 'waiting'])
  assert.deepEqual(h.states, ['blocked'], 'already running — only the block is a change')
  assert.equal(h.ledger.get('run-1/solo'), 'blocked')
})

test('a shell title emits nothing — no agent, no guess', () => {
  const h = harness()
  register(h)
  h.bridge.observe('pane-1', title('C:\\Projects\\morz'))
  assert.deepEqual(activities(h), [])
  assert.equal(h.bridge.activity('run-1', 'solo'), null)
})

test('unknown panes are ignored — only dispatched panes are observed', () => {
  const h = harness()
  register(h)
  h.bridge.observe('some-other-pane', title('⠋ Claude Code'))
  assert.deepEqual(activities(h), [])
})

test('a rejected lifecycle transition never escapes the bridge', () => {
  const h = harness()
  register(h)
  h.ledger.set('run-1/solo', 'cancelled') // Stop won the race
  assert.doesNotThrow(() => h.bridge.observe('pane-1', title('Claude — action required')))
  assert.deepEqual(activities(h), ['waiting'], 'the observation still stands')
  assert.deepEqual(h.states, [], 'the ledger refused the write')
  assert.equal(h.ledger.get('run-1/solo'), 'cancelled', 'the terminal state is untouched')
})

/* ── the chip rides run:changed, so activity alone must push (round-2 #2) ── */

test('working → idle pushes even though the lifecycle row never moves', () => {
  const h = harness()
  register(h)
  h.bridge.observe('pane-1', title('⠋ Claude Code'))
  h.bridge.observe('pane-1', title('✳ Claude Code'))

  assert.deepEqual(h.states, [], 'neither transition writes to the ledger')
  assert.deepEqual(
    h.pushes,
    ['run-1', 'run-1'],
    'the renderer only ingests run:changed — no push means a frozen chip'
  )
})

test('an observation that changes nothing does not push', () => {
  const h = harness()
  register(h)
  h.bridge.observe('pane-1', title('⠋ Claude Code'))
  h.pushes.length = 0
  h.bridge.observe('pane-1', title('⠙ Claude Code')) // another spinner frame
  h.bridge.observe('pane-1', title('C:\\Projects\\morz')) // unclassifiable
  assert.deepEqual(h.pushes, [])
})

test('a refused ledger write still pushes, because the activity changed', () => {
  const h = harness()
  register(h)
  h.ledger.set('run-1/solo', 'cancelled')
  h.bridge.observe('pane-1', title('Claude — action required'))
  assert.deepEqual(h.pushes, ['run-1'], 'what the agent is doing is still news')
})

test('clearing activity at exit pushes, so a dead pane loses its chip', async () => {
  const h = harness()
  register(h)
  h.bridge.observe('pane-1', title('⠋ Claude Code'))
  h.pushes.length = 0

  h.bridge.paneExited('pane-1', 0)
  await h.settle()
  assert.deepEqual(h.pushes, ['run-1'])
})

/* ── waiting → idle must not strand the ledger (Codex finding 3) ── */

test('idle after waiting returns the agent to running', () => {
  const h = harness()
  register(h)
  h.bridge.observe('pane-1', title('Claude — action required'))
  assert.equal(h.ledger.get('run-1/solo'), 'blocked')

  // the owner DENIED the approval: the CLI is back at its prompt, not finished
  h.bridge.observe('pane-1', title('✳ Claude Code'))
  assert.equal(h.ledger.get('run-1/solo'), 'running', 'a denied approval must not strand blocked')
  assert.deepEqual(h.states, ['blocked', 'running'])
})

test('idle does NOT unblock a block the bridge did not apply', () => {
  const h = harness()
  register(h)
  h.ledger.set('run-1/solo', 'blocked') // blocked by something else entirely
  h.bridge.observe('pane-1', title('✳ Claude Code'))
  assert.equal(h.ledger.get('run-1/solo'), 'blocked', 'only our own block may be cleared')
  assert.deepEqual(h.states, [])
})

test('idle moves no lifecycle state when nothing was blocked — it is not completion', () => {
  const h = harness()
  register(h)
  h.bridge.observe('pane-1', title('⠋ Claude Code'))
  h.bridge.observe('pane-1', title('✳ Claude Code'))
  assert.equal(h.bridge.activity('run-1', 'solo'), 'idle')
  assert.equal(h.ledger.get('run-1/solo'), 'running')
  assert.deepEqual(h.states, [])
})

/* ── per-chunk coalescing (Codex finding 7) ── */

test('a working→idle pair inside ONE chunk is not collapsed', () => {
  const h = harness()
  register(h)
  h.bridge.observe('pane-1', `${title('⠋ Claude Code')}output${title('✳ Claude Code')}`)
  assert.deepEqual(activities(h), ['working', 'idle'])
})

test('spinner frames do not spam events', () => {
  const h = harness()
  register(h)
  for (const frame of ['⠋', '⠙', '⠹', '⠸', '⠼']) {
    h.bridge.observe('pane-1', title(`${frame} Claude Code`))
  }
  assert.equal(activities(h).length, 1)
})

test('thousands of titles in one chunk cost one ledger write and one push', () => {
  const h = harness()
  register(h)
  let chunk = ''
  for (let i = 0; i < 2000; i += 1) {
    chunk += title(i % 2 === 0 ? '⠋ Claude Code' : 'Claude — action required')
  }
  h.bridge.observe('pane-1', chunk)

  assert.equal(activities(h).length, 2000, 'every transition is still reported as an event')
  assert.ok(h.states.length <= 1, `expected at most one ledger write, got ${h.states.length}`)
  assert.ok(h.pushes.length <= 1, `expected at most one push, got ${h.pushes.length}`)
  assert.equal(h.ledger.get('run-1/solo'), 'blocked', 'the chunk still LANDS on the right state')
})

/* ── metering ── */

test('a turn ending reports the newly-seen tokens as a delta', async () => {
  const h = harness([{ inputTokens: 1200, outputTokens: 300 }])
  register(h)
  h.bridge.observe('pane-1', title('⠋ Claude Code'))
  assert.equal(h.reads, 0, 'no read while the agent is still working')

  h.bridge.observe('pane-1', title('✳ Claude Code'))
  await h.settle()
  assert.equal(h.reads, 1)
  assert.deepEqual(h.usage, [{ agentId: 'solo', tokens: 1500 }])
})

test('waiting also meters — the turn stopped, it just stopped on the owner', async () => {
  const h = harness([{ inputTokens: 10, outputTokens: 5 }])
  register(h)
  h.bridge.observe('pane-1', title('Claude — action required'))
  await h.settle()
  assert.deepEqual(h.usage, [{ agentId: 'solo', tokens: 15 }])
})

test('a turn ending mid-read is re-read, not dropped', async () => {
  const { reader, pending } = deferredReader()
  const h = harness([], reader)
  register(h)

  h.bridge.observe('pane-1', title('Claude — action required')) // read #1 starts
  await h.settle()
  assert.equal(pending.length, 1, 'exactly one read in flight')

  h.bridge.observe('pane-1', title('✳ Claude Code')) // arrives mid-read
  await h.settle()
  assert.equal(pending.length, 1, 'the second request must queue, not start a parallel read')

  pending[0]({ inputTokens: 100, outputTokens: 0 })
  await h.settle()
  assert.equal(pending.length, 2, 'the queued request runs once the first read finishes')

  pending[1]({ inputTokens: 7, outputTokens: 0 })
  await h.settle()
  assert.deepEqual(h.usage, [
    { agentId: 'solo', tokens: 100 },
    { agentId: 'solo', tokens: 7 }
  ])
})

test('an agent with no transcript reports no usage rather than zero', async () => {
  const h = harness([null])
  register(h)
  h.bridge.observe('pane-1', title('✳ Claude Code'))
  await h.settle()
  assert.equal(h.reads, 1)
  assert.deepEqual(h.usage, [])
})

test('an agent with no worktree is never read', async () => {
  const h = harness([{ inputTokens: 1, outputTokens: 1 }])
  register(h, null)
  h.bridge.observe('pane-1', title('✳ Claude Code'))
  await h.settle()
  assert.equal(h.reads, 0)
})

/* ── teardown (Codex finding 2) ── */

test('finalizeRun awaits a last read, so a run stopped mid-turn still meters', async () => {
  const h = harness([{ inputTokens: 900, outputTokens: 100 }])
  register(h)
  h.bridge.observe('pane-1', title('⠋ Claude Code')) // still WORKING — never metered yet
  assert.deepEqual(h.usage, [])

  await h.bridge.finalizeRun('run-1')
  assert.deepEqual(
    h.usage,
    [{ agentId: 'solo', tokens: 1000 }],
    'stopping a working agent must not report zero usage'
  )
})

test('finalizeRun drains a read that was already in flight', async () => {
  const { reader, pending } = deferredReader()
  const h = harness([], reader)
  register(h)
  h.bridge.observe('pane-1', title('✳ Claude Code'))
  await h.settle()
  assert.equal(pending.length, 1)

  const finalized = h.bridge.finalizeRun('run-1')
  pending[0]({ inputTokens: 5, outputTokens: 5 })
  await h.settle()
  pending[pending.length - 1]?.({ inputTokens: 2, outputTokens: 0 })
  await finalized

  assert.deepEqual(h.usage, [
    { agentId: 'solo', tokens: 10 },
    { agentId: 'solo', tokens: 2 }
  ])
})

test('pane exit clears activity, emits exit, and takes a final reading', async () => {
  const h = harness([{ inputTokens: 2, outputTokens: 3 }])
  register(h)
  h.bridge.observe('pane-1', title('⠋ Claude Code'))
  assert.equal(h.bridge.activity('run-1', 'solo'), 'working')

  h.bridge.paneExited('pane-1', 0)
  assert.equal(h.bridge.activity('run-1', 'solo'), null, 'a dead pane cannot still be working')
  await h.settle()

  assert.deepEqual(
    h.events.find((e) => e.type === 'exit'),
    {
      type: 'exit',
      runId: 'run-1',
      agentId: 'solo',
      code: 0,
      durationMs: 0,
      at: 1000
    }
  )
  assert.deepEqual(h.usage, [{ agentId: 'solo', tokens: 5 }])
})

test('observation stops after exit and after finalizeRun', async () => {
  const h = harness()
  register(h)
  h.bridge.paneExited('pane-1', 0)
  await h.settle()
  h.bridge.observe('pane-1', title('⠋ Claude Code'))
  assert.deepEqual(activities(h), [])

  register(h)
  await h.bridge.finalizeRun('run-1')
  h.bridge.observe('pane-1', title('⠋ Claude Code'))
  assert.deepEqual(activities(h), [])
})

/* ── a hung read must not deadlock Stop (round-2 #1) ── */

test('finalizeRun gives up on a hung read, reports the gap, and lets teardown proceed', async () => {
  // a reader that never resolves — a locked or stalled transcript file
  const h = harness([], { read: () => new Promise(() => undefined) }, { finalizeTimeoutMs: 30 })
  register(h)
  h.bridge.observe('pane-1', title('⠋ Claude Code'))

  const startedAt = Date.now()
  await h.bridge.finalizeRun('run-1') // used to hang forever
  const waited = Date.now() - startedAt

  assert.ok(waited < 2000, `teardown must not block on a hung read (waited ${waited}ms)`)
  assert.deepEqual(h.gaps, ['run-1'], 'the gap is recorded DURABLY, not in memory')
  const gap = h.events.find((e) => e.type === 'metering-gap')
  assert.ok(gap, 'the gap is reported, not silently swallowed')
  assert.equal((gap as { agentId: string }).agentId, 'solo')
})

test('a completed finalize never marks the run incomplete', async () => {
  const h = harness([{ inputTokens: 1, outputTokens: 1 }])
  register(h)
  await h.bridge.finalizeRun('run-1')
  assert.deepEqual(h.gaps, [])
  assert.deepEqual(h.events.filter((e) => e.type === 'metering-gap'), [])
})

test('a zero deadline abandons the read outright, without racing it', async () => {
  // Even a reader that would resolve immediately gets no time — a bound has to
  // be a bound, not a coin toss against however fast the disk happens to be.
  const h = harness([{ inputTokens: 5, outputTokens: 5 }], undefined, { finalizeTimeoutMs: 0 })
  register(h)
  await h.bridge.finalizeRun('run-1')
  assert.deepEqual(h.gaps, ['run-1'])
  assert.deepEqual(h.usage, [])
})

test('a timed-out finalize pushes even when the pane never showed activity', async () => {
  // A title-silent pane has no chip to clear, and its liveness watcher can
  // publish the terminal state before this deadline expires — so without this
  // push nothing ever carries `partial` to the renderer.
  const h = harness([], { read: () => new Promise(() => undefined) }, { finalizeTimeoutMs: 30 })
  register(h)
  assert.equal(h.bridge.activity('run-1', 'solo'), null, 'nothing was ever observed')
  h.pushes.length = 0

  await h.bridge.finalizeRun('run-1')
  assert.deepEqual(h.gaps, ['run-1'])
  assert.deepEqual(h.pushes, ['run-1'], 'the partial flag has to reach the UI')
})

test('a hung read that finally resolves cannot record usage after release', async () => {
  const { reader, pending } = deferredReader()
  const h = harness([], reader, { finalizeTimeoutMs: 30 })
  register(h)
  h.bridge.observe('pane-1', title('✳ Claude Code'))
  await h.settle()

  await h.bridge.finalizeRun('run-1')
  assert.deepEqual(h.gaps, ['run-1'])

  // the abandoned read completes long after teardown moved on
  for (const resolve of pending) resolve({ inputTokens: 500, outputTokens: 500 })
  await h.settle()
  assert.deepEqual(h.usage, [], 'a released pane records nothing, however late it answers')
})

test('a read resolving after release cannot touch the ledger', async () => {
  const { reader, pending } = deferredReader()
  const h = harness([], reader)
  register(h)
  h.bridge.observe('pane-1', title('✳ Claude Code'))
  await h.settle()

  const finalized = h.bridge.finalizeRun('run-1')
  pending[0]({ inputTokens: 4, outputTokens: 0 }) // the in-flight read completes
  await h.settle()
  pending[pending.length - 1]?.(null) // the guaranteed final read finds nothing
  await finalized

  const usageAfter = h.usage.length
  const pushesAfter = h.pushes.length
  // a straggler resolving now belongs to a released pane
  pending[pending.length - 1]?.({ inputTokens: 999, outputTokens: 999 })
  await h.settle()
  assert.equal(h.usage.length, usageAfter, 'a released pane must not record more usage')
  assert.equal(h.pushes.length, pushesAfter)
})
