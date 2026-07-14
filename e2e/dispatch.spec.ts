/*
 * w5/dispatch e2e — an approved SpawnPlan becomes a real running team, with a
 * clean kill. The agent CLI is REPLACED by a stub (MORZ_DISPATCH_STUB=1: the
 * pane spawns the plain shell and the launch command is never typed), so the
 * whole dispatch/stop/cleanup path runs with zero LLM cost.
 */
import { expect, test } from '@playwright/test'
import { execFileSync, spawnSync } from 'child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { closeMorz, launchMorz, waitForTerm, runInPane, ROOT, PROMPT_RE } from './app'

// must be set before launchMorz copies process.env into the app env
process.env.MORZ_DISPATCH_STUB = '1'

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
      listRuns(): Promise<{ runId: string; runTag: string; state: string }[]>
      runStatus(runId: string): Promise<RunStatus | null>
      stopRun(runId: string): Promise<RunStatus>
      cleanup(runId: string): Promise<RunStatus>
    }
    pty: { list(): Promise<string[]> }
    bus: {
      listTasks(filter?: unknown): Promise<{ id: string; state: string; dependsOn: string[] }[]>
      claimTask(taskId: string, agentId: string): Promise<{ id: string } | null>
      completeTask(taskId: string, agentId: string, artifact: { label: string }): Promise<{ id: string }>
    }
  }
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim()
}

function pidAlive(pid: number): boolean {
  const out = spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], {
    windowsHide: true,
    timeout: 10_000
  }).stdout?.toString()
  return !!out && out.includes(`"${pid}"`)
}

async function waitPidsDead(pids: number[], timeoutMs = 20_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (pids.every((pid) => !pidAlive(pid))) return true
    if (Date.now() > deadline) return false
    await new Promise((r) => setTimeout(r, 500))
  }
}

function makePlan(spaceRoot: string, id: string, agents: { agentId: string; branch: string; dependsOn: string[] }[]): unknown {
  return {
    version: '1.0',
    id,
    goal: 'finish X with a small team',
    agents: agents.map((a) => ({
      agentId: a.agentId,
      cli: 'claude',
      role: `builder: ${a.agentId}`,
      branch: a.branch,
      worktree: null,
      cwd: '',
      promptSeed: `You are ${a.agentId}. Do the thing.`,
      dependsOn: a.dependsOn,
      port: null
    })),
    spaceRoot,
    caps: { maxUsd: null, maxTokens: null },
    createdAt: new Date().toISOString(),
    planHash: ''
  }
}

