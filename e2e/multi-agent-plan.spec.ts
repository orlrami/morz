/*
 * w14/multi-agent-plan — team-proposal card + per-role model defaults.
 * Stubbed planner returns a 3-agent specialist team; the card must render a
 * row per agent with a model dropdown, support remove/add/size edits through
 * planner:update, and remember a per-role model choice across plans.
 */
import { expect, test } from '@playwright/test'
import { closeMorz, launchMorz, openOrchestrator, type MorzApp } from './app'

interface TestAgent {
  agentId: string
  cli: 'claude' | 'codex' | 'agy'
  model?: string | null
  role: string
  branch: string
  worktree: null
  cwd: string
  promptSeed: string
  dependsOn: string[]
  port: null
}

async function stubTeamPlanner(morz: MorzApp): Promise<void> {
  await morz.app.evaluate(({ ipcMain }) => {
    const agents = [
      {
        agentId: 'architect',
        cli: 'claude',
        // a plan-supplied model pre-fills the exact-model field (w17)
        model: 'opus',
        role: 'Architect',
        branch: 'run/team/architect',
        worktree: null,
        cwd: '',
        promptSeed: 'Design the Tetris module architecture and interfaces.',
        dependsOn: [],
        port: null
      },
      {
        agentId: 'builder',
        cli: 'codex',
        role: 'Builder',
        branch: 'run/team/builder',
        worktree: null,
        cwd: '',
        promptSeed: 'Implement the game loop and board rendering.',
        dependsOn: ['architect'],
        port: null
      },
      {
        agentId: 'math',
        cli: 'agy',
        role: 'Math specialist',
        branch: 'run/team/math',
        worktree: null,
        cwd: '',
        promptSeed: 'Verify rotation math and collision timing.',
        dependsOn: ['architect'],
        port: null
      }
    ]
    let planCalls = 0
    let updateCalls = 0
    let lastPlan: unknown = null
    for (const channel of ['planner:plan', 'planner:update', 'planner:approve-and-run', 'planner:discard']) {
      ipcMain.removeHandler(channel)
    }
    ipcMain.handle('planner:plan', () => {
      planCalls += 1
      const plan = {
        // per-agent models make this a 1.1 plan
        version: '1.1',
        id: `team-e2e-${planCalls}`,
        goal: 'Build a Tetris game',
        agents: structuredClone(agents),
        spaceRoot: 'C:\\Projects\\morz-planner',
        caps: { maxUsd: null, maxTokens: null },
        createdAt: '2026-07-20T12:00:00.000Z',
        planHash: 'abcdefabcdef'[planCalls - 1].repeat(64)
      }
      lastPlan = plan
      return {
        plan,
        state: 'PROPOSED',
        recommendedTeamSize: 3,
        teamRationale: 'architecture, implementation, and math split by strength'
      }
    })
    ipcMain.handle('planner:update', (_event, input: { plan: { planHash: string } }) => {
      updateCalls += 1
      const plan = { ...input.plan, planHash: `${'f'.repeat(63)}${updateCalls % 10}` }
      lastPlan = plan
      return { plan, state: 'PROPOSED' }
    })
    ipcMain.handle('planner:approve-and-run', () => ({
      record: { plan: lastPlan, state: 'APPROVED' },
      runId: 'stub-run-team'
    }))
    ipcMain.handle('planner:discard', () => undefined)
  })
}

test.describe('multi-agent team proposal card', () => {
  let morz: MorzApp

  test.beforeEach(async () => {
    morz = await launchMorz()
    await stubTeamPlanner(morz)
    await morz.page.getByRole('radio', { name: 'Assisted', exact: true }).click()
    await openOrchestrator(morz.page)
    await morz.page.getByRole('textbox', { name: 'Goal' }).fill('Build a Tetris game')
    await morz.page.getByRole('button', { name: 'Plan team' }).click()
    await expect(morz.page.getByTestId('team-recommendation')).toContainText(
      'Orchestrator recommends 3 agents'
    )
  })

  test.afterEach(async () => {
    if (morz) await closeMorz(morz.app)
  })

  test('renders a row with a model dropdown per agent; remove and add update the plan', async () => {
    const { page } = morz
    // exact:true keeps the per-agent CLI select apart from the 'Agent model
    // for …' exact-model input, which is also a combobox (w17).
    const card = page.getByRole('region', { name: 'Spawn plan' })
    await expect(card.getByRole('combobox', { name: /^Model for / })).toHaveCount(3)
    await expect(
      card.getByRole('combobox', { name: 'Model for Builder', exact: true })
    ).toHaveValue('codex')
    await expect(
      card.getByRole('combobox', { name: 'Model for Math specialist', exact: true })
    ).toHaveValue('agy')

    // The model the plan named pre-fills; an agent without one stays on the
    // user's CLI default.
    await expect(card.getByTestId('plan-agent-model-architect')).toHaveValue('opus')
    await expect(card.getByTestId('plan-agent-model-builder')).toHaveValue('')
    await expect(card.getByTestId('plan-agent-model-builder')).toHaveAttribute(
      'placeholder',
      'User default'
    )

    await card.getByRole('button', { name: 'Remove Math specialist' }).click()
    await expect(card.getByRole('combobox', { name: /^Model for / })).toHaveCount(2)

    await card.getByRole('button', { name: 'Add agent' }).click()
    await expect(card.getByRole('combobox', { name: /^Model for / })).toHaveCount(3)
    await expect(
      card.getByRole('combobox', { name: 'Model for Agent 3', exact: true })
    ).toBeVisible()

    await card.getByRole('button', { name: 'Approve & Run' }).click()
    await expect(page.getByText(/stub-run-team/)).toBeVisible()
  })

  test('a team-size trim keeps the first N agents', async () => {
    const { page } = morz
    const card = page.getByRole('region', { name: 'Spawn plan' })
    await card.getByRole('combobox', { name: 'Team size' }).selectOption('2')
    await expect(card.getByRole('combobox', { name: /^Model for / })).toHaveCount(2)
    await expect(
      card.getByRole('combobox', { name: 'Model for Architect', exact: true })
    ).toBeVisible()
    await expect(
      card.getByRole('combobox', { name: 'Model for Builder', exact: true })
    ).toBeVisible()
  })

  test('a model swap persists as the role default and offers it as a chip on the next plan', async () => {
    const { page } = morz
    const card = page.getByRole('region', { name: 'Spawn plan' })
    const builderCli = card.getByRole('combobox', { name: 'Model for Builder', exact: true })
    await builderCli.selectOption('agy')
    await expect(builderCli).toHaveValue('agy')

    await card.getByRole('button', { name: 'Discard' }).click()
    await page.getByRole('button', { name: 'Plan team' }).click()
    // The stub proposes codex again; the proposal stands untouched and the
    // remembered per-role default is an opt-in chip, never a silent rewrite.
    await expect(builderCli).toHaveValue('codex')
    const chip = card
      .getByTestId('route-chip')
      .filter({ hasText: "Use your Antigravity default for 'Builder'?" })
    await expect(chip).toBeVisible()
    await chip.getByRole('button', { name: 'Apply' }).click()
    await expect(builderCli).toHaveValue('agy')
  })
})

