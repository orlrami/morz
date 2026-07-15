import Database from 'better-sqlite3'
import { app, BrowserWindow, ipcMain } from 'electron'
import { mkdirSync } from 'fs'
import { join } from 'path'
import {
  NotifyApi,
  type NotifyAction,
  type NotifyItem,
  type NotifyLevel,
  type NotifySource
} from '../../shared/notify'

const LEVELS = new Set<NotifyLevel>(['info', 'success', 'warning', 'error'])
const SOURCES = new Set<NotifySource>([
  'catalog',
  'pulse',
  'dispatch',
  'adapter',
  'assistant',
  'organizer',
  'app'
])
const ID_PATTERN = /^[a-z0-9][a-z0-9:._/-]{0,119}$/i
const MAX_ACTIONS = 4
const MAX_NOTICES = 500

interface NoticeRow {
  id: string
  level: NotifyLevel
  source: NotifySource
  title: string
  detail: string | null
  ts: number
  actions: string | null
  read: number
  trusted_actions: number
}

type ActionHandler = (noticeId: string) => void | Promise<void>

let db: Database.Database | null = null
let registered = false
const actionHandlers = new Map<string, ActionHandler>()

function openNotifyDb(): Database.Database {
  if (db) return db
  const dir = join(app.getPath('appData'), 'Morz')
  mkdirSync(dir, { recursive: true })
  db = new Database(join(dir, 'morz.db'))
  db.pragma('journal_mode = WAL')
  db.exec(`
    CREATE TABLE IF NOT EXISTS notices (
      id      TEXT PRIMARY KEY,
      level   TEXT NOT NULL CHECK (level IN ('info', 'success', 'warning', 'error')),
      source  TEXT NOT NULL,
      title   TEXT NOT NULL,
      detail  TEXT,
      ts      INTEGER NOT NULL,
      actions TEXT,
      read    INTEGER NOT NULL DEFAULT 0 CHECK (read IN (0, 1)),
      trusted_actions INTEGER NOT NULL DEFAULT 0 CHECK (trusted_actions IN (0, 1))
    );
    CREATE INDEX IF NOT EXISTS notices_ts_idx ON notices (ts DESC);
  `)
  const columns = new Set(
    (db.prepare('PRAGMA table_info(notices)').all() as { name: string }[]).map((column) => column.name)
  )
  if (!columns.has('trusted_actions')) {
    db.exec('ALTER TABLE notices ADD COLUMN trusted_actions INTEGER NOT NULL DEFAULT 0')
  }
  return db
}

function cleanText(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null
  const clean = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim()
  return clean ? clean.slice(0, max) : null
}

function cleanActions(value: unknown): NotifyAction[] | undefined {
  if (!Array.isArray(value)) return undefined
  const result: NotifyAction[] = []
  for (const raw of value.slice(0, MAX_ACTIONS)) {
    if (!raw || typeof raw !== 'object') continue
    const candidate = raw as Record<string, unknown>
    const id = cleanText(candidate.id, 80)
    const label = cleanText(candidate.label, 80)
    if (id && ID_PATTERN.test(id) && label) result.push({ id, label })
  }
  return result.length ? result : undefined
}

function normalizeNotice(value: unknown): NotifyItem {
  if (!value || typeof value !== 'object') throw new Error('Invalid notification payload')
  const candidate = value as Record<string, unknown>
  const id = cleanText(candidate.id, 120)
  const title = cleanText(candidate.title, 160)
  if (!id || !ID_PATTERN.test(id) || !title) throw new Error('Invalid notification identity')
  if (!LEVELS.has(candidate.level as NotifyLevel)) throw new Error('Invalid notification level')
  if (!SOURCES.has(candidate.source as NotifySource)) throw new Error('Invalid notification source')
  return {
    id,
    level: candidate.level as NotifyLevel,
    source: candidate.source as NotifySource,
    title,
    detail: cleanText(candidate.detail, 600) ?? undefined,
    actions: cleanActions(candidate.actions),
    ts: Date.now(),
    read: false
  }
}

function rowToNotice(row: NoticeRow): NotifyItem {
  let actions: NotifyAction[] | undefined
  if (row.actions) {
    try {
      actions = cleanActions(JSON.parse(row.actions) as unknown)
    } catch {
      actions = undefined
    }
  }
  return {
    id: row.id,
    level: row.level,
    source: row.source,
    title: row.title,
    detail: row.detail ?? undefined,
    ts: row.ts,
    actions,
    read: row.read === 1
  }
}

function push(item: NotifyItem): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send(NotifyApi.pushed, item)
  }
}

