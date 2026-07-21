/*
 * w14/orch-scoped e2e — the orchestrator is SCOPED PER SPACE and CLEAN ON OPEN.
 *
 * Two spaces are each seeded with a real plan (planner IPC, MORZ_E2E stub
 * response) and a real dispatched run (MORZ_DISPATCH_STUB shells). Activating
 * space A must show ONLY A's plan, run, and kickoff tasks; switching to B swaps
 * the whole panel; a third fresh space shows empty states — never a global
 * dump of every project's history.
 */
import { expect, test, type Page } from '@playwright/test'
import { execFileSync } from 'child_process'
import { mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { closeMorz, launchMorz, ROOT, type MorzApp } from './app'

interface MorzScopedWindow {
  morzPlanner: {
    plan(goal: string, spaceRoot: string): Promise<{ plan: { goal: string } }>
    listOpen(spaceRoot?: string): Promise<{ plans: { plan: { goal: string } }[] }>
  }
  morz: {
    run: {
      approvePlan(plan: unknown): Promise<{ planHash: string }>
      dispatch(plan: unknown): Promise<{ runId: string }>
      stopRun(runId: string): Promise<unknown>
    }
  }
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim()
}

function makeSpaceFixture(parent: string, name: string): string {
  const root = join(parent, name)
  mkdirSync(root, { recursive: true })
  writeFileSync(join(root, 'README.md'), `# ${name} fixture\n`, 'utf8')
  git(root, 'init', '-b', 'main')
  git(root, 'config', 'user.name', 'Morz Scoped Test')
  git(root, 'config', 'user.email', 'orch-scoped@morz.invalid')
  git(root, 'add', '-A')
  git(root, 'commit', '-m', 'test: orch-scoped fixture')
  return root
}

function makeRunPlan(spaceRoot: string, tag: string, goal: string): unknown {
  return {
    version: '1.0',
    id: `plan-orch-scoped-${tag}`,
    goal,
    agents: [
      {
        agentId: `agent-${tag}`,
        cli: 'claude',
        role: `builder ${tag}`,
        branch: `run/orch-scoped/${tag}`,
        worktree: null,
        cwd: '',
        promptSeed: 'Do the scoped thing.',
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

async function seedSpaces(
  page: Page,
  spaces: { id: string; name: string; root: string }[],
  activeSpaceId: string
): Promise<void> {
  // Seed-verify-retry (space-tabs.spec pattern): the old page's persist flush
  // can wipe the localStorage seed during reload.
  let seeded = false
  for (let attempt = 0; attempt < 3 && !seeded; attempt += 1) {
    await page.evaluate(
      ({ list, active }) => {
        localStorage.setItem(
          'morz.spaces',
          JSON.stringify({
            version: 2,
            state: {
              spaces: list.map((space) => ({ ...space, agents: [] })),
              activeSpaceId: active,
              initialized: true
            }
          })
        )
      },
      { list: spaces, active: activeSpaceId }
    )
    await page.reload({ waitUntil: 'domcontentloaded' })
    try {
      await expect(
        page.getByRole('tablist', { name: 'Spaces' }).getByRole('tab', { name: spaces[0].name })
      ).toBeAttached({ timeout: 5_000 })
      seeded = true
    } catch {
      // persist race wiped the seed — reseed on the fresh page and retry
    }
  }
  expect(seeded, 'seeded spaces survived reload').toBe(true)
}

async function activateSpace(page: Page, name: string): Promise<void> {
  const tab = page.getByRole('tablist', { name: 'Spaces' }).getByRole('tab', { name })
  await tab.click()
  await expect(tab).toHaveAttribute('aria-selected', 'true')
}

test('orchestrator panel is scoped per space and a fresh space opens empty', async () => {
  test.setTimeout(240_000)
  const fixtureParent = join(ROOT, 'e2e', '.tmp', `orch-scoped-${Date.now()}`)
  const rootA = makeSpaceFixture(fixtureParent, 'scoped-alpha')
  const rootB = makeSpaceFixture(fixtureParent, 'scoped-beta')
  const rootC = join(fixtureParent, 'scoped-fresh')
  mkdirSync(rootC, { recursive: true })

  // MORZ_E2E stubs the planner LLM call; MORZ_DISPATCH_STUB spawns plain shells.
  process.env.MORZ_E2E = '1'
  process.env.MORZ_DISPATCH_STUB = '1'
  let morz: MorzApp | undefined
  const runIds: string[] = []
  try {
    morz = await launchMorz()
    const { page } = morz
    await seedSpaces(
      page,
      [
        { id: 'scoped-alpha', name: 'scoped-alpha', root: rootA },
        { id: 'scoped-beta', name: 'scoped-beta', root: rootB },
        { id: 'scoped-fresh', name: 'scoped-fresh', root: rootC }
      ],
      'scoped-alpha'
    )

    // Seed each space with a REAL plan (planner IPC → real PlanStore row)…
    for (const [goal, root] of [
      ['MORZ_SCOPED_PLAN_ALPHA', rootA],
      ['MORZ_SCOPED_PLAN_BETA', rootB]
    ] as const) {
      const record = await page.evaluate(
        ({ g, r }) => (window as unknown as MorzScopedWindow).morzPlanner.plan(g, r),
        { g: goal, r: root }
      )
      expect(record.plan.goal).toBe(goal)
    }
    // …and a REAL dispatched run (stub shells, real orch_runs rows + kickoff tasks).
    for (const [tag, root, goal] of [
      ['alpha', rootA, 'MORZ_SCOPED_RUN_ALPHA'],
      ['beta', rootB, 'MORZ_SCOPED_RUN_BETA']
    ] as const) {
      const plan = makeRunPlan(root, tag, goal)
      const { planHash } = await page.evaluate(
        (p) => (window as unknown as MorzScopedWindow).morz.run.approvePlan(p),
        plan
      )
      const { runId } = await page.evaluate(
        (p) => (window as unknown as MorzScopedWindow).morz.run.dispatch(p),
        { ...(plan as Record<string, unknown>), planHash }
      )
      runIds.push(runId)
    }

    // Main-side contract: listOpen is filtered BY spaceRoot.
    const openA = await page.evaluate(
      (r) => (window as unknown as MorzScopedWindow).morzPlanner.listOpen(r),
      rootA
    )
    expect(openA.plans.map((p) => p.plan.goal)).toEqual(['MORZ_SCOPED_PLAN_ALPHA'])

    await page.getByRole('radio', { name: 'Orchestrated' }).click()

    // ── space A: only A's plan, kickoff task, and run ──
    await expect(page.getByTestId('orchestrator-space')).toHaveText('scoped-alpha')
    const planCard = page.getByRole('region', { name: 'Spawn plan' })
    await expect(planCard).toContainText('MORZ_SCOPED_PLAN_ALPHA')
    await expect(page.getByText('MORZ_SCOPED_PLAN_BETA')).toHaveCount(0)
    const taskA = page.getByTestId('bus-task').filter({ hasText: 'kickoff agent-alpha' })
    const taskB = page.getByTestId('bus-task').filter({ hasText: 'kickoff agent-beta' })
    await expect(taskA).toHaveCount(1)
    await expect(taskB).toHaveCount(0)

    await page.getByRole('tab', { name: 'Runs' }).click()
    await expect(page.getByText('MORZ_SCOPED_RUN_ALPHA').first()).toBeVisible()
    await expect(page.getByText('MORZ_SCOPED_RUN_BETA')).toHaveCount(0)

    // ── switch to space B: the whole panel swaps ──
    await activateSpace(page, 'scoped-beta')
    await expect(page.getByTestId('orchestrator-space')).toHaveText('scoped-beta')
    await expect(page.getByText('MORZ_SCOPED_RUN_BETA').first()).toBeVisible()
    await expect(page.getByText('MORZ_SCOPED_RUN_ALPHA')).toHaveCount(0)

    await page.getByRole('tab', { name: 'Blackboard' }).click()
    await expect(planCard).toContainText('MORZ_SCOPED_PLAN_BETA')
    await expect(page.getByText('MORZ_SCOPED_PLAN_ALPHA')).toHaveCount(0)
    await expect(taskB).toHaveCount(1)
    await expect(taskA).toHaveCount(0)

    // ── a fresh space opens EMPTY — no global dump ──
    await activateSpace(page, 'scoped-fresh')
    await expect(page.getByTestId('orchestrator-space')).toHaveText('scoped-fresh')
    await expect(planCard).toHaveCount(0)
    await expect(page.getByTestId('bus-task')).toHaveCount(0)
    await expect(page.getByText('No orchestration in this space yet')).toBeVisible()
    await page.getByRole('tab', { name: 'Runs' }).click()
    await expect(page.getByText('No runs yet')).toBeVisible()
    await expect(page.getByText('MORZ_SCOPED_RUN_ALPHA')).toHaveCount(0)
    await expect(page.getByText('MORZ_SCOPED_RUN_BETA')).toHaveCount(0)
  } finally {
    delete process.env.MORZ_E2E
    delete process.env.MORZ_DISPATCH_STUB
    if (morz) {
      // Stop the stub teams first — their shells hold cwd locks inside the
      // fixture worktrees, which makes the rmSync below EPERM on Windows.
      for (const runId of runIds) {
        try {
          await morz.page.evaluate(
            (id) => (window as unknown as MorzScopedWindow).morz.run.stopRun(id),
            runId
          )
        } catch {
          // page already gone — closeMorz's taskkill reaps the tree instead
        }
      }
      await closeMorz(morz.app)
    }
    for (let attempt = 0; ; attempt += 1) {
      try {
        rmSync(fixtureParent, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
        break
      } catch (error) {
        if (attempt >= 4) throw error
        await new Promise((resolve) => setTimeout(resolve, 1_000))
      }
    }
  }
})
