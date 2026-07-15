/*
 * Dispatcher (w5/dispatch, 0.0.3 "Orchestrated") — an approved SpawnPlan
 * becomes a real running team, visibly, with a clean kill.
 *
 * Owner pattern (roadmap/README.md): VISIBLE pane launch — automate exactly
 * what you'd type by hand. Per agent: git worktree add ..\<run-tag>-<agent>
 * -b <branch> beside the space root → assign $PORT from the pool → spawn a
 * real PTY pane cwd=worktree → type the CLI launch command into it. Agents
 * are launched CLIs in visible terminals, never hidden subagents.
 *
 * Hash gate: dispatch() re-hashes the submitted plan (canonicalPlanJson +
 * SHA-256) and refuses unless it matches BOTH the plan's own planHash and a
 * stored approved plan — the dispatcher only ever spawns from the stored
 * hashed plan the user approved.
 *
 * Everything is tagged with the runTag (worktree dir, MORZ_RUN env, paneId)
 * for one-click reversibility: stopRun() kills every agent's process tree
 * (PTY-host kill + taskkill /T fallback — the Job-Object stand-in from
 * pty-manager) and releases ports; cleanup() removes run-tagged worktrees
 * and branches.
 *
 * Test hook: MORZ_DISPATCH_STUB=1 skips typing the CLI launch command, so
 * every agent pane is a plain live shell (no LLM cost) — the e2e spec uses
 * this to exercise the full dispatch/stop/cleanup path.
 */
import { execFile, spawnSync } from 'child_process'
import { createHash, randomBytes, randomUUID } from 'crypto'
import { mkdirSync, rmSync, writeFileSync } from 'fs'
import { dirname, isAbsolute, join } from 'path'
import { promisify } from 'util'
import type { IpcMain } from 'electron'
import { RunApi, type TerminalSpawnOpts } from '../../shared/ipc'
import {
  canonicalPlanJson,
  SPAWN_PLAN_VERSION,
  type PlannedAgent,
  type PlannedCli,
  type RunStatus,
  type SpawnPlan
} from '../../shared/spawn-plan'
import { MORZ_AGENT_ID, type AgentId } from '../../shared/bus'
import { acceptTask, createTask } from '../bus/board'
import { journalEntries } from '../store/db'
import { PortPool } from './port-pool'
// Memory launch helper; the marked write-site below is the only behavior change.
import { memoryPort, prependRenderedMemory } from '../memory/learn-port'
import {
  agentTransition,
  consumeApprovedPlan,
  createRun,
  getAgentRows,
  getApprovedPlan,
  getRunRow,
  getRunStatus,
  listLiveRuns,
  listRuns as storeListRuns,
  patchAgent,
  releaseApprovedPlan,
  runTransition,
  storeApprovedPlan,
  TERMINAL_AGENT_STATES,
  TERMINAL_RUN_STATES,
  type RunSummary
} from './run-store'

const execFileAsync = promisify(execFile)

/** What the dispatcher needs from Main's PTY-host bridge (injected — the
 * host request plumbing lives in main/index.ts and is not importable). */
export interface DispatcherHost {
  spawnPane(opts: TerminalSpawnOpts): Promise<{ ok: boolean; error?: string }>
  writePane(paneId: string, data: string): void
  killPane(paneId: string): Promise<unknown>
  listPanes(): Promise<string[]>
  /** Broadcast a run-changed push to every window. */
  push(status: RunStatus): void
}

let host: DispatcherHost | null = null
const pool = new PortPool()
const watchers = new Map<string, NodeJS.Timeout>()
/** Runs mid-stop — the watcher must not race the kill with 'failed' marks. */
const stopping = new Set<string>()

function requireHost(): DispatcherHost {
  if (!host) throw new Error('[dispatch] dispatcher not registered')
  return host
}

/* ── plan hashing + validation ── */

export function hashPlan(plan: SpawnPlan): string {
  return createHash('sha256').update(canonicalPlanJson(plan), 'utf8').digest('hex')
}

const SAFE_AGENT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/ // mailbox dir rule (bus/mailbox.ts)
const SAFE_BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/

