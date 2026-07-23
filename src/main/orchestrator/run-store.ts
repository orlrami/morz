/*
 * Run-state machine in SQLite (w5/dispatch, 0.0.3 "Orchestrated").
 * Same morz.db as the session store + bus board (own connection, WAL on).
 *
 * Three tables:
 *   orch_plans  — approved SpawnPlans, hash-keyed; consumed (run_id set) by
 *                 exactly one dispatch (guarded UPDATE, organizer-style).
 *   orch_runs   — whole-run lifecycle (RunState, spawn-plan.ts):
 *                 draft→proposed→approved→dispatching→running→merging→{done,aborted}
 *   orch_agents — per-agent lifecycle (AgentRunState):
 *                 queued→spawning→running→{blocked,rate-limited}→review→{done,failed,cancelled}
 *
 * Every transition is a CAS-style UPDATE guarded by the allowed from-states,
 * so illegal transitions are enforced at the SQL layer — an UPDATE matching
 * 0 rows throws (same pattern as bus/board.ts).
 */
import Database from 'better-sqlite3'
import { app } from 'electron'
import { join } from 'path'
import { mkdirSync } from 'fs'
import type { AgentId } from '../../shared/bus'
import type { RunSummary } from '../../shared/ipc'
import type {
  AgentRunDetail,
  AgentRunState,
  RunState,
  RunStatus,
  SpawnPlan
} from '../../shared/spawn-plan'

let db: Database.Database | null = null

function open(): Database.Database {
  if (db) return db
  const dir = join(app.getPath('appData'), 'Morz')
  mkdirSync(dir, { recursive: true })
  db = new Database(join(dir, 'morz.db'))
  db.pragma('journal_mode = WAL')
  db.exec(`
    CREATE TABLE IF NOT EXISTS orch_plans (
      plan_hash   TEXT PRIMARY KEY,
      plan_id     TEXT NOT NULL,
      json        TEXT NOT NULL,
      approved_at TEXT NOT NULL,
      run_id      TEXT
    );
    CREATE TABLE IF NOT EXISTS orch_runs (
      run_id     TEXT PRIMARY KEY,
      run_tag    TEXT NOT NULL,
      plan_hash  TEXT NOT NULL,
      space_root TEXT NOT NULL,
      goal       TEXT NOT NULL,
      state      TEXT NOT NULL,
      plan_json  TEXT NOT NULL,
      created_at TEXT NOT NULL,
      started_at TEXT,
      ended_at   TEXT
    );
    CREATE TABLE IF NOT EXISTS orch_agents (
      run_id          TEXT NOT NULL,
      agent_id        TEXT NOT NULL,
      state           TEXT NOT NULL,
      cli             TEXT NOT NULL,
      role            TEXT NOT NULL,
      branch          TEXT NOT NULL,
      worktree        TEXT,
      pane_id         TEXT,
      pid             INTEGER,
      port            INTEGER,
      kickoff_task_id TEXT,
      PRIMARY KEY (run_id, agent_id)
    );
    CREATE INDEX IF NOT EXISTS orch_runs_state ON orch_runs (state);
  `)
  return db
}

function nowIso(): string {
  return new Date().toISOString()
}

/* ── frozen transition maps (spawn-plan.ts contract) ── */

const RUN_TRANSITIONS: Record<RunState, RunState[]> = {
  draft: ['proposed'],
  proposed: ['approved'],
  approved: ['dispatching'],
  dispatching: ['running', 'aborted'],
  running: ['merging', 'done', 'aborted'],
  merging: ['done', 'aborted'],
  done: [],
  aborted: []
}

const AGENT_TRANSITIONS: Record<AgentRunState, AgentRunState[]> = {
  queued: ['spawning', 'cancelled'],
  spawning: ['running', 'failed', 'cancelled'],
  running: ['blocked', 'rate-limited', 'review', 'done', 'failed', 'cancelled'],
  blocked: ['running', 'failed', 'cancelled'],
  'rate-limited': ['running', 'failed', 'cancelled'],
  review: ['running', 'done', 'failed', 'cancelled'],
  done: [],
  failed: [],
  cancelled: []
}

export const TERMINAL_RUN_STATES: readonly RunState[] = ['done', 'aborted']
export const TERMINAL_AGENT_STATES: readonly AgentRunState[] = ['done', 'failed', 'cancelled']

