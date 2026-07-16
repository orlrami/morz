/*
 * w11/lanes-runs — live PTY CLI detection and dispatched-agent pills.
 * The copied Node executable is deliberately named claude.exe: it stays alive
 * as a harmless REPL while exercising the real PTY spawn journal and IPC path.
 */
import { expect, test } from '@playwright/test'
import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { execFileSync } from 'child_process'
import { join } from 'path'
import { closeMorz, launchMorz, ROOT } from './app'

process.env.MORZ_E2E = '1'
process.env.MORZ_DISPATCH_STUB = '1'

interface MorzLaneRunsWindow {
  morz: {
    pty: {
      spawn(options: {
        paneId: string
        shell: string
        cwd: string
        cols: number
        rows: number
      }): Promise<{ ok: boolean; error?: string }>
      kill(paneId: string): void
      list(): Promise<string[]>
    }
    run: {
      approvePlan(plan: unknown): Promise<{ planHash: string }>
      dispatch(plan: unknown): Promise<{ runId: string }>
      stopRun(runId: string): Promise<unknown>
      cleanup(runId: string): Promise<unknown>
    }
  }
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim()
}

function makePlan(spaceRoot: string): Record<string, unknown> {
  const stamp = Date.now()
  return {
    version: '1.0',
    id: `plan-lanes-runs-e2e-${stamp}`,
    goal: 'surface every active agent',
    agents: [
      {
        agentId: 'lane-builder',
        cli: 'claude',
        role: 'builder',
        branch: `run/lanes-runs-${stamp}/builder`,
        worktree: null,
        cwd: '',
        promptSeed: 'Build the feature.',
        dependsOn: [],
        port: null
      },
      {
        agentId: 'lane-reviewer',
        cli: 'codex',
        role: 'reviewer',
        branch: `run/lanes-runs-${stamp}/reviewer`,
        worktree: null,
        cwd: '',
        promptSeed: 'Review the feature.',
        dependsOn: [],
        port: null
      }
    ],
    spaceRoot,
    caps: { maxUsd: null, maxTokens: null },
    createdAt: new Date().toISOString(),
    planHash: ''
  }
}

test('pill bar shows CLI panes and dispatched agents but excludes plain shells', async () => {
  const fixtureParent = join(ROOT, 'e2e', '.tmp', `lanes-runs-${Date.now()}`)
  const spaceRoot = join(fixtureParent, 'space')
  const bin = join(fixtureParent, 'bin')
  const claudeExe = join(bin, 'claude.exe')
  mkdirSync(spaceRoot, { recursive: true })
  mkdirSync(bin, { recursive: true })
  copyFileSync(process.execPath, claudeExe)
  writeFileSync(join(spaceRoot, 'README.md'), '# lanes and runs fixture\n', 'utf8')
  git(spaceRoot, 'init', '-b', 'main')
  git(spaceRoot, 'config', 'user.name', 'Morz Lanes Runs Test')
  git(spaceRoot, 'config', 'user.email', 'lanes-runs-test@morz.invalid')
  git(spaceRoot, 'add', '-A')
  git(spaceRoot, 'commit', '-m', 'test: lanes and runs fixture')

  const { app, page } = await launchMorz()
  try {
    await expect(page.getByText(/No active/)).toBeVisible()
    await expect(page.getByTestId('agent-pill')).toHaveCount(0)

    const spawned = await page.evaluate(
      ({ shell, cwd }) =>
        (window as unknown as MorzLaneRunsWindow).morz.pty.spawn({
          paneId: 'cli-claude',
          shell,
          cwd,
          cols: 80,
          rows: 24
        }),
      { shell: claudeExe, cwd: spaceRoot }
    )
    expect(spawned.ok).toBe(true)

    const cliPane = page.getByTestId('agent-pill').filter({ hasText: 'cli-claude' })
    await expect(cliPane).toBeVisible()
    await expect(cliPane).toContainText('Claude')

    const plan = makePlan(spaceRoot)
    const { planHash } = await page.evaluate(
      (candidate) => (window as unknown as MorzLaneRunsWindow).morz.run.approvePlan(candidate),
      plan
    )
    const { runId } = await page.evaluate(
      (candidate) => (window as unknown as MorzLaneRunsWindow).morz.run.dispatch(candidate),
      { ...plan, planHash }
    )

    const builder = page.getByTestId('agent-pill').filter({ hasText: 'lane-builder' })
    const reviewer = page.getByTestId('agent-pill').filter({ hasText: 'lane-reviewer' })
    await expect(builder).toContainText('Claude')
    await expect(reviewer).toContainText('Codex')
    await expect(page.getByTestId('agent-pill')).toHaveCount(3)

    await page.getByRole('radio', { name: 'Orchestrated' }).click()
    await page.getByRole('tab', { name: 'Runs' }).click()
    await expect(page.getByRole('heading', { name: 'surface every active agent' })).toBeVisible()
    await expect(page.getByTestId('run-agent')).toHaveCount(2)

    expect(existsSync(spaceRoot)).toBe(true)
    await page.evaluate(
      async ({ id, paneId }) => {
        const api = (window as unknown as MorzLaneRunsWindow).morz
        await api.run.stopRun(id)
        await api.run.cleanup(id)
        api.pty.kill(paneId)
      },
      { id: runId, paneId: 'cli-claude' }
    )
    await expect
      .poll(() =>
        page.evaluate(() => (window as unknown as MorzLaneRunsWindow).morz.pty.list())
      )
      .not.toContain('cli-claude')
  } finally {
    await closeMorz(app)
    rmSync(fixtureParent, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  }
})
