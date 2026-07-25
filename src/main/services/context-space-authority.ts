import Database from 'better-sqlite3'
import { app } from 'electron'
import { mkdirSync } from 'node:fs'
import { realpath } from 'node:fs/promises'
import { dirname, join, normalize } from 'node:path'

let database: Database.Database | null = null

function key(root: string): string {
  const normalized = normalize(root).replace(/[\\/]+$/, '')
  return process.platform === 'win32' ? normalized.toLocaleLowerCase() : normalized
}

function open(): Database.Database {
  if (database) return database
  const path = join(app.getPath('appData'), 'Morz', 'morz.db')
  mkdirSync(dirname(path), { recursive: true })
  database = new Database(path)
  database.pragma('journal_mode = WAL')
  database.exec(`
    CREATE TABLE IF NOT EXISTS context_authorized_roots (
      root TEXT PRIMARY KEY,
      authorized_at TEXT NOT NULL
    );
  `)
  return database
}

/**
 * The native directory picker is the only production caller that grants this
 * authority. Renderer-controlled localStorage can describe a Space, but it
 * cannot grant Context Hub permission to write into an arbitrary directory.
 */
export async function authorizeContextSpaceRoot(rootInput: string): Promise<string> {
  const root = await realpath(rootInput)
  open()
    .prepare(
      `INSERT INTO context_authorized_roots (root, authorized_at)
       VALUES (?, CURRENT_TIMESTAMP)
       ON CONFLICT(root) DO UPDATE SET authorized_at = excluded.authorized_at`
    )
    .run(key(root))
  return root
}

export async function isContextSpaceRootAuthorized(rootInput: string): Promise<boolean> {
  let root: string
  try {
    root = await realpath(rootInput)
  } catch {
    return false
  }
  const row = open()
    .prepare('SELECT 1 AS found FROM context_authorized_roots WHERE root = ?')
    .get(key(root)) as { found: number } | undefined
  return row?.found === 1
}
