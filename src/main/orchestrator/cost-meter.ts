import Database from 'better-sqlite3'
import { app, BrowserWindow, ipcMain, type IpcMainEvent } from 'electron'
import { mkdirSync } from 'fs'
import { dirname, join } from 'path'
import { randomUUID } from 'crypto'
import {
  ClaudeApi,
  CostApi,
  type CostBreach,
  type CostCaps,
  type CostCapKind,
  type CostSnapshot,
  type CostTestTrackInput,
  type CostUsageSample,
  type CostUsageTotals
} from '../../shared/ipc'
import type { SpawnPlan } from '../../shared/spawn-plan'

const SESSION_SCOPE = `__session__:${randomUUID()}`
const DEFAULT_CAPS_KEY = 'global-default-caps'

interface RunRow {
  run_id: string
  max_usd: number | null
  max_tokens: number | null
  caps_configured: number
  breached_kind: CostCapKind | null
  breached_value: number | null
  breached_cap: number | null
  active: number
}

interface UsageRow {
  usd: number | null
  tokens: number | null
}

interface StoredTotalRow {
  last_total_usd: number | null
  last_total_tokens: number | null
}

function defaultDatabasePath(): string {
  return join(app.getPath('appData'), 'Morz', 'morz.db')
}

function nullableSum(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function validateCap(value: number | null, label: string): void {
  if (value === null) return
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${label} must be null or positive`)
}

function validateTokenCap(value: number | null): void {
  validateCap(value, 'caps.maxTokens')
  if (value !== null && !Number.isSafeInteger(value)) {
    throw new Error('caps.maxTokens must be a safe integer')
  }
}

function validateId(value: string, label: string): void {
  if (typeof value !== 'string' || !value || value.length > 200) {
    throw new Error(`${label} must be 1-200 characters`)
  }
}

function validateUsage(sample: CostUsageSample): void {
  if (sample.usd != null && (!Number.isFinite(sample.usd) || sample.usd < 0)) {
    throw new Error('usage.usd must be a non-negative finite number')
  }
  if (
    sample.tokens != null &&
    (!Number.isSafeInteger(sample.tokens) || (sample.tokens as number) < 0)
  ) {
    throw new Error('usage.tokens must be a non-negative safe integer')
  }
  if (sample.source !== undefined && (!sample.source || sample.source.length > 80)) {
    throw new Error('usage.source must be 1-80 characters')
  }
  if (sample.sampleId !== undefined && (!sample.sampleId || sample.sampleId.length > 200)) {
    throw new Error('usage.sampleId must be 1-200 characters')
  }
}

/**
 * Durable cost accumulator shared by the dispatcher and ordinary CLI lanes.
 * `track(runId, agentId, usage)` is the integration seam for wave-5 dispatch.
 */
export class CostMeter {
  private db: Database.Database | null = null
  private readonly changes = new Set<(snapshot: CostSnapshot) => void>()
  private readonly breaches = new Set<(breach: CostBreach) => void>()
  private readonly resumes = new Set<(runId: string, caps: CostCaps) => void>()
  private readonly stops = new Set<(runId: string, agentIds: string[]) => void>()

  constructor(private readonly databasePath: string | (() => string) = defaultDatabasePath) {}

  private open(): Database.Database {
    if (this.db) return this.db
    const path = typeof this.databasePath === 'function' ? this.databasePath() : this.databasePath
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
    this.db = new Database(path)
    this.db.pragma('journal_mode = WAL')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS cost_settings (
        key        TEXT PRIMARY KEY,
        value      TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS cost_runs (
        run_id            TEXT PRIMARY KEY,
        max_usd           REAL,
        max_tokens        INTEGER,
        caps_configured   INTEGER NOT NULL DEFAULT 0,
        breached_kind     TEXT,
        breached_value    REAL,
        breached_cap      REAL,
        active            INTEGER NOT NULL DEFAULT 1,
        updated_at        INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS cost_agent_runs (
        agent_id  TEXT PRIMARY KEY,
        run_id    TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS cost_usage (
        scope             TEXT NOT NULL,
        agent_id          TEXT NOT NULL,
        source            TEXT NOT NULL,
        usd               REAL,
        tokens            INTEGER,
        last_total_usd    REAL,
        last_total_tokens INTEGER,
        updated_at        INTEGER NOT NULL,
        PRIMARY KEY (scope, agent_id, source)
      );
      CREATE INDEX IF NOT EXISTS cost_usage_scope ON cost_usage (scope);
      CREATE INDEX IF NOT EXISTS cost_runs_updated ON cost_runs (updated_at DESC);
      CREATE TABLE IF NOT EXISTS cost_seen_samples (
        scope     TEXT NOT NULL,
        agent_id  TEXT NOT NULL,
        source    TEXT NOT NULL,
        sample_id TEXT NOT NULL,
        seen_at   INTEGER NOT NULL,
        PRIMARY KEY (scope, agent_id, source, sample_id)
      );
    `)
    const columns = this.db.pragma('table_info(cost_runs)') as { name: string }[]
    if (!columns.some((column) => column.name === 'active')) {
      this.db.exec('ALTER TABLE cost_runs ADD COLUMN active INTEGER NOT NULL DEFAULT 1')
    }
    return this.db
  }

  /** SpawnPlan.caps are explicit: null disables that cap for this run. */
  configureRun(runId: string, caps: CostCaps): void {
    validateId(runId, 'runId')
    validateCap(caps.maxUsd, 'caps.maxUsd')
    validateTokenCap(caps.maxTokens)
    this.open()
      .prepare(
        `INSERT INTO cost_runs
           (run_id, max_usd, max_tokens, caps_configured, breached_kind,
            breached_value, breached_cap, active, updated_at)
         VALUES (?, ?, ?, 1, NULL, NULL, NULL, 1, ?)
         ON CONFLICT(run_id) DO UPDATE SET
           max_usd = excluded.max_usd,
           max_tokens = excluded.max_tokens,
           caps_configured = 1,
           breached_kind = NULL,
           breached_value = NULL,
           breached_cap = NULL,
           active = 1,
           updated_at = excluded.updated_at`
      )
      .run(runId, caps.maxUsd, caps.maxTokens, Date.now())
    const breach = this.checkBreach(runId)
    if (breach) {
      for (const callback of this.breaches) callback(breach)
    }
    this.notifyChange()
  }

  configurePlan(plan: Pick<SpawnPlan, 'id' | 'caps' | 'agents'>): void {
    this.configureRun(plan.id, plan.caps)
    const now = Date.now()
    const bind = this.open().prepare(
      `INSERT INTO cost_agent_runs (agent_id, run_id, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(agent_id) DO UPDATE SET run_id = excluded.run_id, updated_at = excluded.updated_at`
    )
    this.open().transaction(() => {
      for (const agent of plan.agents) bind.run(agent.agentId, plan.id, now)
    })()
  }

  setGlobalDefaultCaps(caps: CostCaps): void {
    validateCap(caps.maxUsd, 'caps.maxUsd')
    validateTokenCap(caps.maxTokens)
    this.open()
      .prepare(
        `INSERT INTO cost_settings (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
      )
      .run(DEFAULT_CAPS_KEY, JSON.stringify(caps), Date.now())
  }

  getGlobalDefaultCaps(): CostCaps {
    const row = this.open().prepare('SELECT value FROM cost_settings WHERE key = ?').get(DEFAULT_CAPS_KEY) as
      | { value: string }
      | undefined
    if (!row) return { maxUsd: null, maxTokens: null }
    try {
      const value = JSON.parse(row.value) as Partial<CostCaps>
      return {
        maxUsd:
          typeof value.maxUsd === 'number' && Number.isFinite(value.maxUsd) && value.maxUsd > 0
            ? value.maxUsd
            : null,
        maxTokens:
          typeof value.maxTokens === 'number' &&
          Number.isSafeInteger(value.maxTokens) &&
          value.maxTokens > 0
            ? value.maxTokens
            : null
      }
    } catch {
      return { maxUsd: null, maxTokens: null }
    }
  }

  /**
   * Adds a delta by default. Adapter sources can pass mode:'total'; the meter
   * persists their last observed total and only adds the positive difference.
   */
  track(runId: string | null, agentId: string, usage: CostUsageSample): void {
    if (runId !== null) validateId(runId, 'runId')
    validateId(agentId, 'agentId')
    validateUsage(usage)
    if (usage.usd == null && usage.tokens == null) return

    const db = this.open()
    if (runId === null) {
      const bound = db
        .prepare('SELECT run_id FROM cost_agent_runs WHERE agent_id = ?')
        .get(agentId) as { run_id: string } | undefined
      // The dispatcher is authoritative for an active run. Ignore the adapter
      // mirror once it has bound this lane, preventing double accounting.
      if (bound) return
    }

    const source = usage.source ?? (runId === null ? 'adapter' : 'dispatcher')
    const scopes = runId === null ? [SESSION_SCOPE] : [SESSION_SCOPE, runId]
    const now = Date.now()

    db.transaction(() => {
      if (runId !== null) {
        this.ensureRun(runId, now)
        db.prepare(
          `INSERT INTO cost_agent_runs (agent_id, run_id, updated_at) VALUES (?, ?, ?)
           ON CONFLICT(agent_id) DO UPDATE SET run_id = excluded.run_id, updated_at = excluded.updated_at`
        ).run(agentId, runId, now)
      }
      for (const scope of scopes) this.applySample(scope, agentId, source, usage, now)
    })()

    const breach = runId === null ? null : this.checkBreach(runId)
    if (breach) {
      for (const callback of this.breaches) callback(breach)
    }
    this.notifyChange()
  }

  onBreach(callback: (breach: CostBreach) => void): () => void {
    this.breaches.add(callback)
    return () => this.breaches.delete(callback)
  }

  onChange(callback: (snapshot: CostSnapshot) => void): () => void {
    this.changes.add(callback)
    return () => this.changes.delete(callback)
  }

  onStop(callback: (runId: string, agentIds: string[]) => void): () => void {
    this.stops.add(callback)
    return () => this.stops.delete(callback)
  }

  onResume(callback: (runId: string, caps: CostCaps) => void): () => void {
    this.resumes.add(callback)
    return () => this.resumes.delete(callback)
  }

  resume(runId: string): CostSnapshot {
    validateId(runId, 'runId')
    const row = this.runRow(runId)
    if (!row?.breached_kind) return this.snapshot()
    const field = row.breached_kind === 'usd' ? 'max_usd' : 'max_tokens'
    const oldCap = row.breached_kind === 'usd' ? row.max_usd : row.max_tokens
    if (oldCap === null) return this.snapshot()
    const nextCap = oldCap * 1.25
    this.open()
      .prepare(
        `UPDATE cost_runs SET ${field} = ?, breached_kind = NULL,
           breached_value = NULL, breached_cap = NULL, active = 1,
           updated_at = ? WHERE run_id = ?`
      )
      .run(row.breached_kind === 'tokens' ? Math.ceil(nextCap) : nextCap, Date.now(), runId)
    const updated = this.runRow(runId)!
    const caps = { maxUsd: updated.max_usd, maxTokens: updated.max_tokens }
    for (const callback of this.resumes) callback(runId, caps)
    this.notifyChange()
    return this.snapshot()
  }

  stop(runId: string): CostSnapshot {
    validateId(runId, 'runId')
    const agentIds = this.agentIds(runId)
    for (const callback of this.stops) callback(runId, agentIds)
    this.open().prepare('DELETE FROM cost_agent_runs WHERE run_id = ?').run(runId)
    this.open()
      .prepare(
        `UPDATE cost_runs SET breached_kind = NULL, breached_value = NULL,
         breached_cap = NULL, active = 0, updated_at = ? WHERE run_id = ?`
      )
      .run(Date.now(), runId)
    this.notifyChange()
    return this.snapshot()
  }

  snapshot(): CostSnapshot {
    const session = this.totals(SESSION_SCOPE)
    const row = this.open()
      .prepare('SELECT * FROM cost_runs WHERE active = 1 ORDER BY updated_at DESC LIMIT 1')
      .get() as RunRow | undefined
    if (!row) return { session, activeRun: null }
    const breach =
      row.breached_kind && row.breached_value !== null && row.breached_cap !== null
        ? {
            runId: row.run_id,
            kind: row.breached_kind,
            value: row.breached_value,
            cap: row.breached_cap
          }
        : null
    return {
      session,
      activeRun: {
        runId: row.run_id,
        usage: this.totals(row.run_id),
        caps: { maxUsd: row.max_usd, maxTokens: row.max_tokens },
        breach
      }
    }
  }

  usage(runId: string): CostUsageTotals {
    validateId(runId, 'runId')
    return this.totals(runId)
  }

  laneUsage(agentId: string, runId: string | null = null): CostUsageTotals {
    validateId(agentId, 'agentId')
    if (runId !== null) validateId(runId, 'runId')
    const row = this.open()
      .prepare(
        `SELECT SUM(usd) AS usd, SUM(tokens) AS tokens FROM cost_usage
         WHERE scope = ? AND agent_id = ?`
      )
      .get(runId ?? SESSION_SCOPE, agentId) as UsageRow
    return { usd: nullableSum(row.usd), tokens: nullableSum(row.tokens) }
  }

  agentIds(runId: string): string[] {
    return (
      this.open()
        .prepare('SELECT agent_id FROM cost_agent_runs WHERE run_id = ? ORDER BY agent_id')
        .all(runId) as { agent_id: string }[]
    ).map((row) => row.agent_id)
  }

  releaseRun(runId: string): void {
    validateId(runId, 'runId')
    this.open().prepare('DELETE FROM cost_agent_runs WHERE run_id = ?').run(runId)
    this.open().prepare('UPDATE cost_runs SET active = 0, updated_at = ? WHERE run_id = ?').run(Date.now(), runId)
    this.notifyChange()
  }

  close(): void {
    this.db?.close()
    this.db = null
  }

  private ensureRun(runId: string, now: number): void {
    const existing = this.runRow(runId)
    if (existing) {
      this.open().prepare('UPDATE cost_runs SET updated_at = ? WHERE run_id = ?').run(now, runId)
      return
    }
    const defaults = this.getGlobalDefaultCaps()
    this.open()
      .prepare(
      `INSERT INTO cost_runs
         (run_id, max_usd, max_tokens, caps_configured, breached_kind,
          breached_value, breached_cap, active, updated_at)
         VALUES (?, ?, ?, 0, NULL, NULL, NULL, 1, ?)`
      )
      .run(runId, defaults.maxUsd, defaults.maxTokens, now)
  }

  private applySample(
    scope: string,
    agentId: string,
    source: string,
    sample: CostUsageSample,
    now: number
  ): void {
    const db = this.open()
    if (sample.sampleId) {
      const inserted = db
        .prepare(
          `INSERT OR IGNORE INTO cost_seen_samples
           (scope, agent_id, source, sample_id, seen_at) VALUES (?, ?, ?, ?, ?)`
        )
        .run(scope, agentId, source, sample.sampleId, now)
      if (inserted.changes === 0) return
    }
    const previous = db
      .prepare(
        `SELECT last_total_usd, last_total_tokens FROM cost_usage
         WHERE scope = ? AND agent_id = ? AND source = ?`
      )
      .get(scope, agentId, source) as StoredTotalRow | undefined
    const deltaUsd = this.delta(sample.usd, sample.mode, previous?.last_total_usd)
    const deltaTokens = this.delta(sample.tokens, sample.mode, previous?.last_total_tokens)
    const totalUsd = sample.mode === 'total' && sample.usd != null ? sample.usd : previous?.last_total_usd ?? null
    const totalTokens =
      sample.mode === 'total' && sample.tokens != null ? sample.tokens : previous?.last_total_tokens ?? null

    db.prepare(
      `INSERT INTO cost_usage
       (scope, agent_id, source, usd, tokens, last_total_usd, last_total_tokens, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(scope, agent_id, source) DO UPDATE SET
         usd = CASE WHEN excluded.usd IS NULL THEN cost_usage.usd
                    ELSE COALESCE(cost_usage.usd, 0) + excluded.usd END,
         tokens = CASE WHEN excluded.tokens IS NULL THEN cost_usage.tokens
                       ELSE COALESCE(cost_usage.tokens, 0) + excluded.tokens END,
         last_total_usd = excluded.last_total_usd,
         last_total_tokens = excluded.last_total_tokens,
         updated_at = excluded.updated_at`
    ).run(scope, agentId, source, deltaUsd, deltaTokens, totalUsd, totalTokens, now)
  }

  private delta(
    value: number | null | undefined,
    mode: CostUsageSample['mode'],
    previous: number | null | undefined
  ): number | null {
    if (value == null) return null
    if (mode !== 'total' || previous == null || value < previous) return value
    return value - previous
  }

  private totals(scope: string): CostUsageTotals {
    const row = this.open()
      .prepare('SELECT SUM(usd) AS usd, SUM(tokens) AS tokens FROM cost_usage WHERE scope = ?')
      .get(scope) as UsageRow
    return { usd: nullableSum(row.usd), tokens: nullableSum(row.tokens) }
  }

  private runRow(runId: string): RunRow | undefined {
    return this.open().prepare('SELECT * FROM cost_runs WHERE run_id = ?').get(runId) as
      | RunRow
      | undefined
  }

  private checkBreach(runId: string): CostBreach | null {
    const row = this.runRow(runId)
    if (!row || row.breached_kind) return null
    const usage = this.totals(runId)
    const candidates: CostBreach[] = []
    if (row.max_usd !== null && usage.usd !== null && usage.usd >= row.max_usd) {
      candidates.push({ runId, kind: 'usd', value: usage.usd, cap: row.max_usd })
    }
    if (row.max_tokens !== null && usage.tokens !== null && usage.tokens >= row.max_tokens) {
      candidates.push({ runId, kind: 'tokens', value: usage.tokens, cap: row.max_tokens })
    }
    if (candidates.length === 0) return null
    candidates.sort((a, b) => b.value / b.cap - a.value / a.cap)
    const breach = candidates[0]
    this.open()
      .prepare(
        `UPDATE cost_runs SET breached_kind = ?, breached_value = ?, breached_cap = ?,
         updated_at = ? WHERE run_id = ? AND breached_kind IS NULL`
      )
      .run(breach.kind, breach.value, breach.cap, Date.now(), runId)
    return breach
  }

  private notifyChange(): void {
    if (this.changes.size === 0) return
    const snapshot = this.snapshot()
    for (const callback of this.changes) callback(snapshot)
  }
}

export const costMeter = new CostMeter()

function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload)
  }
}

let ipcRegistered = false

/** Append-only main/index registration target. */
export function registerCostMeterIpc(): void {
  if (ipcRegistered) return
  ipcRegistered = true

  ipcMain.handle(CostApi.snapshot, () => costMeter.snapshot())
  ipcMain.handle(CostApi.resume, (_event, runId: string) => costMeter.resume(runId))
  ipcMain.handle(CostApi.stop, (_event, runId: string) => costMeter.stop(runId))
  ipcMain.on(
    CostApi.trackAdapter,
    (_event, message: { agentId: string; usage: CostUsageSample }) => {
      try {
        costMeter.track(null, message.agentId, message.usage)
      } catch (error) {
        console.error('[morz] rejected adapter cost sample:', error)
      }
    }
  )

  costMeter.onChange((snapshot) => broadcast(CostApi.updated, snapshot))
  costMeter.onBreach((breach) => {
    // Use the established Claude IPC contract so the adapter stays untouched.
    // Dispatcher also consumes onBreach for run-state PAUSE integration.
    for (const agentId of costMeter.agentIds(breach.runId)) {
      ipcMain.emit(ClaudeApi.interrupt, {} as IpcMainEvent, { agentId })
    }
    broadcast(CostApi.breach, breach)
  })

  if (process.env.MORZ_E2E === '1') {
    ipcMain.handle(CostApi.testTrack, (_event, input: CostTestTrackInput) => {
      if (input.caps) costMeter.configureRun(input.runId, input.caps)
      costMeter.track(input.runId, input.agentId, input.usage)
    })
  }

  app.on('will-quit', () => costMeter.close())
}
