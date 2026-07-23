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
  dependsOn: string[]
  port: number | null
}

interface TestPlan {
  version: '1.0'
  id: string
  goal: string
  agents: TestAgent[]
  spaceRoot: string
  caps: { maxUsd: number | null; maxTokens: number | null }
  createdAt: string
  planHash: string
}

function plan(id: string): TestPlan {
  return {
    version: '1.0',
    id,
    goal: 'Review the orchestrator plan flow',
    agents: [
      {
        agentId: 'architect',
        cli: 'claude',
        role: 'Architect reviewer',
        branch: `run/${id}/architect`,
        worktree: null,
        cwd: '',
        promptSeed: 'Review the implementation and dispatch it safely.',
        dependsOn: [],
        port: null
      }
    ],
    spaceRoot: 'C:\\Projects\\morz',
    caps: { maxUsd: null, maxTokens: null },
    createdAt: '2026-07-16T12:00:00.000Z',
    planHash: ''
  }
}

async function seedProposedPlan(
  morz: MorzApp,
  candidate: TestPlan,
  options: { omitStoredWorktree?: boolean } = {}
): Promise<TestPlan> {
  return morz.app.evaluate(
    async ({ app }, input: { candidate: TestPlan; omitStoredWorktree: boolean }) => {
      const getBuiltinModule = (process as typeof process & {
        getBuiltinModule(id: string): unknown
      }).getBuiltinModule
      const { createHash } = getBuiltinModule('node:crypto') as typeof import('node:crypto')
      const { join } = getBuiltinModule('node:path') as typeof import('node:path')
      const { createRequire } = getBuiltinModule('node:module') as typeof import('node:module')
      const requireFromApp = createRequire(join(process.cwd(), 'package.json'))
      const Database = requireFromApp('better-sqlite3') as typeof import('better-sqlite3')
      const stored = structuredClone(input.candidate)
      if (input.omitStoredWorktree) delete stored.agents[0].worktree

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
    },
    { candidate, omitStoredWorktree: options.omitStoredWorktree ?? false }
  )
}

async function updatePlan(morz: MorzApp, updated: TestPlan, expectedHash: string): Promise<TestPlan> {
  return morz.page.evaluate(
    async ({ updated, expectedHash }) => {
      const bridge = (window as unknown as {
        morzPlanner: {
          update(plan: TestPlan, expectedHash: string): Promise<{ plan: TestPlan }>
        }
      }).morzPlanner
      return (await bridge.update(updated, expectedHash)).plan
    },
    { updated, expectedHash }
  )
}

test.describe('orchestrator plan edit contract', () => {
  let morz: MorzApp

  test.beforeEach(async () => {
    morz = await launchMorz()
  })

  test.afterEach(async () => {
    if (morz) await closeMorz(morz.app)
  })

  test('allows routing to change only the planned cli', async () => {
    const stored = await seedProposedPlan(morz, plan('route-cli'))
    const routed = structuredClone(stored)
    routed.agents[0].cli = 'codex'

    const updated = await updatePlan(morz, routed, stored.planHash)

    expect(updated.agents[0].cli).toBe('codex')
    expect(updated.planHash).not.toBe(stored.planHash)
  })

  test('rejects agent identity and dispatch-field rewrites', async () => {
    const stored = await seedProposedPlan(morz, plan('immutable-fields'))
    const identityRewrite = structuredClone(stored)
    identityRewrite.agents[0].agentId = 'attacker'
    await expect(updatePlan(morz, identityRewrite, stored.planHash)).rejects.toThrow(/immutable/)

    const branchRewrite = structuredClone(stored)
    branchRewrite.agents[0].branch = 'run/attacker'
    await expect(updatePlan(morz, branchRewrite, stored.planHash)).rejects.toThrow(/immutable/)
  })

  test('accepts a missing-to-null worktree JSON round-trip', async () => {
    const stored = await seedProposedPlan(morz, plan('nullable-worktree'), {
      omitStoredWorktree: true
    })
    const roundTripped = structuredClone(stored)
    roundTripped.agents[0].worktree = null

    const updated = await updatePlan(morz, roundTripped, stored.planHash)

    expect(updated.agents[0].worktree).toBeNull()
  })
})

