import { expect, test } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { MemoryProposal } from '../src/shared/memory'
import {
  createMemoryLearner,
  detectCorrection,
  formatMemoryProposalNoticeDetail,
  parseDistillationOutput,
  type MemoryLearnerNotice
} from '../src/main/memory/learner'
import {
  createInMemoryMemoryPort,
  createMemorySessionPreamble,
  prependRenderedMemory,
  type MemoryPort
} from '../src/main/memory/learn-port'
import { closeMorz, launchMorz } from './app'

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim()
}

interface MemoryRunWindow {
  morz: {
    run: {
      approvePlan(plan: unknown): Promise<{ planHash: string }>
      dispatch(plan: unknown): Promise<{ runId: string }>
      runStatus(runId: string): Promise<{
        agentsDetail: Record<string, { worktree: string | null }>
      }>
      stopRun(runId: string): Promise<unknown>
      cleanup(runId: string): Promise<unknown>
    }
  }
}

function capturePort(proposals: MemoryProposal[]): MemoryPort {
  return {
    async propose(proposal) {
      proposals.push(proposal)
      return proposal
    },
    render() {
      return ''
    }
  }
}

test('two equivalent corrections stage one proposal with both evidence lines', async () => {
  const proposals: MemoryProposal[] = []
  const notices: MemoryLearnerNotice[] = []
  const learner = createMemoryLearner({
    port: capturePort(proposals),
    historyPath: null,
    distill: false,
    now: () => new Date('2026-07-15T12:00:00.000Z'),
    onProposal: (notice) => notices.push(notice)
  })

  await learner.observeTurn({ laneId: 'lane-a', role: 'assistant', text: 'I will use npm.' })
  await learner.observeTurn({ laneId: 'lane-a', role: 'user', text: 'No — use pnpm, not npm.' })
  expect(proposals).toHaveLength(0)

  await learner.observeTurn({
    laneId: 'lane-a',
    role: 'user',
    text: 'I told you: use pnpm instead of npm.'
  })

  expect(proposals).toHaveLength(1)
  expect(proposals[0]).toMatchObject({
    id: expect.stringMatching(/^learned-[a-f0-9]{16}$/),
    entry: {
      scope: 'global',
      kind: 'rule',
      origin: 'learned',
      enabled: true
    },
    evidence: ['No — use pnpm, not npm.', 'I told you: use pnpm instead of npm.'],
    state: 'pending'
  })
  expect(notices).toEqual([{ proposal: proposals[0] }])
})

test('different corrections do not stage a proposal', async () => {
  const proposals: MemoryProposal[] = []
  const learner = createMemoryLearner({
    port: capturePort(proposals),
    historyPath: null,
    distill: false
  })

  await learner.observeTurn({
    laneId: 'lane-a',
    role: 'user',
    text: 'Actually, run tests before committing.'
  })
  await learner.observeTurn({
    laneId: 'lane-a',
    role: 'user',
    text: 'Never commit secrets.'
  })

  expect(proposals).toHaveLength(0)
})

test('declarative correction cues do not become rules', async () => {
  const proposals: MemoryProposal[] = []
  const learner = createMemoryLearner({
    port: capturePort(proposals),
    historyPath: null,
    distill: false
  })

  await learner.observeTurn({
    laneId: 'lane-a',
    role: 'user',
    text: 'I told you about the test plan.'
  })
  await learner.observeTurn({
    laneId: 'lane-b',
    role: 'user',
    text: 'I told you about the test plan.'
  })

  expect(proposals).toHaveLength(0)
})

test('harmless imperative filler produces the same correction fingerprint', async () => {
  const proposals: MemoryProposal[] = []
  const learner = createMemoryLearner({
    port: capturePort(proposals),
    historyPath: null,
    distill: false
  })

  await learner.observeTurn({
    laneId: 'lane-a',
    role: 'user',
    text: 'Actually, run tests before committing.'
  })
  await learner.observeTurn({
    laneId: 'lane-b',
    role: 'user',
    text: 'I told you to run tests before committing.'
  })

  expect(proposals).toHaveLength(1)
  expect(proposals[0].evidence).toEqual([
    'Actually, run tests before committing.',
    'I told you to run tests before committing.'
  ])
})

test("apostrophized don't is recognized as a correction shape", () => {
  expect(detectCorrection("Don't use npm; use pnpm instead.")).toMatchObject({
    fingerprint: expect.stringMatching(/^[a-f0-9]{16}$/)
  })
})

test('distillation parser accepts direct fenced JSON from Claude CLI', () => {
  expect(parseDistillationOutput([
    '```json',
    '{"title":"Use pnpm, not npm","body":"Use pnpm for package operations."}',
    '```'
  ].join('\n'))).toEqual({
    title: 'Use pnpm, not npm',
    body: 'Use pnpm for package operations.'
  })
})

