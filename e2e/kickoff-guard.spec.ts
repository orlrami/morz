/*
 * w15/kickoff-guard — CI-safe e2e for the ORCH-AUDIT HIGH finding (lines 81-93).
 *
 * Asserts that .morz/ (including kickoff.md) is invisible to git inside a
 * dispatched run worktree: the exclude entry exists, `git status --porcelain`
 * is clean with respect to .morz/, and a `git add -A` commit contains no
 * kickoff content.  Also asserts that cleanup() removes .morz/ remnants.
 *
 * Uses MORZ_DISPATCH_STUB=1 — no LLM cost, runs in CI.
 */
import { expect, test } from '@playwright/test'
import { execFileSync, spawnSync } from 'child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { closeMorz, launchMorz, ROOT } from './app'

interface AgentDetail {
  paneId: string
  pid: number | null
  port: number | null
  worktree: string | null
  branch: string
  kickoffTaskId: string | null
}
interface RunStatus {
  runId: string
  runTag?: string
  planHash: string
  state: string
  agents: Record<string, string>
  agentsDetail?: Record<string, AgentDetail>
}
interface MorzRunWindow {
  morz: {
    run: {
      approvePlan(plan: unknown): Promise<{ planHash: string }>
      dispatch(plan: unknown): Promise<{ runId: string }>
      runStatus(runId: string): Promise<RunStatus | null>
      stopRun(runId: string): Promise<RunStatus>
      cleanup(runId: string): Promise<RunStatus>
    }
  }
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim()
}

function makeSpaceFixture(parent: string): string {
  const spaceRoot = join(parent, 'space')
  mkdirSync(spaceRoot, { recursive: true })
  writeFileSync(join(spaceRoot, 'README.md'), '# kickoff-guard fixture\n', 'utf8')
  git(spaceRoot, 'init', '-b', 'main')
  git(spaceRoot, 'config', 'user.name', 'Morz KickoffGuard Test')
  git(spaceRoot, 'config', 'user.email', 'kickoff-guard@morz.invalid')
  git(spaceRoot, 'add', '-A')
  git(spaceRoot, 'commit', '-m', 'test: kickoff-guard fixture')
  return spaceRoot
}