test('dispatch runs an approved 2-agent plan visibly; Stop kills the tree; cleanup removes worktrees', async () => {
  const fixtureParent = join(ROOT, 'e2e', '.tmp', `dispatch-${Date.now()}`)
  const spaceRoot = join(fixtureParent, 'space')
  mkdirSync(spaceRoot, { recursive: true })
  writeFileSync(join(spaceRoot, 'README.md'), '# dispatch fixture\n', 'utf8')
  git(spaceRoot, 'init', '-b', 'main')
  git(spaceRoot, 'config', 'user.name', 'Morz Dispatch Test')
  git(spaceRoot, 'config', 'user.email', 'dispatch-test@morz.invalid')
  git(spaceRoot, 'add', '-A')
  git(spaceRoot, 'commit', '-m', 'test: dispatch fixture')

  const { app, page } = await launchMorz()
  try {
    const plan = makePlan(spaceRoot, 'plan-dispatch-e2e-1', [
      { agentId: 'alpha', branch: 'run/e2e/alpha', dependsOn: [] },
      { agentId: 'beta', branch: 'run/e2e/beta', dependsOn: ['alpha'] } // DAG: beta waits on alpha
    ])

    // approval stamps + stores the canonical hash
    const { planHash } = await page.evaluate(
      (p) => (window as unknown as MorzRunWindow).morz.run.approvePlan(p),
      plan
    )
    expect(planHash).toMatch(/^[a-f0-9]{64}$/)

    // hash gate: a tampered plan carrying the approved hash is refused
    await expect(
      page.evaluate(
        (p) => (window as unknown as MorzRunWindow).morz.run.dispatch(p),
        { ...(plan as Record<string, unknown>), planHash, goal: 'tampered goal' }
      )
    ).rejects.toThrow(/hash mismatch/i)

    // dispatch the real approved plan
    const { runId } = await page.evaluate(
      (p) => (window as unknown as MorzRunWindow).morz.run.dispatch(p),
      { ...(plan as Record<string, unknown>), planHash }
    )
    const status = (await page.evaluate(
      (id) => (window as unknown as MorzRunWindow).morz.run.runStatus(id),
      runId
    ))!
    expect(status.state).toBe('running')
    expect(status.agents).toEqual({ alpha: 'running', beta: 'running' })
    const alpha = status.agentsDetail!.alpha
    const beta = status.agentsDetail!.beta

    // 2 worktrees, run-tagged, on the right branches, beside the space root
    for (const [detail, branch, agentId] of [
      [alpha, 'run/e2e/alpha', 'alpha'],
      [beta, 'run/e2e/beta', 'beta']
    ] as const) {
      expect(detail.worktree).toBe(join(fixtureParent, `${status.runTag}-${agentId}`))
      expect(existsSync(detail.worktree!)).toBe(true)
      expect(git(detail.worktree!, 'branch', '--show-current')).toBe(branch)
      expect(existsSync(join(detail.worktree!, '.morz', 'kickoff.md'))).toBe(true)
    }

    // 2 live panes on the PTY-host
    const panes = await page.evaluate(() => (window as unknown as MorzRunWindow).morz.pty.list())
    expect(panes).toContain(alpha.paneId)
    expect(panes).toContain(beta.paneId)

    // distinct $PORT assignments + run/space env visible inside the pane
    expect(typeof alpha.port).toBe('number')
    expect(typeof beta.port).toBe('number')
    expect(alpha.port).not.toBe(beta.port)
    await waitForTerm(page, alpha.paneId, PROMPT_RE)
    await runInPane(page, alpha.paneId, 'echo "ENV:$env:MORZ_RUN|$env:MORZ_SPACE|$env:PORT|$env:MORZ_AGENT_ID"')
    const envLine = await waitForTerm(
      page,
      alpha.paneId,
      new RegExp(`ENV:${status.runTag}\\|[^|]*space\\|${alpha.port}\\|alpha`)
    )
    expect(envLine).toContain(`ENV:${status.runTag}`)

    // DAG gate on the 0.0.2 bus: beta's kickoff is unclaimable until alpha's is done
    const tasks = await page.evaluate(() => (window as unknown as MorzRunWindow).morz.bus.listTasks())
    const betaTask = tasks.find((t) => t.id === beta.kickoffTaskId)!
    expect(betaTask.dependsOn).toContain(alpha.kickoffTaskId)
    const betaClaim = await page.evaluate(
      (id) => (window as unknown as MorzRunWindow).morz.bus.claimTask(id, 'beta'),
      beta.kickoffTaskId!
    )
    expect(betaClaim).toBeNull() // dep unmet
    const alphaClaim = await page.evaluate(
      (id) => (window as unknown as MorzRunWindow).morz.bus.claimTask(id, 'alpha'),
      alpha.kickoffTaskId!
    )
    expect(alphaClaim).not.toBeNull()
    await page.evaluate(
      (id) => (window as unknown as MorzRunWindow).morz.bus.completeTask(id, 'alpha', { label: 'kickoff done' }),
      alpha.kickoffTaskId!
    )
    const betaClaim2 = await page.evaluate(
      (id) => (window as unknown as MorzRunWindow).morz.bus.claimTask(id, 'beta'),
      beta.kickoffTaskId!
    )
    expect(betaClaim2).not.toBeNull() // dep done → claimable

    // ── global Stop: whole process tree dies, no zombies ──
    const pids = [alpha.pid, beta.pid].filter((p): p is number => typeof p === 'number')
    expect(pids).toHaveLength(2)
    expect(pids.every((p) => p > 0)).toBe(true) // never the ConPTY pid-0 placeholder
    expect(pids.every(pidAlive)).toBe(true)
    const stopped = await page.evaluate(
      (id) => (window as unknown as MorzRunWindow).morz.run.stopRun(id),
      runId
    )
    expect(stopped.state).toBe('aborted')
    expect(stopped.agents).toEqual({ alpha: 'cancelled', beta: 'cancelled' })
    await expect
      .poll(async () => page.evaluate(() => (window as unknown as MorzRunWindow).morz.pty.list()))
      .not.toContain(alpha.paneId)
    const dead = await waitPidsDead(pids)
    if (!dead) {
      for (const pid of pids) {
        console.log(
          `pid ${pid}: ${spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { windowsHide: true }).stdout?.toString().trim()}`
        )
      }
    }
    expect(dead).toBe(true)

    // ports released: a fresh 1-agent dispatch reuses the lowest freed port
    const plan2 = makePlan(spaceRoot, 'plan-dispatch-e2e-2', [
      { agentId: 'gamma', branch: 'run/e2e/gamma', dependsOn: [] }
    ])
    const approved2 = await page.evaluate(
      (p) => (window as unknown as MorzRunWindow).morz.run.approvePlan(p),
      plan2
    )
    const run2 = await page.evaluate(
      (p) => (window as unknown as MorzRunWindow).morz.run.dispatch(p),
      { ...(plan2 as Record<string, unknown>), planHash: approved2.planHash }
    )
    const status2 = (await page.evaluate(
      (id) => (window as unknown as MorzRunWindow).morz.run.runStatus(id),
      run2.runId
    ))!
    expect(status2.agentsDetail!.gamma.port).toBe(Math.min(alpha.port!, beta.port!))
    await page.evaluate((id) => (window as unknown as MorzRunWindow).morz.run.stopRun(id), run2.runId)

    // ── cleanup: run-tagged worktrees + branches fully removed ──
    for (const id of [runId, run2.runId]) {
      await page.evaluate(
        (rid) => (window as unknown as MorzRunWindow).morz.run.cleanup(rid),
        id
      )
    }
    expect(existsSync(alpha.worktree!)).toBe(false)
    expect(existsSync(beta.worktree!)).toBe(false)
    const worktrees = git(spaceRoot, 'worktree', 'list', '--porcelain')
    expect(worktrees.split(/\r?\n/).filter((l) => l.startsWith('worktree '))).toHaveLength(1)
    expect(git(spaceRoot, 'branch', '--list', 'run/e2e/*')).toBe('')
  } finally {
    await closeMorz(app)
    rmSync(fixtureParent, { recursive: true, force: true })
  }
})