test('fingerprints persist across learner sessions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'morz-memory-learn-'))
  const historyPath = join(root, 'corrections.jsonl')
  const proposals: MemoryProposal[] = []
  try {
    const firstSession = createMemoryLearner({
      port: capturePort(proposals),
      historyPath,
      distill: false
    })
    await firstSession.observeTurn({
      laneId: 'lane-old',
      role: 'user',
      text: 'Always use pnpm instead of npm.'
    })

    const freshSession = createMemoryLearner({
      port: capturePort(proposals),
      historyPath,
      distill: false
    })
    await freshSession.observeTurn({
      laneId: 'lane-new',
      role: 'user',
      text: 'Use pnpm, not npm.'
    })

    expect(proposals).toHaveLength(1)
    expect(proposals[0].evidence).toEqual([
      'Always use pnpm instead of npm.',
      'Use pnpm, not npm.'
    ])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('approved stub memory reaches a new lane once and every dispatched seed', async () => {
  const port = createInMemoryMemoryPort()
  const proposal: MemoryProposal = {
    id: 'learned-pnpm',
    entry: {
      id: 'prefer-pnpm',
      scope: 'global',
      kind: 'rule',
      title: 'Use pnpm instead of npm',
      body: 'Use pnpm for installs and scripts in JavaScript projects.',
      origin: 'learned',
      enabled: true
    },
    evidence: ['Use pnpm.', 'I told you to use pnpm.'],
    ts: '2026-07-15T12:00:00.000Z',
    state: 'pending'
  }
  await port.propose(proposal)
  await port.resolveProposal(proposal.id, true)

  const injectLanePrompt = createMemorySessionPreamble(port, {
    projectRoot: 'C:\\Projects\\fixture',
    agentId: 'builder'
  })
  const first = injectLanePrompt('Build the feature.')
  const second = injectLanePrompt('Run the tests.')
  const injectResumedPrompt = createMemorySessionPreamble(port, {
    projectRoot: 'C:\\Projects\\fixture',
    agentId: 'builder'
  }, true)
  const resumed = injectResumedPrompt('Continue the session.')
  const dispatched = prependRenderedMemory(
    port,
    { projectRoot: 'C:\\Projects\\fixture', agentId: 'reviewer' },
    'Review the feature.'
  )

  expect(first).toContain('## How the user works')
  expect(first).toContain('Use pnpm instead of npm')
  expect(first).toContain('Build the feature.')
  expect(second).toBe('Run the tests.')
  expect(resumed).toBe('Continue the session.')
  expect(dispatched).toContain('Use pnpm instead of npm')
  expect(dispatched).toContain('Review the feature.')
  expect(port.renderCalls).toEqual([
    { projectRoot: 'C:\\Projects\\fixture', agentId: 'builder' },
    { projectRoot: 'C:\\Projects\\fixture', agentId: 'reviewer' }
  ])
})

test('proposal notice detail includes bounded rule and evidence context', () => {
  const proposal: MemoryProposal = {
    id: 'learned-notice',
    entry: {
      id: 'learned-notice',
      scope: 'global',
      kind: 'rule',
      title: 'Run tests before committing',
      body: 'Always run the relevant tests before creating a commit.',
      origin: 'learned',
      enabled: true
    },
    evidence: ['Actually, run tests before committing.', 'I told you to run tests before committing.'],
    ts: '2026-07-15T12:00:00.000Z',
    state: 'pending'
  }

  const detail = formatMemoryProposalNoticeDetail(proposal)
  expect(detail).toContain('Always run the relevant tests before creating a commit.')
  expect(detail).toContain('Actually, run tests before committing.')
  expect(detail).toContain('I told you to run tests before committing.')
  expect(detail.length).toBeLessThanOrEqual(600)
})

test('Claude spawn path prepends stub memory to only the first structured prompt', async () => {
  const root = await mkdtemp(join(tmpdir(), 'morz-memory-claude-stub-'))
  const capturePath = join(root, 'stdin.jsonl')
  const originalPath = process.env.PATH
  const originalStub = process.env.MORZ_MEMORY_STUB
  const originalCapture = process.env.MORZ_MEMORY_CAPTURE
  await writeFile(join(root, 'claude.cmd'), '@echo off\r\nnode "%~dp0claude-stub.cjs"\r\n', 'utf8')
  await writeFile(
    join(root, 'claude-stub.cjs'),
    [
      "const fs = require('fs')",
      "let input = ''",
      "let count = 0",
      "process.stdin.setEncoding('utf8')",
      "process.stdin.on('data', (chunk) => {",
      "  input += chunk",
      "  for (;;) {",
      "    const newline = input.indexOf('\\n')",
      "    if (newline < 0) break",
      "    const line = input.slice(0, newline)",
      "    input = input.slice(newline + 1)",
      "    fs.appendFileSync(process.env.MORZ_MEMORY_CAPTURE, line + '\\n', 'utf8')",
      "    count += 1",
      "    process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'stub-session', model: 'stub' }) + '\\n')",
      "    process.stdout.write(JSON.stringify({ type: 'result', total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 } }) + '\\n')",
      "    if (count === 2) setTimeout(() => process.exit(0), 50)",
      "  }",
      "})"
    ].join('\n'),
    'utf8'
  )

  process.env.PATH = `${root};${originalPath ?? ''}`
  process.env.MORZ_MEMORY_STUB = '1'
  process.env.MORZ_MEMORY_CAPTURE = capturePath

  const morz = await launchMorz()
  try {
    const { page } = morz
    await page.getByRole('radio', { name: 'Assisted' }).click()
    await page.locator('[aria-label="Start Claude here"]').first().click()
    const lane = page.locator('section[aria-label^="Claude lane"]')
    await lane.getByRole('tab', { name: 'Structured' }).click()
    const prompt = lane.getByPlaceholder(/Prompt Claude/)
    const capturedLines = async (): Promise<string[]> => {
      try {
        const raw = (await readFile(capturePath, 'utf8')).trim()
        return raw ? raw.split('\n') : []
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
        throw error
      }
    }

    await prompt.fill('Build the feature.')
    await lane.getByRole('button', { name: 'Send' }).click()
    await expect.poll(async () => (await capturedLines()).length).toBe(1)

    await prompt.fill('Run the tests.')
    await lane.getByRole('button', { name: 'Send' }).click()
    await expect.poll(async () => (await capturedLines()).length).toBe(2)

    const messages = (await capturedLines())
      .map((line) => JSON.parse(line) as { message: { content: Array<{ text: string }> } })
    expect(messages[0].message.content[0].text).toContain('Use pnpm instead of npm')
    expect(messages[0].message.content[0].text).toContain('Build the feature.')
    expect(messages[1].message.content[0].text).toBe('Run the tests.')
  } finally {
    await closeMorz(morz.app)
    if (originalPath === undefined) delete process.env.PATH
    else process.env.PATH = originalPath
    if (originalStub === undefined) delete process.env.MORZ_MEMORY_STUB
    else process.env.MORZ_MEMORY_STUB = originalStub
    if (originalCapture === undefined) delete process.env.MORZ_MEMORY_CAPTURE
    else process.env.MORZ_MEMORY_CAPTURE = originalCapture
    await rm(root, { recursive: true, force: true })
  }
})

test('dispatcher writes stub memory into each new agent promptSeed', async () => {
  const fixtureParent = await mkdtemp(join(tmpdir(), 'morz-memory-dispatch-'))
  const spaceRoot = join(fixtureParent, 'space')
  const originalStub = process.env.MORZ_DISPATCH_STUB
  const originalRender = process.env.MORZ_MEMORY_STUB
  await writeFile(join(fixtureParent, '.keep'), '', 'utf8')
  await mkdir(spaceRoot, { recursive: true })
  await writeFile(join(spaceRoot, 'README.md'), '# memory dispatch fixture\n', 'utf8')
  git(spaceRoot, 'init', '-b', 'main')
  git(spaceRoot, 'config', 'user.name', 'Morz Memory Test')
  git(spaceRoot, 'config', 'user.email', 'memory-test@morz.invalid')
  git(spaceRoot, 'add', '-A')
  git(spaceRoot, 'commit', '-m', 'test: memory dispatch fixture')
  process.env.MORZ_DISPATCH_STUB = '1'
  process.env.MORZ_MEMORY_STUB = '1'

  const morz = await launchMorz()
  let runId: string | null = null
  try {
    const plan = {
      version: '1.0',
      id: 'plan-memory-dispatch',
      goal: 'verify memory injection',
      agents: [{
        agentId: 'memory-builder',
        cli: 'claude',
        role: 'builder',
        branch: 'run/memory-builder',
        worktree: null,
        cwd: '',
        promptSeed: 'Build the feature.',
        dependsOn: [],
        port: null
      }],
      spaceRoot,
      caps: { maxUsd: null, maxTokens: null },
      createdAt: new Date().toISOString(),
      planHash: ''
    }
    const result = await morz.page.evaluate(
      (value) => (window as unknown as MemoryRunWindow).morz.run.approvePlan(value),
      plan
    )
    const dispatched = await morz.page.evaluate(
      (value) => (window as unknown as MemoryRunWindow).morz.run.dispatch(value),
      { ...plan, planHash: result.planHash }
    )
    runId = dispatched.runId
    const status = await morz.page.evaluate(
      (id) => (window as unknown as MemoryRunWindow).morz.run.runStatus(id),
      runId
    )
    const worktree = status.agentsDetail['memory-builder'].worktree as string
    const seed = await readFile(join(worktree, '.morz', 'kickoff.md'), 'utf8')
    expect(seed).toContain('Use pnpm instead of npm')
    expect(seed).toContain('Build the feature.')
  } finally {
    if (runId) {
      await morz.page.evaluate(
        (id) => (window as unknown as MemoryRunWindow).morz.run.stopRun(id),
        runId
      ).catch(() => undefined)
      await morz.page.evaluate(
        (id) => (window as unknown as MemoryRunWindow).morz.run.cleanup(id),
        runId
      ).catch(() => undefined)
    }
    await closeMorz(morz.app)
    if (originalStub === undefined) delete process.env.MORZ_DISPATCH_STUB
    else process.env.MORZ_DISPATCH_STUB = originalStub
    if (originalRender === undefined) delete process.env.MORZ_MEMORY_STUB
    else process.env.MORZ_MEMORY_STUB = originalRender
    await rm(fixtureParent, { recursive: true, force: true })
  }
})
