import Database from 'better-sqlite3'
import { app, safeStorage, type IpcMain } from 'electron'
import { mkdirSync } from 'fs'
import { join } from 'path'
import { randomBytes } from 'crypto'
import {
  ObsidianApi,
  type ObsidianMadrBody,
  type ObsidianSearchResult,
  type ObsidianStatus
} from '../../shared/ipc'

const MAX_API_KEY_LENGTH = 4_096
const MAX_NOTE_LENGTH = 5 * 1024 * 1024
const MAX_PATH_LENGTH = 500
const MAX_QUERY_LENGTH = 500
const MAX_ADR_FIELD_LENGTH = 100_000
const MAX_SEARCH_RESPONSE_LENGTH = 2 * 1024 * 1024
const MAX_DRAFTS = 100
const DRAFT_TTL_MS = 10 * 60 * 1_000

interface StoredConfigRow {
  base_url: string
  api_key_cipher: Buffer
}

interface ObsidianConfig {
  baseUrl: string
  apiKey: string
}

interface AdrDraft {
  folder: string
  title: string
  preview: string
  expiresAt: number
}

let configDb: Database.Database | null = null
const drafts = new Map<string, AdrDraft>()
let writeQueue: Promise<void> = Promise.resolve()

function openConfigDb(): Database.Database {
  if (configDb) return configDb
  const dir = join(app.getPath('appData'), 'Morz')
  mkdirSync(dir, { recursive: true })
  configDb = new Database(join(dir, 'morz.db'))
  configDb.pragma('journal_mode = WAL')
  configDb.exec(`
    CREATE TABLE IF NOT EXISTS obsidian_config (
      id             INTEGER PRIMARY KEY CHECK (id = 1),
      base_url       TEXT NOT NULL,
      api_key_cipher BLOB NOT NULL,
      updated_at     INTEGER NOT NULL
    )
  `)
  return configDb
}

function normalizeBaseUrl(value: string): string {
  let url: URL
  try {
    url = new URL(value.trim())
  } catch {
    throw new Error('Enter a valid Obsidian Local REST API URL.')
  }
  const loopbackHosts = new Set(['127.0.0.1', 'localhost', '[::1]'])
  if (!['http:', 'https:'].includes(url.protocol) || !loopbackHosts.has(url.hostname)) {
    throw new Error('Obsidian must use an http(s) loopback URL (127.0.0.1 or localhost).')
  }
  if (url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) {
    throw new Error('Use only the Obsidian server origin, without credentials, paths, queries, or fragments.')
  }
  return url.origin
}

function validateApiKey(value: string): string {
  if (!value || value.length > MAX_API_KEY_LENGTH || /[\r\n]/.test(value)) {
    throw new Error('Enter a valid Obsidian API key.')
  }
  return value
}

function normalizeVaultPath(value: string, label = 'note path'): string {
  const path = value.trim().replaceAll('\\', '/')
  if (!path || path.length > MAX_PATH_LENGTH || path.startsWith('/') || /[\u0000-\u001f]/.test(path)) {
    throw new Error(`Enter a valid relative ${label}.`)
  }
  const parts = path.split('/')
  if (parts.some((part) => !part || part === '.' || part === '..')) {
    throw new Error(`${label[0].toUpperCase()}${label.slice(1)} cannot contain empty, dot, or parent segments.`)
  }
  return parts.join('/')
}

function vaultUrl(baseUrl: string, path: string): string {
  const encoded = normalizeVaultPath(path)
    .split('/')
    .map((part) => encodeURIComponent(part))
    .join('/')
  return `${baseUrl}/vault/${encoded}`
}

function loadConfig(): ObsidianConfig | null {
  const row = openConfigDb()
    .prepare('SELECT base_url, api_key_cipher FROM obsidian_config WHERE id = 1')
    .get() as StoredConfigRow | undefined
  if (!row) return null
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('Secure credential storage is unavailable.')
  }
  try {
    return {
      baseUrl: normalizeBaseUrl(row.base_url),
      apiKey: safeStorage.decryptString(Buffer.from(row.api_key_cipher))
    }
  } catch {
    throw new Error('The saved Obsidian credential could not be decrypted.')
  }
}

function storeConfig(config: ObsidianConfig): void {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('Secure credential storage is unavailable; the API key was not saved.')
  }
  const encrypted = safeStorage.encryptString(config.apiKey)
  openConfigDb()
    .prepare(
      `INSERT INTO obsidian_config (id, base_url, api_key_cipher, updated_at)
       VALUES (1, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         base_url = excluded.base_url,
         api_key_cipher = excluded.api_key_cipher,
         updated_at = excluded.updated_at`
    )
    .run(config.baseUrl, encrypted, Date.now())
}