function illegal(scope: string, from: string | undefined, to: string): Error {
  return new Error(`[dispatch] illegal ${scope} transition: ${from ?? '(missing)'} → ${to}`)
}

/* ── approved-plan store ── */

/** Store (or re-store, while unconsumed) an approved plan under its hash. */
export function storeApprovedPlan(plan: SpawnPlan): void {
  const d = open()
  const existing = d
    .prepare('SELECT run_id FROM orch_plans WHERE plan_hash = ?')
    .get(plan.planHash) as { run_id: string | null } | undefined
  if (existing) {
    if (existing.run_id !== null) {
      throw new Error('[dispatch] plan already dispatched — approve a fresh plan')
    }
    d.prepare('UPDATE orch_plans SET json = ?, approved_at = ? WHERE plan_hash = ?').run(
      JSON.stringify(plan),
      nowIso(),
      plan.planHash
    )
    return
  }
  d.prepare(
    'INSERT INTO orch_plans (plan_hash, plan_id, json, approved_at, run_id) VALUES (?, ?, ?, ?, NULL)'
  ).run(plan.planHash, plan.id, JSON.stringify(plan), nowIso())
}

export function getApprovedPlan(planHash: string): SpawnPlan | null {
  const row = open().prepare('SELECT json FROM orch_plans WHERE plan_hash = ?').get(planHash) as
    | { json: string }
    | undefined
  if (!row) return null
  try {
    return JSON.parse(row.json) as SpawnPlan
  } catch {
    return null
  }
}

/** One dispatch per approved plan — guarded UPDATE, exactly one winner. */
export function consumeApprovedPlan(planHash: string, runId: string): boolean {
  const res = open()
    .prepare('UPDATE orch_plans SET run_id = ? WHERE plan_hash = ? AND run_id IS NULL')
    .run(runId, planHash)
  return res.changes === 1
}

/** Dispatch failed before launch — the approval is valid again. */
export function releaseApprovedPlan(planHash: string, runId: string): void {
  open()
    .prepare('UPDATE orch_plans SET run_id = NULL WHERE plan_hash = ? AND run_id = ?')
    .run(planHash, runId)
}

/* ── run + agent rows ── */

export interface RunRow {
  run_id: string
  run_tag: string
  plan_hash: string
  space_root: string
  goal: string
  state: RunState
  plan_json: string
  created_at: string
  started_at: string | null
  ended_at: string | null
}

export interface AgentRow {
  run_id: string
  agent_id: string
  state: AgentRunState
  cli: string
  role: string
  branch: string
  worktree: string | null
  pane_id: string | null
  pid: number | null
  port: number | null
  kickoff_task_id: string | null
}

export function createRun(runId: string, runTag: string, plan: SpawnPlan): void {
  const d = open()
  const ts = nowIso()
  d.transaction(() => {
    d.prepare(
      `INSERT INTO orch_runs (run_id, run_tag, plan_hash, space_root, goal, state, plan_json, created_at)
       VALUES (?, ?, ?, ?, ?, 'approved', ?, ?)`
    ).run(runId, runTag, plan.planHash, plan.spaceRoot, plan.goal, JSON.stringify(plan), ts)
    for (const agent of plan.agents) {
      d.prepare(
        `INSERT INTO orch_agents (run_id, agent_id, state, cli, role, branch)
         VALUES (?, ?, 'queued', ?, ?, ?)`
      ).run(runId, agent.agentId, agent.cli, agent.role, agent.branch)
    }
  })()
}

export function getRunRow(runId: string): RunRow | undefined {
  return open().prepare('SELECT * FROM orch_runs WHERE run_id = ?').get(runId) as
    | RunRow
    | undefined
}

export function getAgentRows(runId: string): AgentRow[] {
  return open()
    .prepare('SELECT * FROM orch_agents WHERE run_id = ? ORDER BY agent_id')
    .all(runId) as AgentRow[]
}

