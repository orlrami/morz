/*
 * w17/context-blocks — the clean-tree gate.
 *
 * WAVE17 decision: launch injection NEVER writes files. Memory reaches agents
 * in-memory through the preamble path; rendering into CLAUDE.md / AGENTS.md /
 * GEMINI.md happens ONLY through an approved context-hub proposal. This spec is
 * the regression for the kickoff-leak class (ORCH-AUDIT HIGH, bit us live on
 * 2026-07-22): with real approved memory in the store, launching a team leaves
 * `git status --porcelain` EMPTY in every worktree and in the space itself.
 *
 * It must fail the moment anyone adds a launch-time file write.
 *
 * MORZ_DISPATCH_STUB=1 — no CLI is launched, no LLM cost. The memory render is
 * REAL (no MORZ_MEMORY_STUB) so the injection path under test is the shipped one.
 */
import { expect, test } from '@playwright/test'
import { execFileSync, spawnSync } from 'child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { closeMorz, launchMorz, ROOT } from './app'

interface CleanTreeWindow {
  morz: {
    memory: { save(entry: unknown): Promise<unknown> }
    claude: {
      start(opts: { agentId: string; cwd: string }): Promise<{ agentId: string }>
      send(agentId: string, text: string): void
    }
    run: {
      approvePlan(plan: unknown): Promise<{ planHash: string }>
      dispatch(plan: unknown): Promise<{ runId: string }>
      runStatus(runId: string): Promise<{
        state: string
        agentsDetail: Record<string, { worktree: string | null }>
      } | null>
      stopRun(runId: string): Promise<unknown>
      cleanup(runId: string): Promise<unknown>
    }
  }
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim()
}

function removeFixture(path: string): void {
  try {
    rmSync(path, { recursive: true, force: true, maxRetries: 15, retryDelay: 300 })
  } catch {
    spawnSync(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-Command',
        `Remove-Item -Force -Recurse -Path '${path}' -ErrorAction SilentlyContinue`],
      { windowsHide: true, timeout: 30_000 }
    )
  }
}

