/*
 * w6/runs e2e — the Orchestrator Runs tab hydrates dispatched teams, follows
 * run:changed pushes, and drives the real Stop + cleanup paths from the UI.
 * MORZ_DISPATCH_STUB leaves each agent as a plain shell (zero LLM cost).
 */
import { expect, test } from '@playwright/test'
import { execFileSync } from 'child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { closeMorz, launchMorz, ROOT } from './app'

process.env.MORZ_DISPATCH_STUB = '1'

interface AgentDetail {
  worktree: string | null
}

interface RunStatus {
  runId: string
  runTag?: string
  agentsDetail?: Record<string, AgentDetail>
}

interface MorzRunWindow {
  morz: {
    run: {
      approvePlan(plan: unknown): Promise<{ planHash: string }>
      dispatch(plan: unknown): Promise<{ runId: string }>
      listRuns(): Promise<{ runId: string }[]>
      runStatus(runId: string): Promise<RunStatus | null>
      stopRun(runId: string): Promise<RunStatus>
      cleanup(runId: string): Promise<RunStatus>
    }
  }
  morzRunHistory: {
    clearRun(runId: string): Promise<{ runId: string; hasWorktrees: boolean }>
    clearFinished(spaceRoot: string): Promise<{ runId: string }[]>
    applyPolicy(
      spaceRoot: string,
      policy: 'forever' | 'launch' | 'last-5'
    ): Promise<{ runId: string }[]>
  }
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim()
}

let planSequence = 0

function makePlan(
  spaceRoot: string,
  goal = 'monitor the live e2e team',
  agents: readonly ('alpha' | 'beta')[] = ['alpha', 'beta']
): unknown {
  const stamp = `${Date.now()}-${planSequence++}`
  const plannedAgents = agents.map((agentId, index) => ({
    agentId,
    cli: agentId === 'alpha' ? 'claude' : 'codex',
    role: index === 0 ? 'builder' : 'reviewer',
    branch: `run/runs-e2e-${stamp}/${agentId}`,
    worktree: null,
    cwd: '',
    promptSeed: index === 0 ? 'Build the feature.' : 'Review the feature.',
    dependsOn: index === 0 ? [] : [agents[index - 1]],
    port: null
  }))
  return {
    version: '1.0',
    id: `plan-runs-e2e-${stamp}`,
    goal,
    agents: plannedAgents,
    spaceRoot,
    caps: { maxUsd: null, maxTokens: null },
    createdAt: new Date().toISOString(),
    planHash: ''
  }
}

test('Runs tab stops a live team, clears history, and separately cleans worktrees', async () => {
  const fixtureParent = join(ROOT, 'e2e', '.tmp', `runs-${Date.now()}`)
  const spaceRoot = join(fixtureParent, 'space')
  mkdirSync(spaceRoot, { recursive: true })
  writeFileSync(join(spaceRoot, 'README.md'), '# runs fixture\n', 'utf8')
  git(spaceRoot, 'init', '-b', 'main')
  git(spaceRoot, 'config', 'user.name', 'Morz Runs Test')
  git(spaceRoot, 'config', 'user.email', 'runs-test@morz.invalid')
  git(spaceRoot, 'add', '-A')
  git(spaceRoot, 'commit', '-m', 'test: runs fixture')

  const { app, page } = await launchMorz()
  try {
    const plan = makePlan(spaceRoot)
    const { planHash } = await page.evaluate(
      (candidate) => (window as unknown as MorzRunWindow).morz.run.approvePlan(candidate),
      plan
    )
    const { runId } = await page.evaluate(
      (candidate) => (window as unknown as MorzRunWindow).morz.run.dispatch(candidate),
      { ...(plan as Record<string, unknown>), planHash }
    )
    const status = (await page.evaluate(
      (id) => (window as unknown as MorzRunWindow).morz.run.runStatus(id),
      runId
    ))!
    const worktrees = Object.values(status.agentsDetail!).map((detail) => detail.worktree!)
    expect(worktrees).toHaveLength(2)
    expect(worktrees.every(existsSync)).toBe(true)
    const keepForever = await page.evaluate(
      (root) => (window as unknown as MorzRunWindow).morzRunHistory.applyPolicy(root, 'forever'),
      spaceRoot
    )
    expect(keepForever).toEqual([])

    await page.getByRole('radio', { name: 'Orchestrated' }).click()
    await page.getByRole('tab', { name: 'Runs' }).click()

    await expect(page.getByRole('heading', { name: 'monitor the live e2e team' })).toBeVisible()
    const agents = page.getByTestId('run-agent')
    await expect(agents).toHaveCount(2)
    await expect(agents.filter({ hasText: 'alpha' })).toContainText('running')
    await expect(agents.filter({ hasText: 'beta' })).toContainText('running')

    page.once('dialog', (dialog) => dialog.accept())
    await page.getByRole('button', { name: 'Stop run' }).click()
    await expect(agents.filter({ hasText: 'alpha' })).toContainText('cancelled')
    await expect(agents.filter({ hasText: 'beta' })).toContainText('cancelled')

    page.once('dialog', (dialog) => dialog.accept())
    await page.getByRole('button', { name: 'Clear run' }).click()
    await expect(page.getByRole('heading', { name: 'monitor the live e2e team' })).not.toBeVisible()
    expect(worktrees.every(existsSync)).toBe(true)
    const listedAfterClear = await page.evaluate(
      () => (window as unknown as MorzRunWindow).morz.run.listRuns()
    )
    expect(listedAfterClear.some((run) => run.runId === runId)).toBe(false)
    const noFinishedLeft = await page.evaluate(
      (root) => (window as unknown as MorzRunWindow).morzRunHistory.clearFinished(root),
      spaceRoot
    )
    expect(noFinishedLeft).toEqual([])

    await page.evaluate(
      (id) => (window as unknown as MorzRunWindow).morz.run.cleanup(id),
      runId
    )
    expect(worktrees.every((path) => !existsSync(path))).toBe(true)
    expect(git(spaceRoot, 'worktree', 'list', '--porcelain').match(/^worktree /gm)).toHaveLength(1)
    expect(worktrees.every((path) => dirname(path) === fixtureParent)).toBe(true)
  } finally {
    await closeMorz(app)
    rmSync(fixtureParent, { recursive: true, force: true })
  }
})

