/*
 * Morz local store (0.0.1 Slice 2) — better-sqlite3 at %APPDATA%\Morz\morz.db.
 * Holds the session snapshot (dockview layout + per-pane cwd/shell/scrollback)
 * plus a write-ahead journal: every PTY spawn/exit is journaled before/as it
 * happens so a crashed run leaves enough to (a) sweep orphaned children and
 * (b) know the snapshot may be stale. Clean shutdown clears the journal.
 */
import Database from 'better-sqlite3'
import { app, ipcMain } from 'electron'
import { join } from 'path'
import { mkdirSync } from 'fs'
import { SessionApi, type SessionSnapshot } from '../../shared/ipc'

let db: Database.Database | null = null

function open(): Database.Database {
  if (db) return db
  const dir = join(app.getPath('appData'), 'Morz')
  mkdirSync(dir, { recursive: true })
  db = new Database(join(dir, 'morz.db'))
  db.pragma('journal_mode = WAL')
  db.exec(`
    CREATE TABLE IF NOT EXISTS snapshot (
      id         INTEGER PRIMARY KEY CHECK (id = 1),
      json       TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS journal (
      id      INTEGER PRIMARY KEY AUTOINCREMENT,
      ts      INTEGER NOT NULL,
      kind    TEXT NOT NULL,
      payload TEXT NOT NULL
    );
  `)
  return db
}

/* ── session snapshot ── */
export function saveSnapshot(s: SessionSnapshot): void {
  open()
    .prepare(
      `INSERT INTO snapshot (id, json, updated_at) VALUES (1, ?, ?)
       ON CONFLICT(id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at`
    )
    .run(JSON.stringify(s), Date.now())
}

export function loadSnapshot(): SessionSnapshot | null {
  const row = open().prepare('SELECT json FROM snapshot WHERE id = 1').get() as
    | { json: string }
    | undefined
  if (!row) return null
  try {
    return JSON.parse(row.json) as SessionSnapshot
  } catch {
    return null
  }
}

/* ── write-ahead journal ── */
export function journalAppend(kind: string, payload: unknown): void {
  open()
    .prepare('INSERT INTO journal (ts, kind, payload) VALUES (?, ?, ?)')
    .run(Date.now(), kind, JSON.stringify(payload))
}

export function journalEntries(kind: string): { id: number; ts: number; payload: unknown }[] {
  return (
    open().prepare('SELECT id, ts, payload FROM journal WHERE kind = ? ORDER BY id').all(kind) as {
      id: number
      ts: number
      payload: string
    }[]
  ).map((r) => {
    let payload: unknown = null
    try {
      payload = JSON.parse(r.payload)
    } catch {
      // malformed journal row — surface as null payload, sweep skips it
    }
    return { id: r.id, ts: r.ts, payload }
  })
}

export function journalDelete(id: number): void {
  open().prepare('DELETE FROM journal WHERE id = ?').run(id)
}

export function journalClear(kind?: string): void {
  if (kind) open().prepare('DELETE FROM journal WHERE kind = ?').run(kind)
  else open().prepare('DELETE FROM journal').run()
}

/* ── IPC ── */
export function registerSessionIpc(): void {
  ipcMain.on(SessionApi.save, (_e, s: SessionSnapshot) => {
    try {
      saveSnapshot(s)
    } catch (err) {
      console.error('[morz] session save failed:', err)
    }
  })
  ipcMain.handle(SessionApi.load, () => loadSnapshot())
}
