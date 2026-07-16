import Database from 'better-sqlite3'
import { app, ipcMain } from 'electron'
import { closeSync, existsSync, mkdirSync, openSync, readSync, readdirSync, statSync } from 'fs'
import { homedir } from 'os'
import { isAbsolute, join, normalize } from 'path'
import { randomUUID } from 'crypto'
import {
  SessionHistoryApi,
  type SessionHistoryRecord,
  type SessionHistoryStartInput
} from '../../shared/ipc'

interface SessionRow {
  id: string
  space_root: string
  started_at: number
  ended_at: number | null
  title: string
  agents_json: string
  summary: string | null
}

const MAX_ROOT_LENGTH = 4096
const MAX_TITLE_LENGTH = 160
const MAX_SUMMARY_LENGTH = 2000
const MAX_AGENTS = 16
const MAX_AGENT_LENGTH = 48
const EXTERNAL_LIMIT = 8
const CLAUDE_HEADER_BYTES = 256 * 1024

let db: Database.Database | null = null

function openDb(): Database.Database {
  if (db) return db
  const dir = join(app.getPath('appData'), 'Morz')
  mkdirSync(dir, { recursive: true })
  db = new Database(join(dir, 'morz.db'))
  db.pragma('journal_mode = WAL')
  db.exec(`
    CREATE TABLE IF NOT EXISTS session_history (
      id          TEXT PRIMARY KEY,
      space_root  TEXT NOT NULL,
      space_key   TEXT NOT NULL,
      started_at  INTEGER NOT NULL,
      ended_at    INTEGER,
      title       TEXT NOT NULL,
      agents_json TEXT NOT NULL,
      summary     TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_session_history_space_started
      ON session_history (space_key, started_at DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_session_history_one_live
      ON session_history ((1)) WHERE ended_at IS NULL;
  `)
  return db
}

function checkedRoot(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_ROOT_LENGTH ||
    value.includes('\0') ||
    !isAbsolute(value)
  ) {
    throw new Error('A valid absolute space root is required')
  }
  return normalize(value)
}

function rootKey(root: string): string {
  return normalize(root).replace(/[\\/]+$/, '').replace(/\\/g, '/').toLocaleLowerCase()
}

function cleanText(value: unknown, fallback: string, maxLength: number): string {
  if (typeof value !== 'string') return fallback
  const clean = value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim()
  return clean.slice(0, maxLength) || fallback
}

function cleanAgents(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const unique = new Set<string>()
  for (const candidate of value) {
    if (typeof candidate !== 'string') continue
    const clean = cleanText(candidate, '', MAX_AGENT_LENGTH)
    if (clean) unique.add(clean)
    if (unique.size >= MAX_AGENTS) break
  }
  return [...unique]
}

function parseAgents(value: string): string[] {
  try {
    return cleanAgents(JSON.parse(value))
  } catch {
    return []
  }
}

function fromRow(row: SessionRow): SessionHistoryRecord {
  return {
    id: row.id,
    spaceRoot: row.space_root,
    startedAt: new Date(row.started_at).toISOString(),
    endedAt: row.ended_at === null ? null : new Date(row.ended_at).toISOString(),
    title: row.title,
    agentsUsed: parseAgents(row.agents_json),
    summary: row.summary ?? undefined,
    source: 'morz'
  }
}

function currentRow(database = openDb()): SessionRow | undefined {
  return database
    .prepare('SELECT * FROM session_history WHERE ended_at IS NULL ORDER BY started_at DESC LIMIT 1')
    .get() as SessionRow | undefined
}

export function startSession(input: SessionHistoryStartInput): SessionHistoryRecord {
  const spaceRoot = checkedRoot(input?.spaceRoot)
  const key = rootKey(spaceRoot)
  const title = cleanText(input?.title, 'Project session', MAX_TITLE_LENGTH)
  const agents = cleanAgents(input?.agentsUsed)
  const summary = input?.summary
    ? cleanText(input.summary, '', MAX_SUMMARY_LENGTH) || null
    : null
  const database = openDb()

  return database.transaction(() => {
    const current = currentRow(database)
    if (current && rootKey(current.space_root) === key) {
      const mergedAgents = cleanAgents([...parseAgents(current.agents_json), ...agents])
      database
        .prepare('UPDATE session_history SET title = ?, agents_json = ?, summary = COALESCE(?, summary) WHERE id = ?')
        .run(title, JSON.stringify(mergedAgents), summary, current.id)
      return fromRow({
        ...current,
        title,
        agents_json: JSON.stringify(mergedAgents),
        summary: summary ?? current.summary
      })
    }

    const now = Date.now()
    database.prepare('UPDATE session_history SET ended_at = ? WHERE ended_at IS NULL').run(now)
    const row: SessionRow = {
      id: randomUUID(),
      space_root: spaceRoot,
      started_at: now,
      ended_at: null,
      title,
      agents_json: JSON.stringify(agents),
      summary
    }
    database
      .prepare(
        `INSERT INTO session_history
          (id, space_root, space_key, started_at, ended_at, title, agents_json, summary)
         VALUES (?, ?, ?, ?, NULL, ?, ?, ?)`
      )
      .run(row.id, spaceRoot, key, now, title, row.agents_json, summary)
    return fromRow(row)
  })()
}

