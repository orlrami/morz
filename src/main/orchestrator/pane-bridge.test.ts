/*
 * w17/adapter-seam — the event mapper: PTY chunk → normalized events → run-store
 * lifecycle + metering. Deps are injected, so this exercises the real mapping
 * with no electron, no sqlite and no PTY.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createPaneBridge, type PaneBridgeEvent } from './pane-bridge'
import type { TranscriptUsage } from './claude-usage'

const title = (text: string): string => `\x1b]2;${text}\x07`

interface Harness {
  bridge: ReturnType<typeof createPaneBridge>
  events: PaneBridgeEvent[]
  states: { runId: string; agentId: string; state: string }[]
  usage: { runId: string; agentId: string; tokens: number }[]
  pushes: string[]
  scans: string[]
  setStateError: Error | null
  settle(): Promise<void>
}

function harness(transcript: TranscriptUsage | null = null): Harness {
  const h: Harness = {
    bridge: null as never,
    events: [],
    states: [],
    usage: [],
    pushes: [],
    scans: [],
    setStateError: null,
    settle: () => new Promise((resolve) => setImmediate(resolve))
  }
  h.bridge = createPaneBridge({
    setAgentState: (runId, agentId, state) => {
      if (h.setStateError) throw h.setStateError
      h.states.push({ runId, agentId, state })
    },
    trackUsage: (runId, agentId, tokens) => h.usage.push({ runId, agentId, tokens }),
    scanUsage: async (worktree) => {
      h.scans.push(worktree)
      return transcript
    },
    push: (runId) => h.pushes.push(runId),
    now: () => 1000
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

  assert.deepEqual(
    h.events.filter((e) => e.type === 'state').map((e) => (e as { activity: string }).activity),
    ['working', 'waiting']
  )
  assert.deepEqual(h.states, [
    { runId: 'run-1', agentId: 'solo', state: 'running' },
    { runId: 'run-1', agentId: 'solo', state: 'blocked' }
  ])
  assert.deepEqual(h.pushes, ['run-1', 'run-1'], 'each lifecycle change refreshes the UI')
})

test('idle moves no lifecycle state — it is not completion', () => {
  const h = harness()
  register(h)
  h.bridge.observe('pane-1', title('⠋ Claude Code'))
  h.states.length = 0
  h.bridge.observe('pane-1', title('✳ Claude Code'))

  assert.equal(h.bridge.activity('run-1', 'solo'), 'idle')
  assert.deepEqual(h.states, [], 'idle must never transition the agent')
})

test('a working→idle pair inside ONE chunk is not collapsed', () => {
  const h = harness()
  register(h)
  h.bridge.observe('pane-1', `${title('⠋ Claude Code')}output${title('✳ Claude Code')}`)
  assert.deepEqual(
    h.events.filter((e) => e.type === 'state').map((e) => (e as { activity: string }).activity),
    ['working', 'idle']
  )
})

test('spinner frames do not spam events', () => {
  const h = harness()
  register(h)
  for (const frame of ['⠋', '⠙', '⠹', '⠸', '⠼']) {
    h.bridge.observe('pane-1', title(`${frame} Claude Code`))
  }
  assert.equal(h.events.filter((e) => e.type === 'state').length, 1)
})

test('a shell title emits nothing — no agent, no guess', () => {
  const h = harness()
  register(h)
  h.bridge.observe('pane-1', title('C:\\Projects\\morz'))
  assert.deepEqual(h.events.filter((e) => e.type === 'state'), [])
  assert.equal(h.bridge.activity('run-1', 'solo'), null)
})

test('unknown panes are ignored — only dispatched panes are observed', () => {
  const h = harness()
  register(h)
  h.bridge.observe('some-other-pane', title('⠋ Claude Code'))
  assert.deepEqual(h.events.filter((e) => e.type === 'state'), [])
})

test('a rejected lifecycle transition never escapes the bridge', () => {
  const h = harness()
  register(h)
  h.setStateError = new Error('[dispatch] illegal agent transition: cancelled → running')
  assert.doesNotThrow(() => h.bridge.observe('pane-1', title('⠋ Claude Code')))
  assert.equal(
    h.events.filter((e) => e.type === 'state').length,
    1,
    'the observation still stands even when the ledger refuses it'
  )
  assert.deepEqual(h.pushes, [], 'a refused transition pushes nothing')
})

/* ── metering ── */

test('a turn ending triggers one cumulative usage sample', async () => {
  const h = harness({ inputTokens: 1200, outputTokens: 300 })
  register(h)
  h.bridge.observe('pane-1', title('⠋ Claude Code'))
  assert.deepEqual(h.scans, [], 'no scan while the agent is still working')

  h.bridge.observe('pane-1', title('✳ Claude Code'))
  await h.settle()
  assert.deepEqual(h.scans, ['C:\\wt\\solo'])
  assert.deepEqual(h.usage, [{ runId: 'run-1', agentId: 'solo', tokens: 1500 }])
})

test('waiting also meters — the turn stopped, it just stopped on the owner', async () => {
  const h = harness({ inputTokens: 10, outputTokens: 5 })
  register(h)
  h.bridge.observe('pane-1', title('Claude — action required'))
  await h.settle()
  assert.deepEqual(h.usage, [{ runId: 'run-1', agentId: 'solo', tokens: 15 }])
})

test('an agent with no transcript reports no usage rather than zero', async () => {
  const h = harness(null)
  register(h)
  h.bridge.observe('pane-1', title('✳ Claude Code'))
  await h.settle()
  assert.deepEqual(h.scans, ['C:\\wt\\solo'])
  assert.deepEqual(h.usage, [], 'null transcript must not be reported as 0 tokens')
})

test('an agent with no worktree is never scanned', async () => {
  const h = harness({ inputTokens: 1, outputTokens: 1 })
  register(h, null)
  h.bridge.observe('pane-1', title('✳ Claude Code'))
  await h.settle()
  assert.deepEqual(h.scans, [])
})

/* ── exit ── */

test('pane exit meters once more, clears activity and emits exit', async () => {
  const h = harness({ inputTokens: 2, outputTokens: 3 })
  register(h)
  h.bridge.observe('pane-1', title('⠋ Claude Code'))
  assert.equal(h.bridge.activity('run-1', 'solo'), 'working')

  h.bridge.paneExited('pane-1', 0)
  await h.settle()

  assert.equal(h.bridge.activity('run-1', 'solo'), null, 'a dead pane cannot still be working')
  const exit = h.events.find((e) => e.type === 'exit')
  assert.deepEqual(exit, {
    type: 'exit',
    runId: 'run-1',
    agentId: 'solo',
    code: 0,
    durationMs: 0,
    at: 1000
  })
  assert.deepEqual(h.usage, [{ runId: 'run-1', agentId: 'solo', tokens: 5 }])
})

test('observation stops after exit and after releaseRun', () => {
  const h = harness()
  register(h)
  h.bridge.paneExited('pane-1', 0)
  h.bridge.observe('pane-1', title('⠋ Claude Code'))
  assert.deepEqual(h.events.filter((e) => e.type === 'state'), [])

  register(h)
  h.bridge.releaseRun('run-1')
  h.bridge.observe('pane-1', title('⠋ Claude Code'))
  assert.deepEqual(h.events.filter((e) => e.type === 'state'), [])
})
