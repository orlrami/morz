/*
 * Bus v0 (0.0.2) — SQLite task board. Source of truth for Task state per
 * docs/protocol.md §2 + §6.3. Lives in the same morz.db as the session store
 * (own connection, WAL already on). All writes are CAS-style single UPDATEs
 * guarded by the current state, so the frozen state machine is enforced at
 * the SQL layer — an UPDATE that matches 0 rows is either a lost claim race
 * or an illegal transition (protocol error).
 *
 * State machine (protocol.md — anything else throws):
 *   proposed → accepted   accept()
 *   proposed → done       withdraw()
 *   accepted → working    claim()      CAS, exactly one winner; deps must be done
 *   working  → blocked    block(reason)
 *   working  → done       complete(artifacts)
 *   blocked  → working    resume()
 *   working  → accepted   sweepExpired()   (lease expired — crashed agent)
 */
import Database from 'better-sqlite3'
import { app } from 'electron'
import { join } from 'path'
import { mkdirSync } from 'fs'
import { randomUUID } from 'crypto'
import {
  PROTOCOL_VERSION,
  type AgentId,
  type Artifact,
  type Task,
  type TaskId,
  type TaskState
} from '../../shared/bus'
import type { BusArtifactInput, BusCreateTaskInput, BusTaskFilter } from '../../shared/ipc'

const DEFAULT_LEASE_MS = 15 * 60_000

let db: Database.Database | null = null

function open(): Database.Database {
  if (db) return db
  const dir = join(app.getPath('appData'), 'Morz')
  mkdirSync(dir, { recursive: true })
  db = new Database(join(dir, 'morz.db'))
  db.pragma('journal_mode = WAL')
  db.exec(`
    CREATE TABLE IF NOT EXISTS bus_tasks (
      id             TEXT PRIMARY KEY,
      state          TEXT NOT NULL,
      title          TEXT NOT NULL,
      created_by     TEXT NOT NULL,
      assignee       TEXT,
      created_at     TEXT NOT NULL,
      updated_at     TEXT NOT NULL,
      blocked_reason TEXT,
      lease_until    TEXT,
      artifacts      TEXT NOT NULL DEFAULT '[]'
    );
    CREATE TABLE IF NOT EXISTS bus_task_deps (
      task_id    TEXT NOT NULL,
      depends_on TEXT NOT NULL,
      PRIMARY KEY (task_id, depends_on)
    );
    CREATE TABLE IF NOT EXISTS bus_messages (
      id         TEXT PRIMARY KEY,
      from_agent TEXT NOT NULL,
      to_agent   TEXT NOT NULL,
      task_id    TEXT,
      ts         TEXT NOT NULL,
      parts      TEXT NOT NULL,
      file       TEXT
    );
    CREATE INDEX IF NOT EXISTS bus_tasks_state ON bus_tasks (state);
  `)
  return db
}

/** Exposes the shared handle so the mailbox mirror writes into the same db. */
export function boardDb(): Database.Database {
  return open()
}

/* ── change push (blackboard UI subscribes via bus/index.ts) ── */
const changeListeners = new Set<() => void>()
export function onBoardChange(cb: () => void): () => void {
  changeListeners.add(cb)
  return () => changeListeners.delete(cb)
}
function notify(): void {
  for (const cb of changeListeners) cb()
}

/* ── row ↔ Task ── */
interface TaskRow {
  id: string
  state: string
  title: string
  created_by: string
  assignee: string | null
  created_at: string
  updated_at: string
  blocked_reason: string | null
  lease_until: string | null
  artifacts: string
}

function hydrate(row: TaskRow): Task {
  const deps = (
    open().prepare('SELECT depends_on FROM bus_task_deps WHERE task_id = ? ORDER BY depends_on').all(row.id) as {
      depends_on: string
    }[]
  ).map((d) => d.depends_on)
  let artifacts: Artifact[] = []
  try {
    artifacts = JSON.parse(row.artifacts) as Artifact[]
  } catch {
    // corrupt artifacts JSON — surface the task, not the crash
  }
  const task: Task = {
    protocolVersion: PROTOCOL_VERSION,
    id: row.id,
    state: row.state as TaskState,
    title: row.title,
    createdBy: row.created_by,
    assignee: row.assignee,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    dependsOn: deps,
    artifacts
  }
  if (row.blocked_reason !== null) task.blockedReason = row.blocked_reason
  if (row.lease_until !== null) task.leaseUntil = row.lease_until
  return task
}

