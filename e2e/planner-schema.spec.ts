/*
 * w13/planner-schema — the planner REPAIRS real-world plans instead of
 * rejecting them: overlong roles truncate, unsafe branches slugify, and the
 * repairs surface as warnings on the plan response. Genuinely broken shapes
 * (missing agentId) still hard-reject. The MORZ_E2E stub engine emits the
 * repair/broken variants via goal markers (see e2ePlannerResponse).
 */
import { expect, test } from '@playwright/test'
import { closeMorz, launchMorz, type MorzApp } from './app'

interface PlanResponse {
  plan: {
    agents: { role: string; branch: string }[]
  }
  state: string
  warnings?: string[]
}

const SPACE_ROOT = 'C:\\Projects\\morz'

function planViaBridge(morz: MorzApp, goal: string): Promise<PlanResponse> {
  return morz.page.evaluate(
    async ({ goal, spaceRoot }) => {
      const bridge = (window as unknown as {
        morzPlanner: { plan(goal: string, spaceRoot: string): Promise<PlanResponse> }
      }).morzPlanner
      return bridge.plan(goal, spaceRoot)
    },
    { goal, spaceRoot: SPACE_ROOT }
  )
}

test.describe.serial('planner schema repair', () => {
  let morz: MorzApp

  test.beforeAll(async () => {
    process.env.MORZ_E2E = '1'
    morz = await launchMorz()
  })

  test.afterAll(async () => {
    if (morz) await closeMorz(morz.app)
    delete process.env.MORZ_E2E
  })

  test('repairs a 500-char role and an unsafe branch, accepts the plan, records warnings', async () => {
    const result = await planViaBridge(morz, 'MORZ_E2E_REPAIR ship a serious multi-agent spec')

    expect(result.state).toBe('PROPOSED')
    const agent = result.plan.agents[0]
    expect(agent.role.length).toBeLessThanOrEqual(200)
    expect(agent.branch).toMatch(/^[a-z0-9][a-z0-9/-]*$/)
    expect(agent.branch).not.toContain('..')
    expect(result.warnings?.length ?? 0).toBeGreaterThan(0)
    expect(result.warnings?.join(' ')).toMatch(/role/)
    expect(result.warnings?.join(' ')).toMatch(/branch/)
  })

  test('a plan missing agentId still hard-rejects', async () => {
    const error = await morz.page.evaluate(
      async ({ spaceRoot }) => {
        const bridge = (window as unknown as {
          morzPlanner: { plan(goal: string, spaceRoot: string): Promise<unknown> }
        }).morzPlanner
        try {
          await bridge.plan('MORZ_E2E_BROKEN missing agent id', spaceRoot)
          return null
        } catch (e) {
          return e instanceof Error ? e.message : String(e)
        }
      },
      { spaceRoot: SPACE_ROOT }
    )
    expect(error).toMatch(/schema validation/)
  })
})

test('live: a multi-hundred-line spec goal produces a PROPOSED plan', async () => {
  test.skip(process.env.MORZ_LIVE_PLANNER !== '1', 'Set MORZ_LIVE_PLANNER=1 for the live big-goal proof.')
  test.setTimeout(300_000)
  delete process.env.MORZ_E2E
  const morz = await launchMorz()
  try {
    const lines = [
      'Build a small task-manager web feature. Planning only; do not modify files.',
      'The full specification follows — plan the smallest team that covers it:'
    ]
    for (let index = 1; index <= 1_300; index += 1) {
      lines.push(`- requirement ${index}: the module handles case ${index} with validation and tests`)
    }
    const goal = lines.join('\n')
    expect(goal.length).toBeGreaterThan(30_000) // would overflow argv if not stdin
    expect(goal.length).toBeLessThanOrEqual(100_000)

    await morz.page.getByRole('radio', { name: 'Orchestrated' }).click()
    await morz.page.getByRole('textbox', { name: 'Goal' }).fill(goal)
    await morz.page.getByRole('button', { name: 'Plan team' }).click()

    const card = morz.page.getByRole('region', { name: 'Spawn plan' })
    // Scope to planner failures only — unrelated app banners (e.g. MCP
    // registry sync) also render role=alert and must not fail this proof.
    const alert = morz.page.getByRole('alert').filter({ hasText: /[Pp]lan/ })
    await expect(card.or(alert).first()).toBeVisible({ timeout: 240_000 })
    if (await alert.isVisible()) throw new Error((await alert.textContent()) ?? 'Planner failed')
    await expect(card.getByText('PROPOSED', { exact: true })).toBeVisible()
    await card.getByRole('button', { name: 'Discard' }).click()
    await expect(card).toHaveCount(0)
  } finally {
    await closeMorz(morz.app)
  }
})