export function endSession(sessionId?: string): SessionHistoryRecord | null {
  if (sessionId !== undefined && (typeof sessionId !== 'string' || sessionId.length > 128)) {
    throw new Error('Invalid session id')
  }
  const database = openDb()
  const row = sessionId
    ? (database.prepare('SELECT * FROM session_history WHERE id = ? AND ended_at IS NULL').get(sessionId) as
        | SessionRow
        | undefined)
    : currentRow(database)
  if (!row) return null
  const endedAt = Date.now()
  database.prepare('UPDATE session_history SET ended_at = ? WHERE id = ? AND ended_at IS NULL').run(endedAt, row.id)
  return fromRow({ ...row, ended_at: endedAt })
}

export function currentSession(spaceRoot: string): SessionHistoryRecord | null {
  const root = checkedRoot(spaceRoot)
  const row = openDb()
    .prepare('SELECT * FROM session_history WHERE space_key = ? AND ended_at IS NULL LIMIT 1')
    .get(rootKey(root)) as SessionRow | undefined
  return row ? fromRow(row) : null
}

function claudeProjectSlug(spaceRoot: string): string {
  return spaceRoot.replace(/[^A-Za-z0-9]/g, '-')
}

function readClaudeHeader(path: string): { sessionId?: string; timestamp?: string; gitBranch?: string } {
  const fd = openSync(path, 'r')
  try {
    const buffer = Buffer.alloc(CLAUDE_HEADER_BYTES)
    const bytes = readSync(fd, buffer, 0, buffer.length, 0)
    const metadata: { sessionId?: string; timestamp?: string; gitBranch?: string } = {}
    for (const line of buffer.toString('utf8', 0, bytes).split(/\r?\n/)) {
      if (!line.trim()) continue
      try {
        const value = JSON.parse(line) as Record<string, unknown>
        if (!metadata.sessionId && typeof value.sessionId === 'string') metadata.sessionId = value.sessionId
        if (!metadata.timestamp && typeof value.timestamp === 'string') metadata.timestamp = value.timestamp
        if (!metadata.gitBranch && typeof value.gitBranch === 'string') metadata.gitBranch = value.gitBranch
      } catch {
        // A partial final line or malformed event does not hide the other sessions.
      }
      if (metadata.sessionId && metadata.timestamp && metadata.gitBranch) break
    }
    return metadata
  } finally {
    closeSync(fd)
  }
}

function claudeSessions(spaceRoot: string): SessionHistoryRecord[] {
  const projectDir = join(homedir(), '.claude', 'projects', claudeProjectSlug(spaceRoot))
  if (!existsSync(projectDir)) return []
  try {
    return readdirSync(projectDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl'))
      .map((entry) => {
        const path = join(projectDir, entry.name)
        return { path, name: entry.name, stat: statSync(path) }
      })
      .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs)
      .slice(0, EXTERNAL_LIMIT)
      .map(({ path, name, stat }) => {
        const metadata = readClaudeHeader(path)
        const parsedStart = metadata.timestamp ? Date.parse(metadata.timestamp) : Number.NaN
        const startedAt = Number.isFinite(parsedStart) ? parsedStart : stat.birthtimeMs || stat.mtimeMs
        return {
          id: `claude:${metadata.sessionId ?? name.replace(/\.jsonl$/i, '')}`,
          spaceRoot,
          startedAt: new Date(startedAt).toISOString(),
          endedAt: new Date(stat.mtimeMs).toISOString(),
          title: cleanText(metadata.gitBranch, 'Claude session', MAX_TITLE_LENGTH),
          agentsUsed: ['claude'],
          source: 'claude' as const
        }
      })
  } catch (error) {
    console.warn('[morz] Claude session scan skipped:', error instanceof Error ? error.message : 'unknown error')
    return []
  }
}

export function listSessions(spaceRoot: string): SessionHistoryRecord[] {
  const root = checkedRoot(spaceRoot)
  const local = (
    openDb()
      .prepare('SELECT * FROM session_history WHERE space_key = ? ORDER BY started_at DESC LIMIT 100')
      .all(rootKey(root)) as SessionRow[]
  ).map(fromRow)
  return [...local, ...claudeSessions(root)].sort((left, right) => {
    const leftLive = left.source === 'morz' && left.endedAt === null
    const rightLive = right.source === 'morz' && right.endedAt === null
    if (leftLive !== rightLive) return leftLive ? -1 : 1
    return Date.parse(right.startedAt) - Date.parse(left.startedAt)
  })
}

function ipcFailure(operation: string, error: unknown): never {
  console.error(`[morz] session history ${operation} failed:`, error)
  throw new Error(`Unable to ${operation} session history`)
}

export function registerSessionsIpc(): void {
  openDb()
  ipcMain.handle(SessionHistoryApi.start, (_event, input: SessionHistoryStartInput) => {
    try {
      return startSession(input)
    } catch (error) {
      return ipcFailure('start', error)
    }
  })
  ipcMain.handle(SessionHistoryApi.end, (_event, sessionId?: string) => {
    try {
      return endSession(sessionId)
    } catch (error) {
      return ipcFailure('end', error)
    }
  })
  ipcMain.handle(SessionHistoryApi.list, (_event, spaceRoot: string) => {
    try {
      return listSessions(spaceRoot)
    } catch (error) {
      return ipcFailure('list', error)
    }
  })
  ipcMain.handle(SessionHistoryApi.current, (_event, spaceRoot: string) => {
    try {
      return currentSession(spaceRoot)
    } catch (error) {
      return ipcFailure('read current', error)
    }
  })
  app.on('before-quit', () => {
    try {
      endSession()
    } catch (error) {
      console.error('[morz] session history shutdown failed:', error)
    }
  })
}
