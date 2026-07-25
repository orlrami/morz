import { expect, test } from '@playwright/test'
import { closeMorz, launchMorz, type MorzApp } from './app'

interface TestAgent {
  agentId: string
  cli: 'claude' | 'codex' | 'agy'
  role: string
  branch: string
  worktree?: string | null
  cwd: string
  promptSeed: string
  dependsOn?: string[]
  port?: number | null
}

interface TestPlan {
  version: '1.0'
  id: string
  goal: string
  agents: TestAgent[]
  spaceRoot: string
  caps: { maxUsd?: number | null; maxTokens?: number | null }
  createdAt: string
  planHash: string
}

function plan(id: string): TestPlan {
  return {
    version: '1.0',
    id,
    goal: 'Preserve plan trust across transport',
    agents: [
      {
        agentId: 'architect',
        cli: 'claude',
        role: 'Architect',
        branch: `run/${id}/architect`,
        worktree: null,
        cwd: '',
        promptSeed: 'Design the implementation.',
        dependsOn: [],
        port: null
      },
      {
        agentId: 'builder',
        cli: 'claude',
        role: 'Builder',
        branch: `run/${id}/builder`,
        worktree: null,
        cwd: '',
        promptSeed: 'Implement the design.',
        dependsOn: [],
        port: null
      }
    ],
    spaceRoot: 'C:\\Projects\\morz',
    caps: { maxUsd: null, maxTokens: null },
    createdAt: '2026-07-19T12:00:00.000Z',
    planHash: ''
  }
}

async function seedProposedPlan(morz: MorzApp, candidate: TestPlan): Promise<TestPlan> {
  return morz.app.evaluate(async ({ app }, input: TestPlan) => {
    const getBuiltinModule = (process as typeof process & {
      getBuiltinModule(id: string): unknown
    }).getBuiltinModule
    const { createHash } = getBuiltinModule('node:crypto') as typeof import('node:crypto')
    const { join } = getBuiltinModule('node:path') as typeof import('node:path')
    const { createRequire } = getBuiltinModule('node:module') as typeof import('node:module')
    const requireFromApp = createRequire(join(process.cwd(), 'package.json'))
    const Database = requireFromApp('better-sqlite3') as typeof import('better-sqlite3')
    const stored = JSON.parse(JSON.stringify(input)) as TestPlan
    for (const agent of stored.agents) delete agent.dependsOn

    const canonicalJson = (value: unknown): string => {
      if (value === null || typeof value !== 'object') return JSON.stringify(value)
      if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
      const object = value as Record<string, unknown>
      return `{${Object.keys(object)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
        .join(',')}}`
    }
    const { planHash: _ignored, ...hashable } = stored
    stored.planHash = createHash('sha256').update(canonicalJson(hashable)).digest('hex')

    const db = new Database(join(app.getPath('appData'), 'Morz', 'morz.db'))
    const now = new Date().toISOString()
    db.prepare(
      `INSERT INTO orchestrator_plans
        (id, plan_hash, state, json, created_at, updated_at)
       VALUES (?, ?, 'PROPOSED', ?, ?, ?)`
    ).run(stored.id, stored.planHash, JSON.stringify(stored), stored.createdAt, now)
    db.close()
    return stored
  }, candidate)
}

async function updatePlan(morz: MorzApp, updated: TestPlan, expectedHash: string): Promise<TestPlan> {
  return morz.page.evaluate(
    async ({ updated, expectedHash }) => {
      const bridge = (window as unknown as {
        morzPlanner: {
          update(plan: TestPlan, hash: string): Promise<{ plan: TestPlan }>
        }
      }).morzPlanner
      return (await bridge.update(updated, expectedHash)).plan
    },
    { updated, expectedHash }
  )
}

test.describe('plan-card trust regressions', () => {
  let morz: MorzApp

  test.beforeEach(async () => {
    morz = await launchMorz()
  })

  test.afterEach(async () => {
    if (morz) await closeMorz(morz.app)
  })

  test('canonicalizes omitted dependency arrays while preserving immutable branch checks', async () => {
    const stored = await seedProposedPlan(morz, plan('transport-normalization'))
    const routed = JSON.parse(JSON.stringify(stored)) as TestPlan
    for (const agent of routed.agents) delete agent.dependsOn
    routed.agents[0].cli = 'codex'

    // Agent 2 owns planner validation. Model its boundary normalization so this
    // regression reaches the real PlanStore comparison through planner:update.
    const transported = JSON.parse(JSON.stringify(routed)) as TestPlan
    for (const agent of transported.agents) agent.dependsOn = []
    const updated = await updatePlan(morz, transported, stored.planHash)

    expect(updated.agents.map((agent) => agent.dependsOn)).toEqual([[], []])
    expect(updated.agents[0].cli).toBe('codex')

    const branchRewrite = JSON.parse(JSON.stringify(updated)) as TestPlan
    branchRewrite.agents[0].branch = 'run/attacker'
    await expect(updatePlan(morz, branchRewrite, updated.planHash)).rejects.toThrow(/immutable/)
  })

  test('renders eight goal lines above the old single-line-sized cap', async () => {
    const { page } = morz
    await page.getByRole('radio', { name: 'Orchestrated' }).click()
    const composer = page.getByRole('textbox', { name: 'Goal' })
    const initialHeight = await composer.evaluate((element) => element.clientHeight)

    await composer.fill(Array.from({ length: 8 }, (_, index) => `Line ${index + 1}`).join('\n'))

    await expect
      .poll(() => composer.evaluate((element) => element.clientHeight))
      .toBeGreaterThan(128)
    await expect
      .poll(() => composer.evaluate((element) => element.clientHeight))
      // Growth contract, not a ratio: the single-line baseline keeps changing
      // with chrome polish, so assert 8 lines add several line-heights instead.
      .toBeGreaterThan(initialHeight + 60)
  })
})