function persistNotice(value: unknown, trustedActions: boolean): NotifyItem {
  const item = normalizeNotice(value)
  const noticeDb = openNotifyDb()
  const actionsJson = item.actions ? JSON.stringify(item.actions) : null
  const existing = noticeDb.prepare('SELECT * FROM notices WHERE id = ?').get(item.id) as NoticeRow | undefined
  if (
    existing
    && existing.level === item.level
    && existing.source === item.source
    && existing.title === item.title
    && existing.detail === (item.detail ?? null)
    && existing.actions === actionsJson
    && existing.trusted_actions === (trustedActions ? 1 : 0)
  ) {
    return rowToNotice(existing)
  }
  if (existing) item.ts = Math.max(item.ts ?? Date.now(), existing.ts + 1)
  noticeDb
    .prepare(
      `INSERT INTO notices (id, level, source, title, detail, ts, actions, read, trusted_actions)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)
       ON CONFLICT(id) DO UPDATE SET
         level = excluded.level,
         source = excluded.source,
         title = excluded.title,
         detail = excluded.detail,
         ts = excluded.ts,
         actions = excluded.actions,
         read = 0,
         trusted_actions = excluded.trusted_actions`
    )
    .run(
      item.id,
      item.level,
      item.source,
      item.title,
      item.detail ?? null,
      item.ts,
      actionsJson,
      trustedActions ? 1 : 0
    )
  noticeDb.prepare(
    `DELETE FROM notices WHERE id NOT IN (
       SELECT id FROM notices ORDER BY ts DESC, id LIMIT ?
     )`
  ).run(MAX_NOTICES)
  push(item)
  return item
}

/** Main-process producer entry point. Re-emitting an id updates one durable row. */
export function notify(value: Omit<NotifyItem, 'ts' | 'read'> & Partial<Pick<NotifyItem, 'ts' | 'read'>>): NotifyItem {
  return persistNotice(value, true)
}

export function listNotices(): NotifyItem[] {
  return (openNotifyDb().prepare('SELECT * FROM notices ORDER BY ts DESC, id LIMIT ?').all(MAX_NOTICES) as NoticeRow[])
    .map(rowToNotice)
}

export function markNoticeRead(id: string): void {
  if (id === '*') {
    openNotifyDb().prepare('UPDATE notices SET read = 1').run()
    return
  }
  if (!ID_PATTERN.test(id)) return
  openNotifyDb().prepare('UPDATE notices SET read = 1 WHERE id = ?').run(id)
}

export function dismissNotice(id: string): void {
  if (id === '*') {
    openNotifyDb().prepare('DELETE FROM notices').run()
    return
  }
  if (!ID_PATTERN.test(id)) return
  openNotifyDb().prepare('DELETE FROM notices WHERE id = ?').run(id)
}

export function registerNotifyAction(actionId: string, handler: ActionHandler): () => void {
  if (!ID_PATTERN.test(actionId)) throw new Error('Invalid notification action id')
  actionHandlers.set(actionId, handler)
  return () => {
    if (actionHandlers.get(actionId) === handler) actionHandlers.delete(actionId)
  }
}

function noticeAllowsAction(noticeId: string, actionId: string): boolean {
  if (!ID_PATTERN.test(noticeId) || !ID_PATTERN.test(actionId)) return false
  const row = openNotifyDb().prepare('SELECT actions, trusted_actions FROM notices WHERE id = ?').get(noticeId) as
    | { actions: string | null; trusted_actions: number }
    | undefined
  if (!row?.actions || row.trusted_actions !== 1) return false
  try {
    return cleanActions(JSON.parse(row.actions) as unknown)?.some((action) => action.id === actionId) ?? false
  } catch {
    return false
  }
}

export function registerNotifyCenter(): void {
  if (registered) return
  registered = true
  openNotifyDb()
  ipcMain.on(NotifyApi.emit, (_event, item: NotifyItem) => {
    try {
      const untrusted = item && typeof item === 'object' ? { ...item, actions: undefined } : item
      persistNotice(untrusted, false)
    } catch (error) {
      console.warn('[morz] rejected invalid notification:', error instanceof Error ? error.message : error)
    }
  })
  ipcMain.handle(NotifyApi.list, () => listNotices())
  ipcMain.on(NotifyApi.markRead, (_event, id: unknown) => {
    if (typeof id === 'string') markNoticeRead(id)
  })
  ipcMain.on(NotifyApi.dismiss, (_event, id: unknown) => {
    if (typeof id === 'string') dismissNotice(id)
  })
  ipcMain.on(NotifyApi.action, (_event, payload: unknown) => {
    if (!payload || typeof payload !== 'object') return
    const { id, actionId } = payload as Record<string, unknown>
    if (typeof id !== 'string' || typeof actionId !== 'string') return
    if (!noticeAllowsAction(id, actionId)) return
    const handler = actionHandlers.get(actionId)
    if (!handler) return
    void Promise.resolve(handler(id)).then(() => {
      for (const window of BrowserWindow.getAllWindows()) {
        if (!window.isDestroyed()) window.webContents.send(NotifyApi.action, { id, actionId })
      }
    }).catch((error) => {
      console.error('[morz] notification action failed:', error)
      notify({
        id: `app:notify-action:${actionId}`,
        level: 'error',
        source: 'app',
        title: 'Notification action failed',
        detail: cleanText(error instanceof Error ? error.message : error, 300) ?? 'The action could not be completed.'
      })
    })
  })
}