async function authorizedFetch(
  config: ObsidianConfig,
  url: string,
  init: RequestInit = {}
): Promise<Response> {
  const headers = new Headers(init.headers)
  headers.set('Authorization', `Bearer ${config.apiKey}`)
  return fetch(url, {
    ...init,
    headers,
    redirect: 'error',
    signal: AbortSignal.timeout(5_000)
  })
}

async function probe(config: ObsidianConfig): Promise<void> {
  const response = await authorizedFetch(config, `${config.baseUrl}/`)
  if (!response.ok) throw new Error(`Obsidian rejected the connection (${response.status}).`)
  const text = await readTextLimited(response, 64 * 1024, 'Obsidian connection response')
  let payload: unknown
  try {
    payload = JSON.parse(text)
  } catch {
    throw new Error('Obsidian returned an invalid connection response.')
  }
  if (
    typeof payload !== 'object' ||
    payload === null ||
    (payload as { authenticated?: unknown }).authenticated !== true
  ) {
    throw new Error('Obsidian rejected the API key.')
  }
}

async function readTextLimited(response: Response, limit: number, label: string): Promise<string> {
  const declaredLength = Number(response.headers.get('content-length') ?? '0')
  if (declaredLength > limit) throw new Error(`${label} is too large.`)
  if (!response.body) return ''
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > limit) throw new Error(`${label} is too large.`)
      chunks.push(value)
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined)
    throw error
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), total).toString('utf8')
}

function requireConfig(): ObsidianConfig {
  const config = loadConfig()
  if (!config) throw new Error('Obsidian is not connected.')
  return config
}

export async function getObsidianStatus(): Promise<ObsidianStatus> {
  let config: ObsidianConfig | null
  try {
    config = loadConfig()
  } catch (error) {
    return { state: 'offline', error: error instanceof Error ? error.message : 'Obsidian is unavailable.' }
  }
  if (!config) return { state: 'not-connected' }
  try {
    await probe(config)
    return { state: 'connected', baseUrl: config.baseUrl }
  } catch {
    return { state: 'offline', baseUrl: config.baseUrl, error: 'Obsidian is configured but unreachable.' }
  }
}

export async function connect(baseUrl: string, apiKey: string): Promise<ObsidianStatus> {
  const config = { baseUrl: normalizeBaseUrl(baseUrl), apiKey: validateApiKey(apiKey) }
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('Secure credential storage is unavailable; the API key was not sent or saved.')
  }
  try {
    await probe(config)
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Obsidian rejected')) throw error
    throw new Error(
      'Could not reach Obsidian. For HTTPS, trust the plugin certificate; otherwise enable its localhost HTTP port.'
    )
  }
  storeConfig(config)
  return { state: 'connected', baseUrl: config.baseUrl }
}

export async function readNote(path: string): Promise<string> {
  const config = requireConfig()
  const response = await authorizedFetch(config, vaultUrl(config.baseUrl, path), {
    headers: { Accept: 'text/markdown' }
  })
  if (!response.ok) throw new Error(`Obsidian could not read that note (${response.status}).`)
  return readTextLimited(response, MAX_NOTE_LENGTH, 'The Obsidian note')
}

export async function searchNotes(query: string): Promise<ObsidianSearchResult[]> {
  const value = query.trim()
  if (!value || value.length > MAX_QUERY_LENGTH || /[\u0000-\u001f]/.test(value)) {
    throw new Error('Enter a valid Obsidian search query.')
  }
  const config = requireConfig()
  const url = `${config.baseUrl}/search/simple/?query=${encodeURIComponent(value)}`
  let response = await authorizedFetch(config, url, { method: 'POST', headers: { Accept: 'application/json' } })
  if (response.status === 404 || response.status === 405) {
    await response.body?.cancel()
    response = await authorizedFetch(config, url, { method: 'GET', headers: { Accept: 'application/json' } })
  }
  if (!response.ok) throw new Error(`Obsidian search failed (${response.status}).`)
  const raw = await readTextLimited(response, MAX_SEARCH_RESPONSE_LENGTH, 'Obsidian search response')
  let result: unknown
  try {
    result = JSON.parse(raw)
  } catch {
    throw new Error('Obsidian returned an invalid search response.')
  }
  if (!Array.isArray(result)) throw new Error('Obsidian returned an invalid search response.')
  return result.filter(
    (item): item is ObsidianSearchResult =>
      typeof item === 'object' && item !== null && typeof (item as { filename?: unknown }).filename === 'string'
  )
}

function validateMadrBody(body: ObsidianMadrBody): ObsidianMadrBody {
  const keys: (keyof ObsidianMadrBody)[] = ['status', 'context', 'decision', 'consequences']
  if (
    typeof body !== 'object' ||
    body === null ||
    Array.isArray(body) ||
    Object.keys(body).length !== keys.length ||
    keys.some((key) => !Object.prototype.hasOwnProperty.call(body, key))
  ) {
    throw new Error('The MADR body is incomplete.')
  }
  const validated = {} as ObsidianMadrBody
  for (const key of keys) {
    const value: unknown = body[key]
    if (typeof value !== 'string' || !value.trim() || value.length > MAX_ADR_FIELD_LENGTH) {
      throw new Error(`Enter a valid MADR ${key}.`)
    }
    validated[key] = value.trim()
  }
  return validated
}