test('launching a team never dirties a worktree — memory reaches agents in memory only', async () => {
  const fixtureParent = join(ROOT, 'e2e', '.tmp', `clean-tree-${Date.now()}`)
  const spaceRoot = join(fixtureParent, 'space')
  mkdirSync(spaceRoot, { recursive: true })
  writeFileSync(join(spaceRoot, 'README.md'), '# clean-tree fixture\n', 'utf8')
  git(spaceRoot, 'init', '-b', 'main')
  git(spaceRoot, 'config', 'user.name', 'Morz CleanTree Test')
  git(spaceRoot, 'config', 'user.email', 'clean-tree@morz.invalid')
  git(spaceRoot, 'add', '-A')
  git(spaceRoot, 'commit', '-m', 'test: clean-tree fixture')
  expect(git(spaceRoot, 'status', '--porcelain')).toBe('')

  process.env.MORZ_E2E = '1'
  process.env.MORZ_DISPATCH_STUB = '1'
  const { app, page } = await launchMorz()
  delete process.env.MORZ_DISPATCH_STUB

  let runId: string | null = null
  try {
    // Real, approved memory in every scope the launch path reads.
    await page.evaluate(async (root: string) => {
      const now = '2026-07-27T12:00:00.000Z'
      const base = { origin: 'user' as const, kind: 'rule' as const, createdAt: now, updatedAt: now, enabled: true }
      const memory = (window as unknown as CleanTreeWindow).morz.memory
      await memory.save({ ...base, id: 'clean-tree-global', scope: 'global', title: 'Ship small diffs', body: 'One change per commit.' })
      await memory.save({ ...base, id: 'clean-tree-project', scope: 'project', scopeRef: root, title: 'Run targeted tests', body: 'Narrow first.' })
    }, spaceRoot)

    const plan = {
      version: '1.0',
      id: 'plan-clean-tree',
      goal: 'clean tree regression',
      agents: [{
        agentId: 'builder',
        cli: 'claude',
        role: 'builder',
        branch: 'run/clean-tree/builder',
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

    const { planHash } = await page.evaluate(
      (value) => (window as unknown as CleanTreeWindow).morz.run.approvePlan(value),
      plan
    )
    const dispatched = await page.evaluate(
      (value) => (window as unknown as CleanTreeWindow).morz.run.dispatch(value),
      { ...plan, planHash }
    )
    runId = dispatched.runId
    const status = (await page.evaluate(
      (id) => (window as unknown as CleanTreeWindow).morz.run.runStatus(id),
      runId
    ))!
    expect(status.state).toBe('running')

    const worktree = status.agentsDetail.builder.worktree!
    // The seed the CLI reads exists and carries the memory — in the worktree's
    // excluded .morz/ directory, never as a tracked or untracked project file.
    const seed = readFileSync(join(worktree, '.morz', 'kickoff.md'), 'utf8')
    expect(seed).toContain('Ship small diffs')
    expect(seed).toContain('Build the feature.')

    // ── the gate ──
    expect(git(worktree, 'status', '--porcelain')).toBe('')
    expect(git(spaceRoot, 'status', '--porcelain')).toBe('')

    // and no context file was materialized behind the user's back
    for (const name of ['CLAUDE.md', 'AGENTS.md', 'GEMINI.md']) {
      expect(existsSync(join(worktree, name))).toBe(false)
      expect(existsSync(join(spaceRoot, name))).toBe(false)
    }
  } finally {
    if (runId) {
      await page.evaluate(
        (id) => (window as unknown as CleanTreeWindow).morz.run.stopRun(id),
        runId
      ).catch(() => undefined)
      await page.evaluate(
        (id) => (window as unknown as CleanTreeWindow).morz.run.cleanup(id),
        runId
      ).catch(() => undefined)
    }
    await closeMorz(app)
    delete process.env.MORZ_E2E
    removeFixture(fixtureParent)
  }
})

/*
 * The other half of the gate (Codex round-1): a standalone Claude LANE renders
 * its memory preamble in src/main/adapters/claude.ts, a completely different
 * path from dispatcher kickoff. A launch-time write added there would sail past
 * the dispatcher test above, so the lane gets its own worktree and its own
 * clean-tree assertion — with a fake `claude` on PATH so the lane really runs.
 */
test('starting a lane in a worktree never dirties it — the adapter writes no context files', async () => {
  const fixtureParent = join(ROOT, 'e2e', '.tmp', `clean-tree-lane-${Date.now()}`)
  const spaceRoot = join(fixtureParent, 'space')
  const binDir = join(fixtureParent, 'bin')
  mkdirSync(spaceRoot, { recursive: true })
  mkdirSync(binDir, { recursive: true })
  writeFileSync(join(spaceRoot, 'README.md'), '# clean-tree lane fixture\n', 'utf8')
  git(spaceRoot, 'init', '-b', 'main')
  git(spaceRoot, 'config', 'user.name', 'Morz CleanTree Lane Test')
  git(spaceRoot, 'config', 'user.email', 'clean-tree-lane@morz.invalid')
  git(spaceRoot, 'add', '-A')
  git(spaceRoot, 'commit', '-m', 'test: clean-tree lane fixture')

  // a linked worktree, exactly where a lane would be opened
  const worktree = join(fixtureParent, 'lane-worktree')
  git(spaceRoot, 'worktree', 'add', worktree, '-b', 'lane/clean-tree')
  expect(git(worktree, 'status', '--porcelain')).toBe('')

  // a fake `claude` that just holds stdin open: the adapter spawns it, renders
  // the preamble, and writes the first prompt to it — no LLM, no cost.
  writeFileSync(
    join(binDir, 'claude.cmd'),
    '@echo off\r\nnode -e "process.stdin.resume()"\r\n',
    'utf8'
  )
  const pathKey = Object.keys(process.env).find((key) => key.toUpperCase() === 'PATH') ?? 'PATH'

  process.env.MORZ_E2E = '1'
  const { app, page } = await launchMorz({
    env: { [pathKey]: `${binDir};${process.env[pathKey] ?? ''}` }
  })

  try {
    await page.evaluate(async (root: string) => {
      const now = '2026-07-27T12:00:00.000Z'
      const base = { origin: 'user' as const, kind: 'rule' as const, createdAt: now, updatedAt: now, enabled: true }
      const memory = (window as unknown as CleanTreeWindow).morz.memory
      await memory.save({ ...base, id: 'lane-global-rule', scope: 'global', title: 'Ship small diffs', body: 'One change per commit.' })
      await memory.save({ ...base, id: 'lane-project-rule', scope: 'project', scopeRef: root, title: 'Run targeted tests', body: 'Narrow first.' })
    }, worktree)

    await page.evaluate(
      (cwd) =>
        (window as unknown as CleanTreeWindow).morz.claude.start({ agentId: 'clean-tree-lane', cwd }),
      worktree
    )
    // the preamble is joined onto the FIRST prompt — exercise that path too
    await page.evaluate(() =>
      (window as unknown as CleanTreeWindow).morz.claude.send('clean-tree-lane', 'Start the work.')
    )
    await page.waitForTimeout(1_500)

    // the lane genuinely spawned; without this the gate could pass vacuously
    // on a lane that never started
    const spawnArgs = await page.evaluate(() =>
      (window as unknown as { morzModels: { testLaneSpawnArgs(): Promise<string[] | null> } })
        .morzModels.testLaneSpawnArgs()
    )
    expect(spawnArgs).not.toBeNull()

    // ── the gate ──
    expect(git(worktree, 'status', '--porcelain')).toBe('')
    expect(git(spaceRoot, 'status', '--porcelain')).toBe('')
    for (const name of ['CLAUDE.md', 'AGENTS.md', 'GEMINI.md']) {
      expect(existsSync(join(worktree, name))).toBe(false)
      expect(existsSync(join(spaceRoot, name))).toBe(false)
    }
  } finally {
    await closeMorz(app)
    delete process.env.MORZ_E2E
    removeFixture(fixtureParent)
  }
})
