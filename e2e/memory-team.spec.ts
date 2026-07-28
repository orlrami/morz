/*
 * w17/context-blocks — `space` scope is ONE shared team block.
 *
 * Two bugs met here. The dispatcher passed `projectRoot` + `agentId` into the
 * memory render and dropped `spaceId` (dispatcher.ts:325), so a space-scoped
 * fact never reached a dispatched team at all. And a Space's identity lives in
 * the renderer, so main had nothing to resolve it with — the space registry
 * (services/space-registry.ts) closes that gap.
 *
 * The assertion: every agent dispatched into a Space gets the SAME space fact,
 * byte-identical, and a fact scoped to a different Space reaches none of them.
 *
 * MORZ_DISPATCH_STUB=1 — no CLI launches. The memory render is real.
 */
import { expect, test } from '@playwright/test'
import { execFileSync, spawnSync } from 'child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { SpaceRegistrySnapshot } from '../src/shared/space-registry'
import { closeMorz, launchMorz, ROOT } from './app'

interface MemoryTeamWindow {
  morzSpaces: { testSnapshot?(): Promise<SpaceRegistrySnapshot> }
  morz: {
    memory: { save(entry: unknown): Promise<unknown> }
    run: {
      approvePlan(plan: unknown): Promise<{ planHash: string }>
      dispatch(plan: unknown): Promise<{ runId: string }>
      runStatus(runId: string): Promise<{
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

function makeSpace(parent: string, name: string): string {
  const root = join(parent, name)
  mkdirSync(root, { recursive: true })
  writeFileSync(join(root, 'README.md'), `# ${name} fixture\n`, 'utf8')
  git(root, 'init', '-b', 'main')
  git(root, 'config', 'user.name', 'Morz Team Test')
  git(root, 'config', 'user.email', 'memory-team@morz.invalid')
  git(root, 'add', '-A')
  git(root, 'commit', '-m', `test: ${name} fixture`)
  return root
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

test('a space-scoped fact reaches every agent of that team and no other space', async () => {
  const fixtureParent = join(ROOT, 'e2e', '.tmp', `memory-team-${Date.now()}`)
  const teamRoot = makeSpace(fixtureParent, 'team')
  const otherRoot = makeSpace(fixtureParent, 'other')

  process.env.MORZ_E2E = '1'
  process.env.MORZ_DISPATCH_STUB = '1'
  const { app, page } = await launchMorz()
  delete process.env.MORZ_DISPATCH_STUB

  let runId: string | null = null
  try {
    // Spaces are renderer state; seeding localStorage and reloading exercises
    // the real publish path (spaceStore subscription → main registry).
    await page.evaluate(
      ({ team, other }) => {
        localStorage.setItem('morz.spaces', JSON.stringify({
          state: {
            spaces: [
              { id: 'team-space', name: 'Team', root: team, agents: [] },
              { id: 'other-space', name: 'Other', root: other, agents: [] }
            ],
            activeSpaceId: 'team-space',
            initialized: true
          },
          version: 2
        }))
      },
      { team: teamRoot, other: otherRoot }
    )
    await page.reload()
    await page.waitForLoadState('domcontentloaded')
    await page.waitForFunction(async () => {
      const snapshot = await (window as unknown as MemoryTeamWindow).morzSpaces.testSnapshot?.()
      return snapshot?.spaces.some((space) => space.id === 'team-space') === true
    }, undefined, { timeout: 20_000 })

    await page.evaluate(async () => {
      const now = '2026-07-27T12:00:00.000Z'
      const base = { origin: 'user' as const, kind: 'rule' as const, createdAt: now, updatedAt: now, enabled: true }
      const memory = (window as unknown as MemoryTeamWindow).morz.memory
      await memory.save({
        ...base,
        id: 'team-handoff-protocol',
        scope: 'space',
        scopeRef: 'team-space',
        title: 'Hand off through the bus',
        body: 'Post a handoff task; never edit another agent branch.'
      })
      await memory.save({
        ...base,
        id: 'other-space-secret',
        scope: 'space',
        scopeRef: 'other-space',
        title: 'Other space only rule',
        body: 'This must never leak into the team space.'
      })
    })

    const agent = (agentId: string): Record<string, unknown> => ({
      agentId,
      cli: 'claude',
      role: `builder: ${agentId}`,
      branch: `run/memory-team/${agentId}`,
      worktree: null,
      cwd: '',
      promptSeed: `You are ${agentId}.`,
      dependsOn: [],
      port: null
    })
    const plan = {
      version: '1.0',
      id: 'plan-memory-team',
      goal: 'team memory',
      agents: [agent('alpha'), agent('beta')],
      spaceRoot: teamRoot,
      caps: { maxUsd: null, maxTokens: null },
      createdAt: new Date().toISOString(),
      planHash: ''
    }

    const { planHash } = await page.evaluate(
      (value) => (window as unknown as MemoryTeamWindow).morz.run.approvePlan(value),
      plan
    )
    const dispatched = await page.evaluate(
      (value) => (window as unknown as MemoryTeamWindow).morz.run.dispatch(value),
      { ...plan, planHash }
    )
    runId = dispatched.runId
    const status = (await page.evaluate(
      (id) => (window as unknown as MemoryTeamWindow).morz.run.runStatus(id),
      runId
    ))!

    const seeds = ['alpha', 'beta'].map((agentId) =>
      readFileSync(join(status.agentsDetail[agentId].worktree!, '.morz', 'kickoff.md'), 'utf8')
    )
    for (const seed of seeds) {
      expect(seed).toContain('Hand off through the bus')
      expect(seed).not.toContain('Other space only rule')
    }
    // one team block, not per-agent copies: the shared prefix is identical and
    // the seeds differ only by each agent's own prompt
    expect(seeds[0].replace('You are alpha.', '')).toBe(seeds[1].replace('You are beta.', ''))
  } finally {
    if (runId) {
      await page.evaluate(
        (id) => (window as unknown as MemoryTeamWindow).morz.run.stopRun(id),
        runId
      ).catch(() => undefined)
      await page.evaluate(
        (id) => (window as unknown as MemoryTeamWindow).morz.run.cleanup(id),
        runId
      ).catch(() => undefined)
    }
    await closeMorz(app)
    delete process.env.MORZ_E2E
    removeFixture(fixtureParent)
  }
})
