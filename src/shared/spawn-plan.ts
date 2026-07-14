/*
 * SpawnPlan + run-state contract (0.0.3 "Orchestrated") — wave-5 seam.
 * The planner emits a SCHEMA-VALIDATED SpawnPlan (never regex-parsed prose);
 * the user approves the WHOLE plan once (per-plan approval, hash-gated); the
 * dispatcher only spawns from the stored hashed plan. Owner pattern: visible
 * pane launch — automate the cd → branch → launch you'd type by hand.
 *
 * Wave-5 ownership: planner (w5/planner) + dispatcher (w5/dispatch) + cost
 * kill-switch (w5/cost) import from here. ADDITIVE changes only during the
 * wave — coordinate anything breaking through integration.
 */
import type { AgentId, TaskId } from './bus'

export const SPAWN_PLAN_VERSION = '1.0' as const

export type PlannedCli = 'claude' | 'codex' | 'agy'

export interface PlannedAgent {
  /** Becomes the lane/bus AgentId once dispatched. */
  agentId: AgentId
  cli: PlannedCli
  /** Human-readable role ("builder: PTY host", "reviewer"). */
  role: string
  /** Branch the dispatcher creates the worktree on (e.g. run/<tag>/<agent>). */
  branch: string
  /** Dispatcher fills the worktree path at dispatch time; planner leaves null. */
  worktree: string | null
  /** Space-root-relative cwd for the visible pane launch ('' = space root). */
  cwd: string
  /** The kickoff prompt for this agent — full deliverables, owned files, done-when. */
  promptSeed: string
  /** Bus task ids this agent's kickoff waits on (DAG deps). */
  dependsOn: TaskId[]
  /** $PORT assigned by the dispatcher from the pool; planner leaves null. */
  port: number | null
}

export interface SpawnPlan {
  version: typeof SPAWN_PLAN_VERSION
  /** ULID/GUID minted by Main when the plan is stored. */
  id: string
  /** The user's natural-language goal, verbatim. */
  goal: string
  agents: PlannedAgent[]
  /** Space root the run happens in (absolute). */
  spaceRoot: string
  /** Per-run cost caps (kill-switch); null = no cap. */
  caps: { maxUsd: number | null; maxTokens: number | null }
  createdAt: string // ISO-8601 UTC
  /** SHA-256 of the canonical plan JSON — approval + dispatch both check it. */
  planHash: string
}

/** Whole-run lifecycle (one SpawnPlan). */
export type RunState =
  | 'draft'
  | 'proposed'
  | 'approved'
  | 'dispatching'
  | 'running'
  | 'merging'
  | 'done'
  | 'aborted'

/** One dispatched agent's lifecycle. */
export type AgentRunState =
  | 'queued'
  | 'spawning'
  | 'running'
  | 'blocked'
  | 'rate-limited'
  | 'review'
  | 'done'
  | 'failed'
  | 'cancelled'

export interface RunStatus {
  runId: string
  planHash: string
  state: RunState
  /** Live per-agent states, keyed by agentId. */
  agents: Record<AgentId, AgentRunState>
  /** Running usage for the kill-switch (null until first sample). */
  usage: { usd: number | null; tokens: number | null }
  startedAt: string | null
  endedAt: string | null
}

/* ── w5/dispatch (ADDITIVE) ──────────────────────────────────────
 * Dispatcher extensions: the ONE canonical-JSON definition every plan hash
 * uses (planner hashes it, approval stores it, dispatch re-hashes it), plus
 * optional per-agent dispatch detail merged onto RunStatus. */

/** Recursively key-sorted JSON so hashing is insensitive to key order. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const keys = Object.keys(value as Record<string, unknown>).sort()
  const body = keys
    .map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`)
    .join(',')
  return `{${body}}`
}

/**
 * The canonical plan JSON that planHash covers: the whole plan with the
 * planHash field itself excluded (it cannot cover its own value). SHA-256 of
 * this string IS the planHash — see hashPlan() in main/orchestrator.
 */
export function canonicalPlanJson(plan: SpawnPlan): string {
  const { planHash: _planHash, ...rest } = plan
  return stableStringify(rest)
}

/** What the dispatcher knows about one launched agent (pane, pid, port, worktree). */
export interface AgentRunDetail {
  paneId: string
  pid: number | null
  port: number | null
  worktree: string | null
  branch: string
  cli: PlannedCli
  /** Kickoff bus task gating this agent's DAG position (null until created). */
  kickoffTaskId: string | null
}

// declaration-merged onto RunStatus above (additive, optional)
export interface RunStatus {
  runTag?: string
  agentsDetail?: Record<AgentId, AgentRunDetail>
}