function validatePlan(plan: SpawnPlan): void {
  if (!plan || typeof plan !== 'object') throw new Error('[dispatch] not a SpawnPlan')
  if (plan.version !== SPAWN_PLAN_VERSION) {
    throw new Error(`[dispatch] unsupported plan version: ${String(plan.version)}`)
  }
  if (!plan.id || typeof plan.id !== 'string') throw new Error('[dispatch] plan needs an id')
  if (!isAbsolute(plan.spaceRoot ?? '')) {
    throw new Error('[dispatch] plan.spaceRoot must be an absolute path')
  }
  if (!Array.isArray(plan.agents) || plan.agents.length === 0) {
    throw new Error('[dispatch] plan has no agents')
  }
  const seen = new Set<string>()
  for (const agent of plan.agents) {
    if (!SAFE_AGENT_ID.test(agent.agentId)) {
      throw new Error(`[dispatch] unsafe agentId: ${JSON.stringify(agent.agentId)}`)
    }
    if (seen.has(agent.agentId)) throw new Error(`[dispatch] duplicate agentId: ${agent.agentId}`)
    seen.add(agent.agentId)
    if (!SAFE_BRANCH.test(agent.branch) || agent.branch.includes('..')) {
      throw new Error(`[dispatch] unsafe branch name: ${JSON.stringify(agent.branch)}`)
    }
    if (agent.cli !== 'claude' && agent.cli !== 'codex' && agent.cli !== 'agy') {
      throw new Error(`[dispatch] unknown cli: ${String(agent.cli)}`)
    }
    if (typeof agent.cwd !== 'string' || isAbsolute(agent.cwd) || agent.cwd.split(/[\\/]/).includes('..')) {
      throw new Error(`[dispatch] agent cwd must stay inside its worktree: ${JSON.stringify(agent.cwd)}`)
    }
    if (typeof agent.promptSeed !== 'string') {
      throw new Error(`[dispatch] agent ${agent.agentId} has no promptSeed`)
    }
    if (!Array.isArray(agent.dependsOn)) {
      throw new Error(`[dispatch] agent ${agent.agentId} dependsOn must be an array`)
    }
  }
}

/**
 * Approval stores the plan under its canonical hash (Main stamps the hash —
 * a plan arriving with a different non-empty planHash is refused).
 */
export function approvePlan(plan: SpawnPlan): { planHash: string } {
  validatePlan(plan)
  const planHash = hashPlan(plan)
  if (plan.planHash && plan.planHash !== planHash) {
    throw new Error('[dispatch] plan hash mismatch — planHash does not match the canonical plan JSON')
  }
  storeApprovedPlan({ ...plan, planHash })
  return { planHash }
}

/* ── visible launch plumbing ── */

function git(cwd: string, args: string[]): Promise<string> {
  return execFileAsync('git', args, {
    cwd,
    windowsHide: true,
    encoding: 'utf8',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }
  }).then(
    ({ stdout }) => stdout.trim(),
    (error) => {
      const stderr = (error as { stderr?: string }).stderr?.trim()
      throw new Error(`[dispatch] git ${args[0]} failed${stderr ? `: ${stderr}` : ''}`)
    }
  )
}

/** The command you'd type by hand to launch this agent's CLI on its seed. */
function launchCommand(cli: PlannedCli, seedPath: string): string {
  const quoted = `'${seedPath.replace(/'/g, "''")}'`
  switch (cli) {
    case 'claude':
      return `claude "$(Get-Content -Raw ${quoted})"`
    case 'codex':
      return `codex "$(Get-Content -Raw ${quoted})"`
    case 'agy':
      // agy takes no prompt argument — the adapter injects the seed via
      // bracketed paste once the TUI is up (Agent 4's lane).
      return 'agy'
  }
}

/** The 'spawned' journal row is written by Main as the host reports the pane.
 * ConPTY spawns report pid 0 until the datapipe connects, so the host
 * re-reports once the pid is real — poll until a positive pid lands. */
async function findPanePid(paneId: string): Promise<number | null> {
  for (let attempt = 0; attempt < 50; attempt++) {
    for (const row of journalEntries('pty-spawn')) {
      const info = row.payload as { paneId?: string; pid?: number } | null
      if (info?.paneId === paneId && typeof info.pid === 'number' && info.pid > 0) return info.pid
    }
    await new Promise((r) => setTimeout(r, 100))
  }
  return null
}