/** Guarded run transition; started_at/ended_at stamped on the edges. */
export function runTransition(runId: string, to: RunState): void {
  const froms = (Object.keys(RUN_TRANSITIONS) as RunState[]).filter((f) =>
    RUN_TRANSITIONS[f].includes(to)
  )
  if (froms.length === 0) throw illegal('run', getRunRow(runId)?.state, to)
  const ts = nowIso()
  const stampStart = to === 'running' ? ts : null
  const stampEnd = TERMINAL_RUN_STATES.includes(to) ? ts : null
  const res = open()
    .prepare(
      `UPDATE orch_runs
       SET state = ?,
           started_at = COALESCE(started_at, ?),
           ended_at = COALESCE(?, ended_at)
       WHERE run_id = ? AND state IN (${froms.map(() => '?').join(',')})`
    )
    .run(to, stampStart, stampEnd, runId, ...froms)
  if (res.changes !== 1) throw illegal('run', getRunRow(runId)?.state, to)
}

/** Guarded agent transition. */
export function agentTransition(runId: string, agentId: AgentId, to: AgentRunState): void {
  const froms = (Object.keys(AGENT_TRANSITIONS) as AgentRunState[]).filter((f) =>
    AGENT_TRANSITIONS[f].includes(to)
  )
  if (froms.length === 0) throw illegal('agent', currentAgentState(runId, agentId), to)
  const res = open()
    .prepare(
      `UPDATE orch_agents SET state = ?
       WHERE run_id = ? AND agent_id = ? AND state IN (${froms.map(() => '?').join(',')})`
    )
    .run(to, runId, agentId, ...froms)
  if (res.changes !== 1) throw illegal(`agent ${agentId}`, currentAgentState(runId, agentId), to)
}

function currentAgentState(runId: string, agentId: AgentId): string | undefined {
  const row = open()
    .prepare('SELECT state FROM orch_agents WHERE run_id = ? AND agent_id = ?')
    .get(runId, agentId) as { state: string } | undefined
  return row?.state
}

export function patchAgent(
  runId: string,
  agentId: AgentId,
  patch: Partial<Pick<AgentRow, 'worktree' | 'pane_id' | 'pid' | 'port' | 'kickoff_task_id'>>
): void {
  const keys = Object.keys(patch) as (keyof typeof patch)[]
  if (keys.length === 0) return
  const sets = keys.map((k) => `${k} = ?`).join(', ')
  open()
    .prepare(`UPDATE orch_agents SET ${sets} WHERE run_id = ? AND agent_id = ?`)
    .run(...keys.map((k) => patch[k] ?? null), runId, agentId)
}

/* ── status projection ── */

export function getRunStatus(runId: string): RunStatus | null {
  const run = getRunRow(runId)
  if (!run) return null
  const agents: Record<AgentId, AgentRunState> = {}
  const agentsDetail: Record<AgentId, AgentRunDetail> = {}
  for (const row of getAgentRows(runId)) {
    agents[row.agent_id] = row.state
    agentsDetail[row.agent_id] = {
      paneId: row.pane_id ?? '',
      pid: row.pid,
      port: row.port,
      worktree: row.worktree,
      branch: row.branch,
      cli: row.cli as AgentRunDetail['cli'],
      kickoffTaskId: row.kickoff_task_id
    }
  }
  return {
    runId: run.run_id,
    runTag: run.run_tag,
    planHash: run.plan_hash,
    state: run.state,
    agents,
    agentsDetail,
    usage: { usd: null, tokens: null },
    startedAt: run.started_at,
    endedAt: run.ended_at
  }
}

export type { RunSummary }

// w14/orch-scoped — RunSummary carries spaceRoot (orch_runs.space_root existed
// since w5); listRuns(spaceRoot) filters to one space. No arg = unfiltered.
export function listRuns(spaceRoot?: string): RunSummary[] {
  const where = spaceRoot ? 'WHERE space_root = ?' : ''
  const params = spaceRoot ? [spaceRoot] : []
  return (
    open()
      .prepare(
        `SELECT run_id, run_tag, goal, state, created_at, space_root FROM orch_runs ${where} ORDER BY created_at, run_id`
      )
      .all(...params) as Pick<
      RunRow,
      'run_id' | 'run_tag' | 'goal' | 'state' | 'created_at' | 'space_root'
    >[]
  ).map((r) => ({
    runId: r.run_id,
    runTag: r.run_tag,
    goal: r.goal,
    state: r.state,
    createdAt: r.created_at,
    spaceRoot: r.space_root
  }))
}

/** Runs a crashed app left mid-flight (startup sweep marks them aborted). */
export function listLiveRuns(): RunRow[] {
  return open()
    .prepare(`SELECT * FROM orch_runs WHERE state IN ('dispatching', 'running', 'merging')`)
    .all() as RunRow[]
}