/* Real plan-store contract: appended agents are allowed; identity takeover is not. */
test('the real update path accepts an appended agent and rejects branch takeover', async () => {
  const morz = await launchMorz()
  try {
    const stored = await morz.app.evaluate(async ({ app }) => {
      const getBuiltinModule = (process as typeof process & {
        getBuiltinModule(id: string): unknown
      }).getBuiltinModule
      const { createHash } = getBuiltinModule('node:crypto') as typeof import('node:crypto')
      const { join } = getBuiltinModule('node:path') as typeof import('node:path')
      const { createRequire } = getBuiltinModule('node:module') as typeof import('node:module')
      const requireFromApp = createRequire(join(process.cwd(), 'package.json'))
      const Database = requireFromApp('better-sqlite3') as typeof import('better-sqlite3')
      const plan = {
        version: '1.0',
        id: 'append-agents',
        goal: 'Build a Tetris game',
        agents: [
          {
            agentId: 'architect',
            cli: 'claude',
            role: 'Architect',
            branch: 'run/append-agents/architect',
            worktree: null,
            cwd: '',
            promptSeed: 'Design the architecture.',
            dependsOn: [],
            port: null
          }
        ],
        spaceRoot: 'C:\\Projects\\morz',
        caps: { maxUsd: null, maxTokens: null },
        createdAt: '2026-07-20T12:00:00.000Z',
        planHash: ''
      }
      const canonicalJson = (value: unknown): string => {
        if (value === null || typeof value !== 'object') return JSON.stringify(value)
        if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
        const object = value as Record<string, unknown>
        return `{${Object.keys(object)
          .sort()
          .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
          .join(',')}}`
      }
      const { planHash: _ignored, ...hashable } = plan
      plan.planHash = createHash('sha256').update(canonicalJson(hashable)).digest('hex')
      const db = new Database(join(app.getPath('appData'), 'Morz', 'morz.db'))
      db.prepare(
        `INSERT INTO orchestrator_plans (id, plan_hash, state, json, created_at, updated_at)
         VALUES (?, ?, 'PROPOSED', ?, ?, ?)`
      ).run(plan.id, plan.planHash, JSON.stringify(plan), plan.createdAt, new Date().toISOString())
      db.close()
      return plan
    })

    const addedAgent: TestAgent = {
      agentId: 'builder',
      cli: 'codex',
      role: 'Builder',
      branch: 'run/append-agents/builder',
      worktree: null,
      cwd: '',
      promptSeed: 'Implement the game.',
      dependsOn: ['architect'],
      port: null
    }
    const appended = await morz.page.evaluate(
      async ({ stored, addedAgent }) => {
        const bridge = (window as unknown as {
          morzPlanner: {
            update(plan: unknown, expectedHash: string): Promise<{ plan: { agents: unknown[]; planHash: string } }>
          }
        }).morzPlanner
        return (
          await bridge.update({ ...stored, agents: [...stored.agents, addedAgent] }, stored.planHash)
        ).plan
      },
      { stored, addedAgent }
    )
    expect(appended.agents).toHaveLength(2)

    // Identity takeover: a "new" agent reusing an original branch must fail.
    const takeover = await morz.page.evaluate(
      async ({ stored, appended }) => {
        const bridge = (window as unknown as {
          morzPlanner: { update(plan: unknown, expectedHash: string): Promise<unknown> }
        }).morzPlanner
        const agents = (appended.agents as { agentId: string }[]).map((agent) =>
          agent.agentId === 'architect' ? { ...agent, agentId: 'attacker' } : agent
        )
        try {
          await bridge.update({ ...stored, agents, planHash: appended.planHash }, appended.planHash)
          return 'accepted'
        } catch (error) {
          return error instanceof Error ? error.message : String(error)
        }
      },
      { stored, appended }
    )
    expect(takeover).toMatch(/immutable/)
  } finally {
    await closeMorz(morz.app)
  }
})
