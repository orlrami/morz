/*
 * Live orchestrator proof. This is intentionally absent from normal CI runs:
 * it spends real Claude/Codex tokens and drives the user's logged-in CLIs.
 *
 *   $env:MORZ_LIVE_ORCH='1'
 *   npx playwright test e2e/orch-e2e.spec.ts
 */
import { expect, test } from '@playwright/test'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type {
  CommitBridge,
  MorzRunApi,
  PaneInfoBridge,
  PlannerBridge,
  ReviewerBridge,
  RunSummary,
  StoredSpawnPlan
} from '../src/shared/ipc'
import type { MorzBusApi as HandoffBridge } from '../src/shared/bus-ipc'
import type { MorzConnectionsApi } from '../src/shared/connections'
import type { RunStatus } from '../src/shared/spawn-plan'
import {
  closeMorz,
  installCollector,
  launchMorz,
  ROOT,
  termText,
  writePane,
  type MorzApp
} from './app'

test.describe.configure({ retries: 0 })

const GOAL = [
  'Use exactly one Codex CLI agent.',
  'In this fresh repository, create hello.py whose main program prints exactly hello,',
  'and create test_hello.py using Python unittest to verify that output.',
  'Run python -m unittest -v.',
  'Commit only hello.py and test_hello.py with the message feat: add hello program.',
  'Keep the task tiny and stop after the commit.'
].join(' ')

type LiveWindow = Window & {
  morzPlanner: PlannerBridge
  morzReviewer: ReviewerBridge
  morzCommit: CommitBridge
  morzConnections: MorzConnectionsApi
  morzPaneInfo: PaneInfoBridge
  morz: {
    run: MorzRunApi
    bus: HandoffBridge & {
      listTasks(): Promise<Array<{ id: string; state: string; assignee: string | null }>>
    }
    pty: { list(): Promise<string[]> }
  }
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim()
}

function pidAlive(pid: number): boolean {
  const output = spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], {
    windowsHide: true,
    timeout: 10_000
  }).stdout?.toString()
  return !!output && output.includes(`"${pid}"`)
}

async function seedSpace(morz: MorzApp, root: string): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await morz.page.evaluate((spaceRoot) => {
      localStorage.setItem(
        'morz.spaces',
        JSON.stringify({
          state: {
            spaces: [{ id: 'orch-live', name: 'orch-live', root: spaceRoot, agents: [] }],
            activeSpaceId: 'orch-live',
            initialized: true
          },
          version: 2
        })
      )
    }, root)
    await morz.page.reload({ waitUntil: 'domcontentloaded' })
    await installCollector(morz.page)
    const tab = morz.page
      .getByRole('tablist', { name: 'Spaces' })
      .getByRole('tab', { name: 'orch-live' })
    try {
      await expect(tab).toHaveAttribute('aria-selected', 'true', { timeout: 5_000 })
      return
    } catch {
      // The persisted Zustand store can finish one last write during reload.
      // Reseed and verify the renderer's active-space view before planning.
    }
  }
  throw new Error(`Failed to activate isolated live-orchestrator space ${root}`)
}

async function listRuns(page: MorzApp['page']): Promise<RunSummary[]> {
  return page.evaluate(() => (window as unknown as LiveWindow).morz.run.listRuns())
}

async function status(page: MorzApp['page'], runId: string): Promise<RunStatus | null> {
  return page.evaluate(
    (id) => (window as unknown as LiveWindow).morz.run.runStatus(id),
    runId
  )
}