function killPidTree(pid: number): void {
  try {
    spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { timeout: 10_000, windowsHide: true })
  } catch {
    // best effort — the PTY-host kill already ran
  }
}

function push(runId: string): void {
  const status = getRunStatus(runId)
  if (status && host) host.push(status)
}

/* ── kickoff bus tasks (DAG deps gate claiming) ── */

/**
 * One kickoff task per agent on the 0.0.2 bus, created accepted so the CAS
 * claim gate applies: an agent can only claim its kickoff once every
 * dependency task is 'done'. A dependsOn entry naming another PLANNED
 * agentId resolves to that agent's kickoff task id; anything else passes
 * through as a literal bus TaskId (deps on pre-existing tasks).
 */
function createKickoffTasks(plan: SpawnPlan): Map<AgentId, string> {
  const taskByAgent = new Map<AgentId, string>()
  const plannedIds = new Set(plan.agents.map((a) => a.agentId))
  const remaining = [...plan.agents]
  while (remaining.length > 0) {
    const readyIndex = remaining.findIndex((agent) =>
      agent.dependsOn.every((dep) => !plannedIds.has(dep) || taskByAgent.has(dep))
    )
    if (readyIndex === -1) throw new Error('[dispatch] dependency cycle in plan DAG')
    const agent = remaining.splice(readyIndex, 1)[0]
    const dependsOn = agent.dependsOn.map((dep) => taskByAgent.get(dep) ?? dep)
    const task = createTask({
      title: `kickoff ${agent.agentId}: ${agent.role}`,
      createdBy: MORZ_AGENT_ID,
      dependsOn
    })
    acceptTask(task.id)
    taskByAgent.set(agent.agentId, task.id)
  }
  return taskByAgent
}

/* ── dispatch ── */

async function launchAgent(
  runId: string,
  runTag: string,
  plan: SpawnPlan,
  agent: PlannedAgent,
  kickoffTaskId: string
): Promise<void> {
  const h = requireHost()
  // ..\<run-tag>-<agent> beside the space root, exactly like a by-hand worktree
  const worktree = join(dirname(plan.spaceRoot), `${runTag}-${agent.agentId}`)
  await git(plan.spaceRoot, ['worktree', 'add', worktree, '-b', agent.branch])
  patchAgent(runId, agent.agentId, { worktree, kickoff_task_id: kickoffTaskId })

  const port = pool.alloc()
  patchAgent(runId, agent.agentId, { port })
  agentTransition(runId, agent.agentId, 'spawning')
  push(runId)

  const seedDir = join(worktree, '.morz')
  mkdirSync(seedDir, { recursive: true })
  const seedPath = join(seedDir, 'kickoff.md')
  // w8/memory-learn — prepend approved memory once per dispatched agent promptSeed.
  const promptSeed = prependRenderedMemory(
    memoryPort,
    { projectRoot: plan.spaceRoot, agentId: agent.agentId },
    agent.promptSeed
  )
  writeFileSync(seedPath, promptSeed, 'utf8')

  const paneId = `${runTag}-${agent.agentId}`
  const env: Record<string, string> = {
    MORZ_RUN: runTag,
    MORZ_RUN_ID: runId,
    MORZ_AGENT_ID: agent.agentId,
    // fixes the mailbox root — bus/mailbox.ts defaults to process.cwd()
    MORZ_SPACE: plan.spaceRoot,
    MORZ_KICKOFF_TASK: kickoffTaskId,
    PORT: String(port)
  }
  // bus reachability — explicit even though buildChildEnv forwards process.env
  if (process.env.MORZ_BUS_PIPE) env.MORZ_BUS_PIPE = process.env.MORZ_BUS_PIPE
  if (process.env.MORZ_BUS_TOKEN) env.MORZ_BUS_TOKEN = process.env.MORZ_BUS_TOKEN

  const spawned = await h.spawnPane({
    paneId,
    cwd: agent.cwd ? join(worktree, agent.cwd) : worktree,
    cols: 120,
    rows: 32,
    env
  })
  if (!spawned.ok) {
    throw new Error(`[dispatch] pane spawn failed for ${agent.agentId}: ${spawned.error ?? 'unknown'}`)
  }
  patchAgent(runId, agent.agentId, { pane_id: paneId })
  patchAgent(runId, agent.agentId, { pid: await findPanePid(paneId) })

  // the visible launch — type what you'd type by hand (stub skips the CLI)
  if (process.env.MORZ_DISPATCH_STUB !== '1') {
    h.writePane(paneId, `${launchCommand(agent.cli, seedPath)}\r`)
  }
  agentTransition(runId, agent.agentId, 'running')
  push(runId)
}

