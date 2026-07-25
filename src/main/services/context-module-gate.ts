import Database from 'better-sqlite3'
import { app } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Read-only integration seam for w15/modules-core. It deliberately does not
 * create or mutate Agent 1's table. Once that slice is integrated, every IPC
 * call observes the latest persisted toggle, including disable-without-restart.
 */
export function isContextModuleEnabled(): boolean {
  if (process.env.MORZ_E2E === '1') {
    return process.env.MORZ_E2E_CONTEXT_ENABLED === '1'
  }
  const path = join(app.getPath('appData'), 'Morz', 'morz.db')
  if (!existsSync(path)) return false
  const db = new Database(path, { readonly: true, fileMustExist: true })
  try {
    const table = db
      .prepare("SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = 'modules_enabled'")
      .get() as { found: number } | undefined
    if (!table) return false
    const row = db
      .prepare("SELECT enabled FROM modules_enabled WHERE id = 'context'")
      .get() as { enabled: number } | undefined
    return row?.enabled === 1
  } finally {
    db.close()
  }
}