function getRow(id: TaskId): TaskRow | undefined {
  return open().prepare('SELECT * FROM bus_tasks WHERE id = ?').get(id) as TaskRow | undefined
}

function nowIso(): string {
  return new Date().toISOString()
}

function illegal(id: TaskId, from: string | undefined, to: TaskState): Error {
  return new Error(
    `[bus] illegal transition on task ${id}: ${from ?? '(missing)'} → ${to} (protocol.md §2)`
  )
}

/* ── lifecycle ── */

/** Propose a task (state 'proposed'; not yet claimable). Main mints the id. */
export function createTask(input: BusCreateTaskInput): Task {
  if (!input.title || !input.createdBy) throw new Error('[bus] createTask needs title + createdBy')
  const d = open()
  const id = randomUUID()
  const ts = nowIso()
  const insert = d.transaction(() => {
    d.prepare(
      `INSERT INTO bus_tasks (id, state, title, created_by, assignee, created_at, updated_at)
       VALUES (?, 'proposed', ?, ?, NULL, ?, ?)`
    ).run(id, input.title, input.createdBy, ts, ts)
    for (const dep of input.dependsOn ?? []) {
      d.prepare('INSERT OR IGNORE INTO bus_task_deps (task_id, depends_on) VALUES (?, ?)').run(id, dep)
    }
  })
  insert()
  notify()
  return hydrate(getRow(id)!)
}

/** proposed → accepted (approval chip in Assisted; policy in Orchestrated). */
export function acceptTask(id: TaskId): Task {
  const row = open()
    .prepare(
      `UPDATE bus_tasks SET state = 'accepted', updated_at = ?
       WHERE id = ? AND state = 'proposed' RETURNING *`
    )
    .get(nowIso(), id) as TaskRow | undefined
  if (!row) throw illegal(id, getRow(id)?.state, 'accepted')
  notify()
  return hydrate(row)
}

/** proposed → done (withdrawn/rejected — done with zero artifacts). */
export function withdrawTask(id: TaskId): Task {
  const row = open()
    .prepare(
      `UPDATE bus_tasks SET state = 'done', updated_at = ?
       WHERE id = ? AND state = 'proposed' RETURNING *`
    )
    .get(nowIso(), id) as TaskRow | undefined
  if (!row) throw illegal(id, getRow(id)?.state, 'done')
  notify()
  return hydrate(row)
}

/**
 * accepted → working — the CAS claim. Exactly one winner: the guarded UPDATE
 * matches only while state is still 'accepted' AND every dependency is 'done'
 * (a dep row with no matching done task blocks — missing deps count as not
 * done). Returns null when the task was claimable but this caller lost the
 * race or a dependency is unmet; throws when the state itself makes the
 * transition illegal.
 */
export function claimTask(id: TaskId, agentId: AgentId, leaseMs = DEFAULT_LEASE_MS): Task | null {
  if (!agentId) throw new Error('[bus] claimTask needs agentId')
  const ts = nowIso()
  const leaseUntil = new Date(Date.now() + leaseMs).toISOString()
  const row = open()
    .prepare(
      `UPDATE bus_tasks
       SET state = 'working', assignee = ?, lease_until = ?, updated_at = ?
       WHERE id = ? AND state = 'accepted'
         AND NOT EXISTS (
           SELECT 1 FROM bus_task_deps d
           WHERE d.task_id = bus_tasks.id
             AND NOT EXISTS (
               SELECT 1 FROM bus_tasks t WHERE t.id = d.depends_on AND t.state = 'done'
             )
         )
       RETURNING *`
    )
    .get(agentId, leaseUntil, ts, id) as TaskRow | undefined
  if (!row) {
    const current = getRow(id)
    if (!current) throw illegal(id, undefined, 'working')
    // lost the race (someone claimed between our read and write) — not an error
    if (current.state === 'working') return null
    // still 'accepted' means deps unmet — claimable later, not a protocol error
    if (current.state === 'accepted') return null
    throw illegal(id, current.state, 'working')
  }
  notify()
  return hydrate(row)
}

