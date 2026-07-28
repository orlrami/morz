import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import Database from 'better-sqlite3'
import type {
  PlanAmendment,
  PlanAmendmentAction,
  StoredPlanAmendment,
  StoredSpawnPlan
} from '../../shared/ipc'
import type { SpawnPlan } from '../../shared/spawn-plan'

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }

function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    .join(',')}}`
}

export function hashSpawnPlan(plan: SpawnPlan): string {
  const { planHash: _planHash, ...hashable } = plan
  return createHash('sha256').update(canonicalJson(hashable as unknown as JsonValue)).digest('hex')
}

export function hashPlanAmendment(amendment: PlanAmendment): string {
  const { amendmentHash: _amendmentHash, ...hashable } = amendment
  return createHash('sha256').update(canonicalJson(hashable as unknown as JsonValue)).digest('hex')
}

function normalizeAgent(agent: SpawnPlan['agents'][number]): SpawnPlan['agents'][number] {
  return {
    ...agent,
    model: agent.model ?? null,
    dependsOn: agent.dependsOn ?? [],
    worktree: agent.worktree ?? null,
    port: agent.port ?? null
  }
}

function normalizePlan(plan: SpawnPlan): SpawnPlan {
  return {
    ...plan,
    version: '1.1',
    agents: plan.agents.map(normalizeAgent),
    caps: {
      maxUsd: plan.caps.maxUsd ?? null,
      maxTokens: plan.caps.maxTokens ?? null
    }
  }
}

function immutablePlanFields(plan: SpawnPlan): Omit<SpawnPlan, 'agents' | 'planHash'> {
  const { agents: _agents, planHash: _planHash, ...fixed } = normalizePlan(plan)
  return fixed
}

function immutableAgentFields(
  agent: SpawnPlan['agents'][number]
): Omit<SpawnPlan['agents'][number], 'cli' | 'model' | 'promptSeed'> {
  const { cli: _cli, model: _model, promptSeed: _promptSeed, ...fixed } = normalizeAgent(agent)
  return fixed
}

export function assertPlanEditAllowed(current: SpawnPlan, updated: SpawnPlan): void {
  if (
    canonicalJson(immutablePlanFields(current) as unknown as JsonValue) !==
    canonicalJson(immutablePlanFields(updated) as unknown as JsonValue)
  ) {
    throw new Error('Plan edit changed immutable plan fields')
  }

  const currentById = new Map(current.agents.map((agent) => [agent.agentId, agent]))
  // w14/multi-agent-plan: the team card may APPEND new agents to a PROPOSED
  // plan (the user still approves the final hash). Surviving original agents
  // keep their relative order and immutable fields; new agents must come
  // after every surviving one and may not take over an original branch (an
  // id-swap on an existing branch is still an identity rewrite, not an add).
  const surviving = updated.agents.filter((agent) => currentById.has(agent.agentId))
  const added = updated.agents.filter((agent) => !currentById.has(agent.agentId))
  const expectedOrder = current.agents
    .filter((agent) => updated.agents.some((candidate) => candidate.agentId === agent.agentId))
    .map((agent) => agent.agentId)
  if (expectedOrder.join('\0') !== surviving.map((agent) => agent.agentId).join('\0')) {
    throw new Error('Plan edit reordered immutable agents')
  }
  if (
    added.length > 0 &&
    !updated.agents.slice(updated.agents.length - added.length).every((agent) => !currentById.has(agent.agentId))
  ) {
    throw new Error('Plan edit must append new agents after the immutable originals')
  }
  const originalBranches = new Set(current.agents.map((agent) => agent.branch))
  for (const agent of added) {
    if (originalBranches.has(agent.branch)) {
      throw new Error(`Plan edit reused the immutable branch ${agent.branch} for a new agent`)
    }
  }
  for (const agent of surviving) {
    const original = currentById.get(agent.agentId)!
    if (
      canonicalJson(immutableAgentFields(original) as unknown as JsonValue) !==
      canonicalJson(immutableAgentFields(agent) as unknown as JsonValue)
    ) {
      throw new Error(`Plan edit changed immutable fields for ${agent.agentId}`)
    }
  }
}

interface PlanRow {
  json: string
  state: StoredSpawnPlan['state']
}

interface AmendmentRow {
  json: string
  state: StoredPlanAmendment['state']
}

function parsePlanRow(row: PlanRow | undefined): StoredSpawnPlan | null {
  if (!row) return null
  return { plan: JSON.parse(row.json) as SpawnPlan, state: row.state }
}

function parseAmendmentRow(row: AmendmentRow | undefined): StoredPlanAmendment | null {
  if (!row) return null
  return { amendment: JSON.parse(row.json) as PlanAmendment, state: row.state }
}

/** SQLite source of truth for hash-gated plan and one-agent amendment approvals. */
export class PlanStore {
  private readonly db: Database.Database

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true })
    this.db = new Database(dbPath)
    this.db.pragma('journal_mode = WAL')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS orchestrator_plans (
        id TEXT PRIMARY KEY,
        plan_hash TEXT NOT NULL UNIQUE,
        state TEXT NOT NULL CHECK (state IN ('DRAFT', 'PROPOSED', 'APPROVED')),
        json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS orchestrator_amendments (
        id TEXT PRIMARY KEY,
        plan_id TEXT NOT NULL,
        amendment_hash TEXT NOT NULL UNIQUE,
        state TEXT NOT NULL CHECK (state IN ('PROPOSED', 'APPROVED')),
        json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS orchestrator_amendments_plan
        ON orchestrator_amendments(plan_id, state);
    `)
    // w14/orch-scoped — additive column: a plan belongs to the space it was
    // created in. Existing rows are backfilled from the plan JSON so history
    // stays queryable per space.
    const planColumns = this.db.prepare(`PRAGMA table_info(orchestrator_plans)`).all() as {
      name: string
    }[]
    if (!planColumns.some((column) => column.name === 'space_root')) {
      this.db.exec(`ALTER TABLE orchestrator_plans ADD COLUMN space_root TEXT`)
    }
    this.db
      .prepare(
        `UPDATE orchestrator_plans SET space_root = json_extract(json, '$.spaceRoot')
         WHERE space_root IS NULL`
      )
      .run()
    // end w14/orch-scoped
    this.db
      .prepare(`UPDATE orchestrator_plans SET state = 'PROPOSED', updated_at = ? WHERE state = 'DRAFT'`)
      .run(new Date().toISOString())
  }

  createDraft(candidate: SpawnPlan): StoredSpawnPlan {
    const normalized = normalizePlan(candidate)
    const plan = { ...normalized, planHash: hashSpawnPlan(normalized) }
    const now = new Date().toISOString()
    this.db
      .prepare(
        // w14/orch-scoped — space_root stamped at creation
        `INSERT INTO orchestrator_plans
          (id, plan_hash, state, json, created_at, updated_at, space_root)
         VALUES (?, ?, 'DRAFT', ?, ?, ?, ?)`
      )
      .run(plan.id, plan.planHash, JSON.stringify(plan), plan.createdAt, now, plan.spaceRoot)
    return { plan, state: 'DRAFT' }
  }

  propose(planId: string): StoredSpawnPlan {
    const changed = this.db
      .prepare(
        `UPDATE orchestrator_plans SET state = 'PROPOSED', updated_at = ?
         WHERE id = ? AND state = 'DRAFT'`
      )
      .run(new Date().toISOString(), planId)
    if (changed.changes !== 1) throw new Error('Plan is not a draft')
    return this.requirePlanById(planId)
  }

  updateProposed(plan: SpawnPlan, expectedHash: string): StoredSpawnPlan {
    const current = this.requirePlanById(plan.id)
    if (current.state !== 'PROPOSED') throw new Error('Only proposed plans can be edited')
    if (current.plan.planHash !== expectedHash) throw new Error('Plan changed; reload before editing')
    const normalized = normalizePlan(plan)
    assertPlanEditAllowed(current.plan, normalized)
    const updated = { ...normalized, planHash: hashSpawnPlan(normalized) }
    const changed = this.db
      .prepare(
        `UPDATE orchestrator_plans SET plan_hash = ?, json = ?, updated_at = ?
         WHERE id = ? AND plan_hash = ? AND state = 'PROPOSED'`
      )
      .run(
        updated.planHash,
        JSON.stringify(updated),
        new Date().toISOString(),
        updated.id,
        expectedHash
      )
    if (changed.changes !== 1) throw new Error('Plan changed; reload before editing')
    return { plan: updated, state: 'PROPOSED' }
  }

  approve(planHash: string): StoredSpawnPlan {
    const current = this.requirePlanByHash(planHash)
    if (current.state !== 'PROPOSED') throw new Error('Plan is not awaiting approval')
    if (hashSpawnPlan(current.plan) !== planHash) throw new Error('Stored plan hash mismatch')
    const changed = this.db
      .prepare(
        `UPDATE orchestrator_plans SET state = 'APPROVED', updated_at = ?
         WHERE plan_hash = ? AND state = 'PROPOSED'`
      )
      .run(new Date().toISOString(), planHash)
    if (changed.changes !== 1) throw new Error('Plan approval raced with another request')
    return { plan: current.plan, state: 'APPROVED' }
  }

  discard(planHash: string): void {
    const changed = this.db
      .prepare(`DELETE FROM orchestrator_plans WHERE plan_hash = ? AND state != 'APPROVED'`)
      .run(planHash)
    if (changed.changes !== 1) throw new Error('Only unapproved plans can be discarded')
  }

  createAmendment(planId: string, action: PlanAmendmentAction, createdAt: string): StoredPlanAmendment {
    const plan = this.requirePlanById(planId)
    if (plan.state !== 'APPROVED') throw new Error('Amendments require an approved plan')
    const replaced = action.kind === 'replace' ? action.replaceAgentId : null
    if (replaced && !plan.plan.agents.some((agent) => agent.agentId === replaced)) {
      throw new Error(`Replacement agent ${replaced} does not exist`)
    }
    const remaining = plan.plan.agents.filter((agent) => agent.agentId !== replaced)
    if (remaining.some((agent) => agent.agentId === action.agent.agentId)) {
      throw new Error(`Amendment agent id ${action.agent.agentId} already exists`)
    }
    if (remaining.some((agent) => agent.branch === action.agent.branch)) {
      throw new Error(`Amendment branch ${action.agent.branch} already exists`)
    }
    const amendment: PlanAmendment = {
      version: '1.0',
      id: randomUUID(),
      planId,
      action,
      createdAt,
      amendmentHash: ''
    }
    amendment.amendmentHash = hashPlanAmendment(amendment)
    this.db
      .prepare(
        `INSERT INTO orchestrator_amendments
          (id, plan_id, amendment_hash, state, json, created_at, updated_at)
         VALUES (?, ?, ?, 'PROPOSED', ?, ?, ?)`
      )
      .run(
        amendment.id,
        planId,
        amendment.amendmentHash,
        JSON.stringify(amendment),
        createdAt,
        createdAt
      )
    return { amendment, state: 'PROPOSED' }
  }

  approveAmendment(amendmentHash: string): StoredPlanAmendment {
    const current = this.requireAmendmentByHash(amendmentHash)
    if (current.state !== 'PROPOSED') throw new Error('Amendment is not awaiting approval')
    if (hashPlanAmendment(current.amendment) !== amendmentHash) {
      throw new Error('Stored amendment hash mismatch')
    }
    const changed = this.db
      .prepare(
        `UPDATE orchestrator_amendments SET state = 'APPROVED', updated_at = ?
         WHERE amendment_hash = ? AND state = 'PROPOSED'`
      )
      .run(new Date().toISOString(), amendmentHash)
    if (changed.changes !== 1) throw new Error('Amendment approval raced with another request')
    return { amendment: current.amendment, state: 'APPROVED' }
  }

  discardAmendment(amendmentHash: string): void {
    const changed = this.db
      .prepare(
        `DELETE FROM orchestrator_amendments WHERE amendment_hash = ? AND state = 'PROPOSED'`
      )
      .run(amendmentHash)
    if (changed.changes !== 1) throw new Error('Only proposed amendments can be discarded')
  }

  // w14/orch-scoped — plans and their amendments are queried BY spaceRoot:
  // a plan belongs to the space it was created in, and opening a space must
  // never dump every other project's planning history. No arg = unfiltered
  // (pre-w14 callers keep their behavior).
  listOpen(spaceRoot?: string): { plans: StoredSpawnPlan[]; amendments: StoredPlanAmendment[] } {
    const planWhere = spaceRoot ? 'WHERE space_root = ?' : ''
    const planParams = spaceRoot ? [spaceRoot] : []
    const plans = (
      this.db
        .prepare(
          `SELECT json, state FROM orchestrator_plans ${planWhere} ORDER BY updated_at DESC LIMIT 20`
        )
        .all(...planParams) as PlanRow[]
    ).map((row) => parsePlanRow(row)!)
    const amendments = (
      this.db
        .prepare(
          spaceRoot
            ? `SELECT a.json, a.state FROM orchestrator_amendments a
               JOIN orchestrator_plans p ON p.id = a.plan_id
               WHERE a.state = 'PROPOSED' AND p.space_root = ?
               ORDER BY a.updated_at DESC`
            : `SELECT json, state FROM orchestrator_amendments WHERE state = 'PROPOSED' ORDER BY updated_at DESC`
        )
        .all(...planParams) as AmendmentRow[]
    ).map((row) => parseAmendmentRow(row)!)
    return { plans, amendments }
  }

  getPlan(planId: string): StoredSpawnPlan {
    return this.requirePlanById(planId)
  }

  close(): void {
    if (this.db.open) this.db.close()
  }

  private requirePlanById(planId: string): StoredSpawnPlan {
    const record = parsePlanRow(
      this.db
        .prepare('SELECT json, state FROM orchestrator_plans WHERE id = ?')
        .get(planId) as PlanRow | undefined
    )
    if (!record) throw new Error('Plan not found')
    return record
  }

  private requirePlanByHash(planHash: string): StoredSpawnPlan {
    const record = parsePlanRow(
      this.db
        .prepare('SELECT json, state FROM orchestrator_plans WHERE plan_hash = ?')
        .get(planHash) as PlanRow | undefined
    )
    if (!record) throw new Error('Plan not found')
    return record
  }

  private requireAmendmentByHash(amendmentHash: string): StoredPlanAmendment {
    const record = parseAmendmentRow(
      this.db
        .prepare('SELECT json, state FROM orchestrator_amendments WHERE amendment_hash = ?')
        .get(amendmentHash) as AmendmentRow | undefined
    )
    if (!record) throw new Error('Amendment not found')
    return record
  }
}
