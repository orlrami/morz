/*
 * Module enablement persistence (w15/modules-core) — one row per module in the
 * settings SQLite DB, following the PlannerEngineStore pattern
 * (src/main/orchestrator/planner.ts). Seeding happens once per profile
 * (INSERT OR IGNORE), so persisted user choices always win over defaults.
 *
 * MORZ_MODULES (seed override, first boot only — the e2e harness uses it so
 * existing specs keep their surfaces; the packaged app never sets it):
 *   'all'  → every module seeded on
 *   'none' → every module seeded off
 *   CSV    → the listed module ids seeded on, the rest off
 */
import { app, ipcMain } from 'electron'
import Database from 'better-sqlite3'
import { mkdirSync } from 'fs'
import { dirname, join } from 'path'
import {
  MODULES,
  ModulesApi,
  defaultModulesEnabled,
  isModuleId,
  type ModuleId
} from '../../shared/modules'

function seedEnabled(id: ModuleId, defaultOn: boolean): boolean {
  const override = process.env.MORZ_MODULES?.trim()
  if (!override || override === 'defaults') return defaultOn
  if (override === 'all') return true
  if (override === 'none') return false
  return override.split(',').some((entry) => entry.trim() === id)
}

export class ModulesStore {
  private readonly db: Database.Database

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true })
    this.db = new Database(dbPath)
    this.db.pragma('journal_mode = WAL')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS modules_enabled (
        id TEXT PRIMARY KEY,
        enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
        updated_at TEXT NOT NULL
      );
    `)
    const seed = this.db.prepare(
      'INSERT OR IGNORE INTO modules_enabled (id, enabled, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)'
    )
    for (const def of MODULES) seed.run(def.id, seedEnabled(def.id, def.defaultOn) ? 1 : 0)
  }

  get(): Record<ModuleId, boolean> {
    const map = defaultModulesEnabled()
    const rows = this.db.prepare('SELECT id, enabled FROM modules_enabled').all() as {
      id: string
      enabled: number
    }[]
    for (const row of rows) {
      if (isModuleId(row.id)) map[row.id] = row.enabled === 1
    }
    return map
  }

  set(id: ModuleId, on: boolean): Record<ModuleId, boolean> {
    this.db
      .prepare(
        `INSERT INTO modules_enabled (id, enabled, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT(id) DO UPDATE SET enabled = excluded.enabled, updated_at = excluded.updated_at`
      )
      .run(id, on ? 1 : 0)
    return this.get()
  }
}

let store: ModulesStore | null = null

function modulesStore(): ModulesStore {
  return (store ??= new ModulesStore(join(app.getPath('appData'), 'Morz', 'morz.db')))
}

export function registerModulesIpc(): void {
  ipcMain.handle(ModulesApi.get, () => modulesStore().get())
  ipcMain.handle(ModulesApi.set, (_event, input: unknown) => {
    if (input === null || typeof input !== 'object') throw new Error('modules:set payload is invalid')
    const { id, on } = input as { id?: unknown; on?: unknown }
    if (!isModuleId(id)) throw new Error('modules:set id is not a known module')
    if (typeof on !== 'boolean') throw new Error('modules:set on must be a boolean')
    return modulesStore().set(id, on)
  })
}