/** working → done — claimant completes; artifact stamped + appended by Main. */
export function completeTask(id: TaskId, agentId: AgentId, artifact: BusArtifactInput): Task {
  const d = open()
  const ts = nowIso()
  const stamped: Artifact = {
    id: randomUUID(),
    producedBy: agentId,
    ts,
    label: artifact?.label ?? '',
    files: artifact?.files ?? [],
    commits: artifact?.commits ?? []
  }
  let row: TaskRow | undefined
  d.transaction(() => {
    const current = getRow(id)
    if (!current || current.state !== 'working' || current.assignee !== agentId) {
      throw illegal(
        id,
        current ? `${current.state} (assignee ${current.assignee})` : undefined,
        'done'
      )
    }
    const artifacts = JSON.parse(current.artifacts) as Artifact[]
    artifacts.push(stamped)
    row = d
      .prepare(
        `UPDATE bus_tasks
         SET state = 'done', artifacts = ?, lease_until = NULL, updated_at = ?
         WHERE id = ? AND state = 'working' AND assignee = ? RETURNING *`
      )
      .get(JSON.stringify(artifacts), ts, id, agentId) as TaskRow | undefined
    if (!row) throw illegal(id, getRow(id)?.state, 'done')
  })()
  notify()
  return hydrate(row!)
}

/** working → blocked — claimant cannot proceed; blockedReason required. */
export function blockTask(id: TaskId, agentId: AgentId, reason: string): Task {
  if (!reason) throw new Error('[bus] blockTask requires a blockedReason (protocol.md §2)')
  const row = open()
    .prepare(
      `UPDATE bus_tasks
       SET state = 'blocked', blocked_reason = ?, lease_until = NULL, updated_at = ?
       WHERE id = ? AND state = 'working' AND assignee = ? RETURNING *`
    )
    .get(reason, nowIso(), id, agentId) as TaskRow | undefined
  if (!row) throw illegal(id, getRow(id)?.state, 'blocked')
  notify()
  return hydrate(row)
}

/** blocked → working — unblocked (dependency done / input arrived); lease renews. */
export function resumeTask(id: TaskId, agentId: AgentId, leaseMs = DEFAULT_LEASE_MS): Task {
  const leaseUntil = new Date(Date.now() + leaseMs).toISOString()
  const row = open()
    .prepare(
      `UPDATE bus_tasks
       SET state = 'working', blocked_reason = NULL, lease_until = ?, updated_at = ?
       WHERE id = ? AND state = 'blocked' AND assignee = ? RETURNING *`
    )
    .get(leaseUntil, nowIso(), id, agentId) as TaskRow | undefined
  if (!row) throw illegal(id, getRow(id)?.state, 'working')
  notify()
  return hydrate(row)
}

/**
 * working → accepted — the crashed-agent path. Re-opens every 'working' task
 * whose lease expired so someone else can claim it. Returns reclaimed ids.
 */
export function sweepExpired(now = nowIso()): TaskId[] {
  const rows = open()
    .prepare(
      `UPDATE bus_tasks
       SET state = 'accepted', assignee = NULL, lease_until = NULL, updated_at = ?
       WHERE state = 'working' AND lease_until IS NOT NULL AND lease_until < ?
       RETURNING id`
    )
    .all(now, now) as { id: string }[]
  if (rows.length > 0) notify()
  return rows.map((r) => r.id)
}

/* ── queries ── */

export function getTask(id: TaskId): Task | null {
  const row = getRow(id)
  return row ? hydrate(row) : null
}

export function listTasks(filter?: BusTaskFilter): Task[] {
  const where: string[] = []
  const params: string[] = []
  if (filter?.state) {
    where.push('state = ?')
    params.push(filter.state)
  }
  if (filter?.assignee) {
    where.push('assignee = ?')
    params.push(filter.assignee)
  }
  const sql = `SELECT * FROM bus_tasks ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at, id`
  return (open().prepare(sql).all(...params) as TaskRow[]).map(hydrate)
}