export async function dispatch(plan: SpawnPlan): Promise<{ runId: string }> {
  requireHost()
  validatePlan(plan)
  const planHash = hashPlan(plan)
  if (planHash !== plan.planHash) {
    throw new Error('[dispatch] plan hash mismatch — the plan differs from its planHash; refusing to spawn')
  }
  const stored = getApprovedPlan(planHash)
  if (!stored) {
    throw new Error('[dispatch] no approved plan with this hash — approval required before dispatch')
  }
  if (canonicalPlanJson(stored) !== canonicalPlanJson(plan)) {
    throw new Error('[dispatch] plan hash mismatch — submitted plan differs from the stored approved plan')
  }

  const runId = randomUUID()
  if (!consumeApprovedPlan(planHash, runId)) {
    throw new Error('[dispatch] plan already dispatched — approve a fresh plan')
  }
  const runTag = `run-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${randomBytes(3).toString('hex')}`
  createRun(runId, runTag, stored)
  runTransition(runId, 'dispatching')
  push(runId)

  try {
    const kickoffTasks = createKickoffTasks(stored)
    for (const agent of stored.agents) {
      await launchAgent(runId, runTag, stored, agent, kickoffTasks.get(agent.agentId)!)
    }
    runTransition(runId, 'running')
    push(runId)
    startWatcher(runId)
    return { runId }
  } catch (error) {
    // partial launch — tear down what exists, free the approval for a retry
    await teardownAgents(runId, stored.spaceRoot)
    runTransition(runId, 'aborted')
    releaseApprovedPlan(planHash, runId)
    push(runId)
    throw error
  }
}

/* ── stop + cleanup ── */

/** Kill every non-terminal agent's process tree, release its port, mark it cancelled. */
async function teardownAgents(runId: string, spaceRoot: string, removeWorktrees = true): Promise<void> {
  const h = requireHost()
  for (const row of getAgentRows(runId)) {
    if (!TERMINAL_AGENT_STATES.includes(row.state)) {
      if (row.pane_id) await Promise.resolve(h.killPane(row.pane_id)).catch(() => undefined)
      if (row.pid !== null) killPidTree(row.pid)
      agentTransition(runId, row.agent_id, 'cancelled')
    }
    if (row.port !== null) pool.release(row.port)
    if (removeWorktrees && row.worktree) {
      await removeWorktree(spaceRoot, row.worktree, row.branch)
      patchAgent(runId, row.agent_id, { worktree: null })
    }
  }
}

async function removeWorktree(spaceRoot: string, worktree: string, branch: string): Promise<void> {
  try {
    await git(spaceRoot, ['worktree', 'remove', '--force', worktree])
  } catch {
    rmSync(worktree, { recursive: true, force: true })
    await git(spaceRoot, ['worktree', 'prune']).catch(() => undefined)
  }
  await git(spaceRoot, ['branch', '-D', branch]).catch(() => undefined)
}

/** Global Stop: kill the whole team's process trees, release ports, mark cancelled.
 * Worktrees stay on disk for post-mortem — cleanup() removes them. */
export async function stopRun(runId: string): Promise<RunStatus> {
  const run = getRunRow(runId)
  if (!run) throw new Error(`[dispatch] unknown run: ${runId}`)
  if (TERMINAL_RUN_STATES.includes(run.state)) return getRunStatus(runId)!
  stopping.add(runId)
  try {
    stopWatcher(runId)
    await teardownAgents(runId, run.space_root, /* removeWorktrees */ false)
    runTransition(runId, 'aborted')
  } finally {
    stopping.delete(runId)
  }
  push(runId)
  return getRunStatus(runId)!
}