test('an orchestrated plan is never rewritten silently; routes surface as chips', async () => {
  const morz = await launchMorz()
  try {
    await morz.app.evaluate(({ ipcMain }) => {
      const candidate = {
        version: '1.0' as const,
        id: 'auto-route-once',
        goal: 'Review the orchestrator plan flow',
        agents: [
          {
            agentId: 'architect',
            cli: 'claude' as const,
            role: 'Architect reviewer',
            branch: 'run/auto-route-once/architect',
            worktree: null,
            cwd: '',
            promptSeed: 'Review the implementation.',
            dependsOn: [],
            port: null
          }
        ],
        spaceRoot: 'C:\\Projects\\morz',
        caps: { maxUsd: null, maxTokens: null },
        createdAt: '2026-07-16T12:00:00.000Z',
        planHash: 'a'.repeat(64)
      }
      const state = globalThis as unknown as { __morzRouteUpdates: number }
      state.__morzRouteUpdates = 0
      ipcMain.removeHandler('planner:plan')
      ipcMain.removeHandler('planner:update')
      ipcMain.handle('planner:plan', () => ({ plan: candidate, state: 'PROPOSED' }))
      ipcMain.handle('planner:update', () => {
        state.__morzRouteUpdates += 1
        throw new Error('Auto-route update rejected')
      })
    })

    const { page } = morz
    await page.getByRole('radio', { name: 'Orchestrated' }).click()
    await page.getByRole('textbox', { name: 'Goal' }).fill('Review the orchestrator plan flow')
    await page.getByRole('button', { name: 'Plan team' }).click()
    // The proposal stands as planned (claude) and the review rule is a chip.
    const card = page.getByRole('region', { name: 'Spawn plan' })
    await expect(card.getByRole('combobox', { name: 'Model for Architect reviewer' })).toHaveValue(
      'claude'
    )
    await expect(
      card.getByTestId('route-chip').filter({ hasText: "Route 'Architect reviewer' to Codex?" })
    ).toBeVisible()
    await page.waitForTimeout(1_000)

    const attempts = await morz.app.evaluate(
      () => (globalThis as unknown as { __morzRouteUpdates: number }).__morzRouteUpdates
    )
    expect(attempts).toBe(0)
  } finally {
    await closeMorz(morz.app)
  }
})

test('live Claude planning surfaces a route chip and reaches dispatch without an immutable-field error', async () => {
  test.skip(process.env.MORZ_LIVE_PLANNER !== '1', 'set MORZ_LIVE_PLANNER=1 for the live route proof')
  test.setTimeout(300_000)
  const morz = await launchMorz()
  try {
    const { page } = morz
    await page.getByRole('radio', { name: 'Orchestrated' }).click()
    await page
      .getByRole('textbox', { name: 'Goal' })
      .fill(
        'Propose exactly one agent with cli claude to review a code diff for correctness. Planning only; do not modify files.'
      )
    await page.getByRole('button', { name: 'Plan team' }).click()

    const card = page.getByRole('region', { name: 'Spawn plan' })
    await expect(card).toBeVisible({ timeout: 150_000 })
    const chip = card.getByTestId('route-chip').filter({ hasText: 'Codex' })
    await expect(chip).toBeVisible()
    await chip.getByRole('button', { name: 'Apply' }).click()
    await expect(card.getByText('codex', { exact: true })).toBeVisible()
    await expect(page.getByText(/immutable fields/)).toHaveCount(0)

    await card.getByRole('button', { name: 'Approve & Run' }).click()
    await expect(card.getByText('APPROVED', { exact: true })).toBeVisible()
    await expect(page.getByText(/^Run [0-9a-f-]{8}/i)).toBeVisible()
  } finally {
    await closeMorz(morz.app)
  }
})
