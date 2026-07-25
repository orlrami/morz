/*
 * w15/model-choice — persisted ModelChoice rows in morz.db.
 *
 * Key = (cli, scope). Scope encoding:
 *   ''                → the global default for that CLI
 *   'planner'         → the planner engine's Claude model (unified from the
 *                       w12 orchestrator_planner_settings.claude_model column)
 *   <absolute path>   → a per-space override; wins over '' when resolving.
 *
 * Pure better-sqlite3 module — no electron import, so planner unit tests and
 * the smoke path can open it against any db path (PlannerEngineStore pattern).
 */
import Database from 'better-sqlite3'
import { mkdirSync } from 'fs'
import { dirname } from 'path'
import {
  inheritChoice,
  isSafeModelId,
  MODEL_CLIS,
  MODEL_SOURCES,
  type ModelChoice,
  type ModelCli,
  type ModelSource
} from '../../shared/model-choice'

export const PLANNER_SCOPE = 'planner'
export const GLOBAL_SCOPE = ''

export interface ModelChoiceRow extends ModelChoice {
  scope: string
}

const DDL = `
  CREATE TABLE IF NOT EXISTS model_choice (
    cli TEXT NOT NULL CHECK (cli IN ('claude', 'codex', 'agy', 'opencode')),
    scope TEXT NOT NULL DEFAULT '',
    model TEXT NOT NULL DEFAULT 'inherit',
    source TEXT NOT NULL CHECK (source IN ('inherit', 'session-flag', 'cli-config')),
    fallback TEXT,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (cli, scope)
  );
`

function normalizeCli(value: unknown): ModelCli {
  if (typeof value !== 'string' || !MODEL_CLIS.includes(value as ModelCli)) {
    throw new Error('Model choice cli must be claude, codex, agy, or opencode')
  }
  return value as ModelCli
}

function normalizeSource(value: unknown): ModelSource {
  if (typeof value !== 'string' || !MODEL_SOURCES.includes(value as ModelSource)) {
    throw new Error('Model choice source must be inherit, session-flag, or cli-config')
  }
  return value as ModelSource
}

function normalizeModel(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error('Model choice model must be a non-empty string')
  }
  if (value !== 'inherit' && !isSafeModelId(value)) {
    throw new Error(`Model id has an unsupported shape: ${JSON.stringify(value.slice(0, 40))}`)
  }
  return value
}

function normalizeFallback(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null
  if (typeof value !== 'string' || value.length > 400) {
    throw new Error('Model fallback chain must be a short string')
  }
  return value
}

export interface ModelChoiceInput {
  cli: ModelCli
  model: string
  source: ModelSource
  fallback?: string | null
  scope?: string
}

export class ModelChoiceStore {
  private readonly db: Database.Database
  private readonly ownsDb: boolean

  constructor(dbPathOrDb: string | Database.Database) {
    if (typeof dbPathOrDb === 'string') {
      mkdirSync(dirname(dbPathOrDb), { recursive: true })
      this.db = new Database(dbPathOrDb)
      this.db.pragma('journal_mode = WAL')
      this.ownsDb = true
    } else {
      this.db = dbPathOrDb
      this.ownsDb = false
    }
    this.db.exec(DDL)
  }

  /** Raw row for one (cli, scope); null when nothing was ever saved. */
  get(cli: ModelCli, scope: string = GLOBAL_SCOPE): ModelChoiceRow | null {
    const row = this.db
      .prepare('SELECT cli, scope, model, source, fallback FROM model_choice WHERE cli = ? AND scope = ?')
      .get(cli, scope) as
      | { cli: string; scope: string; model: string; source: string; fallback: string | null }
      | undefined
    if (!row) return null
    return {
      cli: normalizeCli(row.cli),
      scope: row.scope,
      model: row.model,
      source: normalizeSource(row.source),
      fallback: row.fallback
    }
  }

  /** Effective choice for a launch: space override → global → inherit. */
  resolve(cli: ModelCli, spaceRoot?: string | null): ModelChoice {
    const scoped = spaceRoot ? this.get(cli, spaceRoot) : null
    const row = scoped ?? this.get(cli, GLOBAL_SCOPE)
    if (!row) return inheritChoice(cli)
    return { cli, model: row.model, source: row.source, fallback: row.fallback }
  }

  set(input: ModelChoiceInput): ModelChoiceRow {
    const cli = normalizeCli(input.cli)
    const source = normalizeSource(input.source)
    const model = source === 'inherit' ? 'inherit' : normalizeModel(input.model)
    const fallback = normalizeFallback(input.fallback)
    const scope = typeof input.scope === 'string' ? input.scope : GLOBAL_SCOPE
    this.db
      .prepare(
        `INSERT INTO model_choice (cli, scope, model, source, fallback, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (cli, scope) DO UPDATE SET
           model = excluded.model, source = excluded.source,
           fallback = excluded.fallback, updated_at = excluded.updated_at`
      )
      .run(cli, scope, model, source, fallback, new Date().toISOString())
    return this.get(cli, scope)!
  }

  clear(cli: ModelCli, scope: string): void {
    this.db.prepare('DELETE FROM model_choice WHERE cli = ? AND scope = ?').run(normalizeCli(cli), scope)
  }

  listScopes(cli: ModelCli): ModelChoiceRow[] {
    const rows = this.db
      .prepare('SELECT cli, scope, model, source, fallback FROM model_choice WHERE cli = ?')
      .all(cli) as Array<{ cli: string; scope: string; model: string; source: string; fallback: string | null }>
    return rows.map((row) => ({
      cli: normalizeCli(row.cli),
      scope: row.scope,
      model: row.model,
      source: normalizeSource(row.source),
      fallback: row.fallback
    }))
  }

  close(): void {
    if (this.ownsDb && this.db.open) this.db.close()
  }
}

/* ── planner unification (w12 claude_model column → this store) ──
 * The planner's Claude model is just a ModelChoice row (cli 'claude', scope
 * 'planner', source 'session-flag' — planning always launches with -p and an
 * explicit --model). Values keep the planner alias set sonnet|opus|fable. */

const PLANNER_MODELS = new Set(['sonnet', 'opus', 'fable'])

export function getPlannerClaudeModel(store: ModelChoiceStore): 'sonnet' | 'opus' | 'fable' {
  const row = store.get('claude', PLANNER_SCOPE)
  return row && PLANNER_MODELS.has(row.model) ? (row.model as 'sonnet' | 'opus' | 'fable') : 'sonnet'
}

export function setPlannerClaudeModel(store: ModelChoiceStore, value: unknown): 'sonnet' | 'opus' | 'fable' {
  if (typeof value !== 'string' || !PLANNER_MODELS.has(value)) {
    throw new Error('Planner Claude model must be sonnet, opus, or fable')
  }
  store.set({ cli: 'claude', scope: PLANNER_SCOPE, model: value, source: 'session-flag' })
  return value as 'sonnet' | 'opus' | 'fable'
}

/** One-time seed: copy the legacy w12 planner claude_model column into the
 * unified row if the planner scope has never been written here. */
export function seedPlannerModelFromLegacy(store: ModelChoiceStore, legacyModel: string): void {
  if (store.get('claude', PLANNER_SCOPE)) return
  if (!PLANNER_MODELS.has(legacyModel) || legacyModel === 'sonnet') return
  store.set({ cli: 'claude', scope: PLANNER_SCOPE, model: legacyModel, source: 'session-flag' })
}