function sanitizeTitle(value: string): string {
  const title = value
    .trim()
    .replace(/[\\/:*?"<>|#^%\u0000-\u001f]/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/[. ]+$/g, '')
  if (!title || title.length > 200) throw new Error('Enter a valid ADR title under 200 characters.')
  return title
}

export function prepareAdr(
  folder: string,
  title: string,
  madrBody: ObsidianMadrBody
): { preview: string; draftId: string } {
  const cleanFolder = normalizeVaultPath(folder, 'ADR folder')
  const cleanTitle = sanitizeTitle(title)
  const body = validateMadrBody(madrBody)
  const preview = `# ${cleanTitle}\n\n## Status\n${body.status}\n\n## Context\n${body.context}\n\n## Decision\n${body.decision}\n\n## Consequences\n${body.consequences}\n`
  const now = Date.now()
  for (const [id, draft] of drafts) if (draft.expiresAt <= now) drafts.delete(id)
  if (drafts.size >= MAX_DRAFTS) throw new Error('Too many pending ADR previews; confirm or wait for one to expire.')
  const draftId = randomBytes(32).toString('hex')
  drafts.set(draftId, { folder: cleanFolder, title: cleanTitle, preview, expiresAt: now + DRAFT_TTL_MS })
  return { preview, draftId }
}

function enqueueWrite<T>(operation: () => Promise<T>): Promise<T> {
  const result = writeQueue.then(operation, operation)
  writeQueue = result.then(
    () => undefined,
    () => undefined
  )
  return result
}

async function writeDraft(draft: AdrDraft): Promise<{ path: string }> {
  const config = requireConfig()
  // Whole-file PUT overwrites in the plugin, so write to an unguessable
  // temporary note and use MOVE with Allow-Overwrite:false as the commit step.
  // The plugin keeps the source in place when a destination already exists,
  // which lets us retry suffixes without ever issuing DELETE.
  const temporaryPath = `${draft.folder}/Morz temporary ADR ${randomBytes(16).toString('hex')}.md`
  const temporaryUrl = vaultUrl(config.baseUrl, temporaryPath)
  const staged = await authorizedFetch(config, temporaryUrl, {
    method: 'PUT',
    headers: { 'Content-Type': 'text/markdown; charset=utf-8' },
    body: draft.preview
  })
  if (!staged.ok) throw new Error(`Obsidian could not stage the ADR (${staged.status}).`)
  await staged.body?.cancel()

  for (let suffix = 1; suffix <= 1_000; suffix += 1) {
    const filename = `${draft.title}${suffix === 1 ? '' : `-${suffix}`}.md`
    const path = `${draft.folder}/${filename}`
    const moved = await authorizedFetch(config, temporaryUrl, {
      method: 'MOVE',
      headers: {
        Destination: encodeURI(path),
        'Allow-Overwrite': 'false'
      }
    })
    if (moved.status === 409 || moved.status === 412) {
      await moved.body?.cancel()
      continue
    }
    if (!moved.ok) throw new Error(`Obsidian could not finalize the ADR (${moved.status}).`)
    await moved.body?.cancel()
    return { path }
  }
  throw new Error('Could not find an unused ADR filename.')
}

export function writeAdr(draftId: string): Promise<{ path: string }> {
  if (!/^[a-f0-9]{64}$/.test(draftId)) throw new Error('The ADR preview is invalid or expired.')
  const draft = drafts.get(draftId)
  if (!draft || draft.expiresAt <= Date.now()) {
    if (draft) drafts.delete(draftId)
    throw new Error('The ADR preview is expired or already used.')
  }
  drafts.delete(draftId)
  return enqueueWrite(() => writeDraft(draft))
}

export function registerObsidianIpc(ipcMain: IpcMain): void {
  ipcMain.handle(ObsidianApi.status, () => getObsidianStatus())
  ipcMain.handle(ObsidianApi.connect, (_event, baseUrl: string, apiKey: string) => connect(baseUrl, apiKey))
  ipcMain.handle(ObsidianApi.readNote, (_event, path: string) => readNote(path))
  ipcMain.handle(ObsidianApi.searchNotes, (_event, query: string) => searchNotes(query))
  ipcMain.handle(
    ObsidianApi.prepareAdr,
    (_event, folder: string, title: string, body: ObsidianMadrBody) => prepareAdr(folder, title, body)
  )
  ipcMain.handle(
    ObsidianApi.writeAdr,
    (_event, draftId: string) => writeAdr(draftId)
  )
}