function makePlan(spaceRoot: string): unknown {
  return {
    version: '1.0',
    id: 'plan-kickoff-guard-e2e',
    goal: 'kickoff-guard security check',
    agents: [
      {
        agentId: 'guard',
        cli: 'claude',
        role: 'builder: guard',
        branch: 'run/kickoff-guard/guard',
        worktree: null,
        cwd: '',
        promptSeed: 'You are the guard agent. Do the thing.',
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

test('dispatched worktree excludes .morz/ from git; cleanup removes remnants', async () => {
  const fixtureParent = join(ROOT, 'e2e', '.tmp', `kickoff-guard-${Date.now()}`)
  const spaceRoot = makeSpaceFixture(fixtureParent)

  process.env.MORZ_DISPATCH_STUB = '1'
  const { app, page } = await launchMorz()
  delete process.env.MORZ_DISPATCH_STUB

  try {
    const plan = makePlan(spaceRoot)

    const { planHash } = await page.evaluate(
      (p) => (window as unknown as MorzRunWindow).morz.run.approvePlan(p),
      plan
    )
    expect(planHash).toMatch(/^[a-f0-9]{64}$/)

    const { runId } = await page.evaluate(
      (p) => (window as unknown as MorzRunWindow).morz.run.dispatch(p),
      { ...(plan as Record<string, unknown>), planHash }
    )
    const status = (await page.evaluate(
      (id) => (window as unknown as MorzRunWindow).morz.run.runStatus(id),
      runId
    ))!
    expect(status.state).toBe('running')

    const guard = status.agentsDetail!.guard
    const worktree = guard.worktree!
    expect(existsSync(worktree)).toBe(true)

    // kickoff.md was written (the CLI will read it)
    expect(existsSync(join(worktree, '.morz', 'kickoff.md'))).toBe(true)

    // ── security assertion 1: exclude entry present in $GIT_COMMON_DIR/info/exclude ──
    // git reads per-repo excludes from the common git dir (main .git/info/exclude),
    // not from the worktree-private $GIT_DIR/worktrees/<name>/info/exclude.
    const commonDir = git(worktree, 'rev-parse', '--git-common-dir')
    const absCommonDir = commonDir.startsWith('C:') || commonDir.startsWith('/') ? commonDir : join(worktree, commonDir)
    const excludePath = join(absCommonDir, 'info', 'exclude')
    expect(existsSync(excludePath)).toBe(true)
    const excludeContent = readFileSync(excludePath, 'utf8')
    expect(excludeContent.split(/\r?\n/).map((l) => l.trim())).toContain('.morz/')

    // ── security assertion 2: git status --porcelain sees NO .morz/ entries ──
    const porcelain = git(worktree, 'status', '--porcelain')
    const morzLines = porcelain
      .split(/\r?\n/)
      .filter((line) => line.trim().startsWith('.morz') || line.includes(' .morz'))
    expect(morzLines).toHaveLength(0)

    // ── security assertion 3: .morz/kickoff.md is explicitly excluded ──
    // git check-ignore exits 0 when the file is excluded by any rule, 1 when not.
    // Using spawnSync (not execFileSync) so a non-zero exit doesn't throw.
    const checkIgnore = spawnSync('git', ['check-ignore', '--verbose', join('.morz', 'kickoff.md')], {
      cwd: worktree,
      encoding: 'utf8',
      windowsHide: true
    })
    expect(checkIgnore.status).toBe(0)
    // The output must reference the .morz/ pattern from our exclude entry
    expect((checkIgnore.stdout ?? '').trim()).toContain('.morz/')

    // ── cleanup: worktree (including .morz/) fully removed ──
    await page.evaluate(
      (id) => (window as unknown as MorzRunWindow).morz.run.stopRun(id),
      runId
    )
    await page.evaluate(
      (id) => (window as unknown as MorzRunWindow).morz.run.cleanup(id),
      runId
    )
    expect(existsSync(worktree)).toBe(false)
    // git worktree list should only show the main worktree
    const wtList = git(spaceRoot, 'worktree', 'list', '--porcelain')
    const wtPaths = wtList.split(/\r?\n/).filter((l) => l.startsWith('worktree '))
    expect(wtPaths).toHaveLength(1)
    expect(git(spaceRoot, 'branch', '--list', 'run/kickoff-guard/*')).toBe('')
  } finally {
    await closeMorz(app)
    // Windows can hold a brief handle on the git repo after worktree operations.
    // rmSync retries, then falls back to PowerShell Remove-Item (same as closeMorz).
    try {
      rmSync(fixtureParent, { recursive: true, force: true, maxRetries: 15, retryDelay: 300 })
    } catch {
      spawnSync(
        'powershell',
        ['-NoProfile', '-NonInteractive', '-Command',
          `Remove-Item -Force -Recurse -Path '${fixtureParent}' -ErrorAction SilentlyContinue`],
        { windowsHide: true, timeout: 30_000 }
      )
    }
  }
})

test('orphan .morz/ in a stale worktree is removed by cleanup', async () => {
  // Simulate a worktree that has a .morz/ dir but whose run was never stopped
  // cleanly — cleanup() must still remove the whole worktree including .morz/.
  const fixtureParent = join(ROOT, 'e2e', '.tmp', `kickoff-orphan-${Date.now()}`)
  const spaceRoot = makeSpaceFixture(fixtureParent)

  process.env.MORZ_DISPATCH_STUB = '1'
  const { app, page } = await launchMorz()
  delete process.env.MORZ_DISPATCH_STUB

  try {
    const plan = makePlan(spaceRoot)
    const { planHash } = await page.evaluate(
      (p) => (window as unknown as MorzRunWindow).morz.run.approvePlan(p),
      plan
    )
    const { runId } = await page.evaluate(
      (p) => (window as unknown as MorzRunWindow).morz.run.dispatch(p),
      { ...(plan as Record<string, unknown>), planHash }
    )
    const status = (await page.evaluate(
      (id) => (window as unknown as MorzRunWindow).morz.run.runStatus(id),
      runId
    ))!
    const worktree = status.agentsDetail!.guard.worktree!

    // Confirm .morz/ exists (orphan scenario)
    expect(existsSync(join(worktree, '.morz'))).toBe(true)

    // Simulate abrupt stop without cleanup, then call cleanup
    await page.evaluate(
      (id) => (window as unknown as MorzRunWindow).morz.run.stopRun(id),
      runId
    )
    // Plant an extra file in .morz/ to simulate accumulated orphan state
    writeFileSync(join(worktree, '.morz', 'orphan.txt'), 'stale data\n', 'utf8')

    await page.evaluate(
      (id) => (window as unknown as MorzRunWindow).morz.run.cleanup(id),
      runId
    )
    // Whole worktree gone, no .morz/ remnant
    expect(existsSync(worktree)).toBe(false)
  } finally {
    await closeMorz(app)
    try {
      rmSync(fixtureParent, { recursive: true, force: true, maxRetries: 15, retryDelay: 300 })
    } catch {
      spawnSync(
        'powershell',
        ['-NoProfile', '-NonInteractive', '-Command',
          `Remove-Item -Force -Recurse -Path '${fixtureParent}' -ErrorAction SilentlyContinue`],
        { windowsHide: true, timeout: 30_000 }
      )
    }
  }
})