test('plans, approves, dispatches, builds, commits, reviews, stops, and cleans up with real CLIs', async () => {
  test.skip(
    process.env.MORZ_LIVE_ORCH !== '1',
    'set MORZ_LIVE_ORCH=1 to run the real Claude + Codex orchestration proof'
  )
  test.setTimeout(15 * 60_000)

  const fixtureParent = join(ROOT, 'e2e', '.tmp', `orch-live-${Date.now()}`)
  const spaceRoot = join(fixtureParent, 'space')
  mkdirSync(spaceRoot, { recursive: true })
  writeFileSync(join(spaceRoot, 'README.md'), '# live orchestrator fixture\n', 'utf8')
  git(spaceRoot, 'init', '-b', 'main')
  git(spaceRoot, 'config', 'user.name', 'Morz Live Orchestrator')
  git(spaceRoot, 'config', 'user.email', 'orch-live@morz.invalid')
  git(spaceRoot, 'add', 'README.md')
  git(spaceRoot, 'commit', '-m', 'test: seed live orchestrator fixture')

  const previousSpace = process.env.MORZ_SPACE
  const previousDispatchStub = process.env.MORZ_DISPATCH_STUB
  process.env.MORZ_SPACE = spaceRoot
  delete process.env.MORZ_DISPATCH_STUB

  let morz: MorzApp | undefined
  let runId = ''
  try {
    morz = await launchMorz()
    await seedSpace(morz, spaceRoot)
    const { page } = morz

    const connections = await page.evaluate(() =>
      (window as unknown as LiveWindow).morzConnections.refresh()
    )
    for (const cli of ['claude', 'codex', 'agy'] as const) {
      expect(connections.find((connection) => connection.id === cli)?.installed).toBe(true)
    }
    expect(connections.find((connection) => connection.id === 'claude')?.authed).not.toBe(false)
    expect(connections.find((connection) => connection.id === 'codex')?.authed).not.toBe(false)

    await page.getByRole('radio', { name: 'Orchestrated' }).click()
    await page.getByRole('textbox', { name: 'Goal' }).fill(GOAL)
    await page.getByRole('button', { name: 'Plan team' }).click()
    await expect(page.getByText('Planning', { exact: true })).toBeVisible()

    const card = page.getByRole('region', { name: 'Spawn plan' })
    await expect(card).toBeVisible({ timeout: 180_000 })
    await expect(card.getByText('PROPOSED', { exact: true })).toBeVisible()

    const open = await page.evaluate(() =>
      (window as unknown as LiveWindow).morzPlanner.listOpen()
    )
    const record = open.plans[0] as StoredSpawnPlan
    expect(record.plan.goal).toBe(GOAL)
    expect(record.plan.spaceRoot).toBe(spaceRoot)
    expect(record.plan.agents).toHaveLength(1)
    expect(record.plan.agents[0].cli).toBe('codex')
    expect(record.plan.agents[0].worktree).toBeNull()
    expect(record.plan.agents[0].port).toBeNull()

    const approve = card.getByRole('button', { name: 'Approve & Run' })
    await expect(approve).toBeEnabled({ timeout: 30_000 })
    await approve.click()
    await expect(card.getByText('APPROVED', { exact: true })).toBeVisible({ timeout: 180_000 })

    await expect
      .poll(async () => {
        const match = (await listRuns(page)).find((run) => run.goal === GOAL)
        runId = match?.runId ?? ''
        return match?.state ?? null
      }, { timeout: 180_000 })
      .toBe('running')

    const running = (await status(page, runId))!
    expect(running.state).toBe('running')
    expect(Object.keys(running.agents)).toEqual([record.plan.agents[0].agentId])
    const agentId = record.plan.agents[0].agentId
    const detail = running.agentsDetail![agentId]
    expect(detail.cli).toBe('codex')
    expect(detail.port).toBeGreaterThan(0)
    expect(detail.pid).toBeGreaterThan(0)
    expect(detail.worktree).toBeTruthy()
    expect(existsSync(detail.worktree!)).toBe(true)
    expect(git(detail.worktree!, 'branch', '--show-current')).toBe(record.plan.agents[0].branch)
    expect(await page.evaluate(() => (window as unknown as LiveWindow).morz.pty.list())).toContain(
      detail.paneId
    )

    const pill = page.getByTestId('agent-pill').filter({ hasText: agentId })
    await expect(pill).toContainText('Codex', { timeout: 60_000 })
    await expect
      .poll(
        async () => {
          const panes = await page.evaluate(() =>
            (window as unknown as LiveWindow).morzPaneInfo.list()
          )
          return panes.find((pane) => pane.paneId === detail.paneId)?.foreground?.toLowerCase() ?? ''
        },
        { timeout: 120_000 }
      )
      .toMatch(/codex/)

    // A never-before-seen worktree path triggers Codex's native repository
    // trust screen. This test created the repository and controls every byte
    // in it, so explicitly accept the default "Yes, continue" choice. Morz
    // production continues to leave this safety decision in the visible TUI.
    const worktree = detail.worktree!
    let trustAccepted = false
    try {
      await expect
        .poll(
          async () => {
            const terminal = await termText(page, detail.paneId)
            if (!trustAccepted && /trust/i.test(terminal)) {
              trustAccepted = true
              console.log('[orch-e2e] accepting Codex trust prompt for isolated fixture')
              await writePane(page, detail.paneId, '1')
              await new Promise((resolve) => setTimeout(resolve, 500))
              await writePane(page, detail.paneId, '\r')
            }
            return existsSync(join(worktree, 'hello.py')) && existsSync(join(worktree, 'test_hello.py'))
          },
          { timeout: 3 * 60_000, intervals: [1_000, 2_000, 5_000] }
        )
        .toBe(true)
    } catch (error) {
      console.log('[orch-e2e] agent terminal at build timeout\n' + (await termText(page, detail.paneId)))
      throw error
    }
    expect(execFileSync('python', ['hello.py'], { cwd: worktree, encoding: 'utf8' }).trim()).toBe(
      'hello'
    )
    const unit = spawnSync('python', ['-m', 'unittest', '-v'], {
      cwd: worktree,
      encoding: 'utf8',
      windowsHide: true
    })
    expect(unit.status).toBe(0)
    expect(`${unit.stdout}\n${unit.stderr}`).toContain('OK')

    if (git(worktree, 'log', '-1', '--pretty=%s') !== 'feat: add hello program') {
      await page.evaluate(
        async (root) => {
          const commit = (window as unknown as LiveWindow).morzCommit
          await commit.stageFile(root, 'hello.py')
          await commit.stageFile(root, 'test_hello.py')
        },
        worktree
      )
      const stagedDiff = await page.evaluate(
        (root) => (window as unknown as LiveWindow).morzCommit.stagedDiff(root),
        worktree
      )
      expect(stagedDiff).toContain('hello.py')
      expect(stagedDiff).toContain('test_hello.py')
      await page.evaluate(
        ({ root, message }) => (window as unknown as LiveWindow).morzCommit.commit(root, message),
        { root: worktree, message: 'feat: add hello program' }
      )
    }
    expect(git(worktree, 'log', '-1', '--pretty=%s')).toBe('feat: add hello program')
    expect(git(worktree, 'show', '--name-only', '--pretty=format:', 'HEAD').split(/\r?\n/).filter(Boolean).sort())
      .toEqual(['hello.py', 'test_hello.py'])

    const commitLog = await page.evaluate(
      (root) => (window as unknown as LiveWindow).morzCommit.log(root),
      worktree
    )
    expect(commitLog[0]?.subject).toBe('feat: add hello program')

    const review = await page.evaluate(
      (root) =>
        (window as unknown as LiveWindow).morzReviewer.run({
          cwd: root,
          baseRef: 'main',
          headRef: 'HEAD',
          author: 'codex'
        }),
      worktree
    )
    expect(review.reviewer).toBe('claude')
    expect(review.sameModelReview).toBe(false)
    expect(Array.isArray(review.findings)).toBe(true)

    const tasks = await page.evaluate(() =>
      (window as unknown as LiveWindow).morz.bus.listTasks()
    )
    expect(tasks.find((task) => task.id === detail.kickoffTaskId)?.state).toBe('accepted')

    // Live handoff audit: dispatched panes are raw CLI processes, not adapter
    // lanes, so approval delivers the mailbox payload but cannot inject the
    // pointer. The task honestly remains accepted instead of pretending work.
    const handoff = await page.evaluate(
      ({ to }) =>
        (window as unknown as LiveWindow).morz.bus.post({
          from: 'orch-live-auditor',
          to,
          title: 'Live orchestrator handoff probe',
          text: 'This bounded probe must remain in the mailbox.'
        }),
      { to: agentId }
    )
    const snapshot = await page.evaluate(() =>
      (window as unknown as LiveWindow).morz.bus.snapshot()
    )
    const approval = snapshot.approvals.find((item) => item.taskId === handoff.taskId)
    expect(approval).toBeTruthy()
    await page.evaluate(
      (requestId) =>
        (window as unknown as LiveWindow).morz.bus.respondApproval({ requestId, approved: true }),
      approval!.requestId
    )
    await expect
      .poll(async () => {
        const current = await page.evaluate(() =>
          (window as unknown as LiveWindow).morz.bus.snapshot()
        )
        return current.tasks.find((task) => task.id === handoff.taskId)?.state
      })
      .toBe('accepted')

    const beforeStop = (await status(page, runId))!
    expect(beforeStop.state).toBe('running')
    expect(beforeStop.agents[agentId]).toBe('running')
    expect(pidAlive(detail.pid!)).toBe(true)

    const stopped = await page.evaluate(
      (id) => (window as unknown as LiveWindow).morz.run.stopRun(id),
      runId
    )
    expect(stopped.state).toBe('aborted')
    expect(stopped.agents[agentId]).toBe('cancelled')
    await expect
      .poll(() => page.evaluate(() => (window as unknown as LiveWindow).morz.pty.list()))
      .not.toContain(detail.paneId)
    await expect.poll(() => pidAlive(detail.pid!), { timeout: 30_000 }).toBe(false)

    await page.evaluate((id) => (window as unknown as LiveWindow).morz.run.cleanup(id), runId)
    expect(existsSync(worktree)).toBe(false)
    expect(git(spaceRoot, 'branch', '--list', record.plan.agents[0].branch)).toBe('')

    console.log(
      '[orch-e2e] live evidence',
      JSON.stringify({
        planner: 'claude',
        agent: { id: agentId, cli: detail.cli, port: detail.port },
        commit: commitLog[0]?.shortSha,
        reviewer: review.reviewer,
        findings: review.findings.length,
        handoffState: 'accepted',
        stateBeforeStop: beforeStop.state,
        stateAfterStop: stopped.state
      })
    )
  } finally {
    if (morz) {
      if (runId) {
        try {
          const current = await status(morz.page, runId)
          if (current && current.state !== 'done' && current.state !== 'aborted') {
            await morz.page.evaluate(
              (id) => (window as unknown as LiveWindow).morz.run.stopRun(id),
              runId
            )
          }
          if (current) {
            await morz.page.evaluate(
              (id) => (window as unknown as LiveWindow).morz.run.cleanup(id),
              runId
            )
          }
        } catch {
          // The primary assertion reports the failure; fixture removal below
          // is the final safety net for this isolated temporary repository.
        }
      }
      await closeMorz(morz.app)
    }
    if (previousSpace === undefined) delete process.env.MORZ_SPACE
    else process.env.MORZ_SPACE = previousSpace
    if (previousDispatchStub === undefined) delete process.env.MORZ_DISPATCH_STUB
    else process.env.MORZ_DISPATCH_STUB = previousDispatchStub
    rmSync(fixtureParent, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  }
})