/** Remove every run-tagged worktree + branch. Only after the run has ended. */
export async function cleanup(runId: string): Promise<RunStatus> {
  const run = getRunRow(runId)
  if (!run) throw new Error(`[dispatch] unknown run: ${runId}`)
  if (!TERMINAL_RUN_STATES.includes(run.state)) {
    throw new Error('[dispatch] cleanup requires a finished or stopped run — call stopRun first')
  }
  for (const row of getAgentRows(runId)) {
    if (row.worktree) {
      await removeWorktree(run.space_root, row.worktree, row.branch)
      patchAgent(runId, row.agent_id, { worktree: null })
    }
  }
  push(runId)
  return getRunStatus(runId)!
}

/* ── liveness watcher ── */

function startWatcher(runId: string): void {
  if (watchers.has(runId)) return
  const timer = setInterval(() => {
    void watchTick(runId)
  }, 2_000)
  timer.unref?.()
  watchers.set(runId, timer)
}

function stopWatcher(runId: string): void {
  const timer = watchers.get(runId)
  if (timer) clearInterval(timer)
  watchers.delete(runId)
}

async function watchTick(runId: string): Promise<void> {
  const h = host
  if (!h || stopping.has(runId)) return
  let panes: Set<string>
  try {
    panes = new Set(await h.listPanes())
  } catch {
    return // host restarting — next tick
  }
  if (stopping.has(runId)) return
  let changed = false
  for (const row of getAgentRows(runId)) {
    if (TERMINAL_AGENT_STATES.includes(row.state)) continue
    if (row.pane_id && !panes.has(row.pane_id)) {
      // pane died under the agent (crash or user closed it)
      agentTransition(runId, row.agent_id, 'failed')
      if (row.port !== null) pool.release(row.port)
      changed = true
    }
  }
  const rows = getAgentRows(runId)
  if (rows.length > 0 && rows.every((r) => TERMINAL_AGENT_STATES.includes(r.state))) {
    const run = getRunRow(runId)
    if (run && !TERMINAL_RUN_STATES.includes(run.state)) {
      runTransition(runId, rows.every((r) => r.state === 'done') ? 'done' : 'aborted')
      changed = true
    }
    stopWatcher(runId)
  }
  if (changed) push(runId)
}

/* ── adapter seam: validated agent-state updates (blocked/rate-limited/review/done) ── */

export function setAgentRunState(
  runId: string,
  agentId: AgentId,
  state: 'blocked' | 'rate-limited' | 'review' | 'running' | 'done' | 'failed'
): RunStatus {
  agentTransition(runId, agentId, state)
  push(runId)
  return getRunStatus(runId)!
}

/* ── queries ── */

export function listRuns(): RunSummary[] {
  return storeListRuns()
}

export function runStatus(runId: string): RunStatus | null {
  return getRunStatus(runId)
}

/* ── registration ── */

/** Runs a crashed app left mid-flight: panes died with the old PTY-host and
 * the MORZ_SESSION sweep reaped the children — reflect that in the store. */
function sweepStaleRuns(): void {
  for (const run of listLiveRuns()) {
    for (const row of getAgentRows(run.run_id)) {
      if (!TERMINAL_AGENT_STATES.includes(row.state)) {
        try {
          agentTransition(run.run_id, row.agent_id, 'cancelled')
        } catch {
          // already terminal in a racing writer — fine
        }
      }
    }
    try {
      runTransition(run.run_id, 'aborted')
    } catch {
      // already terminal — fine
    }
  }
}

export function registerDispatchIpc(ipcMain: IpcMain, deps: DispatcherHost): void {
  host = deps
  sweepStaleRuns()
  ipcMain.handle(RunApi.approvePlan, (_e, plan: SpawnPlan) => approvePlan(plan))
  ipcMain.handle(RunApi.dispatch, (_e, plan: SpawnPlan) => dispatch(plan))
  ipcMain.handle(RunApi.list, () => listRuns())
  ipcMain.handle(RunApi.status, (_e, runId: string) => runStatus(runId))
  ipcMain.handle(RunApi.stop, (_e, runId: string) => stopRun(runId))
  ipcMain.handle(RunApi.cleanup, (_e, runId: string) => cleanup(runId))
}
