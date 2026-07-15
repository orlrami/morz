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
      runStatus(runId: string): Promise<RunStatus | null>
    }
  }
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim()
}

function makePlan(spaceRoot: string): unknown {
  const stamp = Date.now()
  return {
    version: '1.0',
    id: `plan-runs-e2e-${stamp}`,
    goal: 'monitor the live e2e team',
    agents: [
      {
        agentId: 'alpha',
        cli: 'claude',
        role: 'builder',
        branch: `run/runs-e2e-${stamp}/alpha`,
        worktree: null,
        cwd: '',
        promptSeed: 'Build the feature.',
        dependsOn: [],
        port: null
      },
      {
        agentId: 'beta',
        cli: 'codex',
        role: 'reviewer',
        branch: `run/runs-e2e-${stamp}/beta`,
        worktree: null,
        cwd: '',
        promptSeed: 'Review the feature.',
        dependsOn: ['alpha'],
        port: null
      }
    ],
    spaceRoot,
    caps: { maxUsd: null, maxTokens: null },
    createdAt: new Date().toISOString(),
    planHash: ''
  }
}

test('Runs tab stops a live 2-agent team and cleans up its worktrees', async () => {
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
    await page.getByRole('button', { name: 'Cleanup run' }).click()
    await expect(page.getByText('Worktrees cleaned')).toBeVisible()
    expect(worktrees.every((path) => !existsSync(path))).toBe(true)
    expect(git(spaceRoot, 'worktree', 'list', '--porcelain').match(/^worktree /gm)).toHaveLength(1)
    expect(worktrees.every((path) => dirname(path) === fixtureParent)).toBe(true)
  } finally {
    await closeMorz(app)
    rmSync(fixtureParent, { recursive: true, force: true })
  }
})