test('history policy is transactional and scoped to one space', async () => {
  const fixtureParent = join(ROOT, 'e2e', '.tmp', `runs-policy-${Date.now()}`)
  const roots = [join(fixtureParent, 'space-a'), join(fixtureParent, 'space-b')]
  for (const root of roots) {
    mkdirSync(root, { recursive: true })
    writeFileSync(join(root, 'README.md'), `# ${root}\n`, 'utf8')
    git(root, 'init', '-b', 'main')
    git(root, 'config', 'user.name', 'Morz Runs Policy Test')
    git(root, 'config', 'user.email', 'runs-policy@morz.invalid')
    git(root, 'add', '-A')
    git(root, 'commit', '-m', 'test: runs policy fixture')
  }

  const { app, page } = await launchMorz()
  const runIds: string[] = []
  try {
    const dispatchStopped = async (root: string, goal: string): Promise<string> => {
      const plan = makePlan(root, goal, ['alpha'])
      const { planHash } = await page.evaluate(
        (candidate) => (window as unknown as MorzRunWindow).morz.run.approvePlan(candidate),
        plan
      )
      const { runId } = await page.evaluate(
        (candidate) => (window as unknown as MorzRunWindow).morz.run.dispatch(candidate),
        { ...(plan as Record<string, unknown>), planHash }
      )
      await page.evaluate(
        (id) => (window as unknown as MorzRunWindow).morz.run.stopRun(id),
        runId
      )
      runIds.push(runId)
      return runId
    }

    const spaceARuns: string[] = []
    for (let index = 0; index < 7; index++) {
      spaceARuns.push(await dispatchStopped(roots[0], `policy space A ${index}`))
    }
    const spaceBRun = await dispatchStopped(roots[1], 'policy space B')

    const clearedOld = await page.evaluate(
      ({ root }) =>
        (window as unknown as MorzRunWindow).morzRunHistory.applyPolicy(root, 'last-5'),
      { root: roots[0] }
    )
    expect(new Set(clearedOld.map((run) => run.runId))).toEqual(new Set(spaceARuns.slice(0, 2)))

    const visibleAfterLastFive = await page.evaluate(
      () => (window as unknown as MorzRunWindow).morz.run.listRuns()
    )
    expect(visibleAfterLastFive.map((run) => run.runId)).toEqual(
      expect.arrayContaining([...spaceARuns.slice(2), spaceBRun])
    )

    expect(
      await page.evaluate(
        ({ root }) =>
          (window as unknown as MorzRunWindow).morzRunHistory.applyPolicy(root, 'forever'),
        { root: roots[1] }
      )
    ).toEqual([])
    expect(
      await page.evaluate(
        ({ root }) =>
          (window as unknown as MorzRunWindow).morzRunHistory.applyPolicy(root, 'launch'),
        { root: roots[1] }
      )
    ).toEqual([expect.objectContaining({ runId: spaceBRun })])

    await expect(
      page.evaluate(
        ({ root }) =>
          (window as unknown as MorzRunWindow).morzRunHistory.applyPolicy(
            root,
            'invalid' as 'forever'
          ),
        { root: roots[0] }
      )
    ).rejects.toThrow(/must be forever, launch, or last-5/)
  } finally {
    for (const runId of runIds) {
      await page
        .evaluate((id) => (window as unknown as MorzRunWindow).morz.run.cleanup(id), runId)
        .catch(() => undefined)
    }
    await closeMorz(app)
    rmSync(fixtureParent, { recursive: true, force: true })
  }
})
