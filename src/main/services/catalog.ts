import Database from 'better-sqlite3'
import { app, BrowserWindow, ipcMain } from 'electron'
import { mkdirSync } from 'fs'
import { join } from 'path'
import {
  CatalogApi,
  type CatalogInstallSpec,
  type CatalogItem,
  type CatalogQuery,
  type CatalogSnapshot
} from '../../shared/ipc'

const REGISTRY_URL = 'https://registry.modelcontextprotocol.io/v0/servers'
const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models'
const OPENROUTER_BENCHMARKS_URL = 'https://openrouter.ai/api/v1/benchmarks'
const FETCH_TIMEOUT_MS = 15_000
const REGISTRY_FETCH_TIMEOUT_MS = 45_000
const GITHUB_CACHE_MS = 24 * 60 * 60 * 1_000
const MAX_REGISTRY_PAGES = 200
const MAX_GITHUB_FETCHES = 12

type JsonRecord = Record<string, unknown>

interface SourceRow {
  source: string
  updated_since: string | null
  page_cursor: string | null
  scan_newest: string | null
  last_sync_at: number | null
  last_attempt_at: number | null
  last_error: string | null
  backoff_until: number | null
}

interface CatalogRow {
  id: string
  kind: CatalogItem['kind']
  name: string
  description: string
  source: string
  source_url: string | null
  stars: number | null
  official: number
  recommended: number
  install_spec: string | null
  benchmark_score: number | null
  benchmark_label: string | null
  context_length: number | null
  updated_at: string
}

let catalogDb: Database.Database | null = null
let syncPromise: Promise<CatalogSnapshot> | null = null
let registryBackgroundPromise: Promise<void> | null = null
let ipcRegistered = false

function asRecord(value: unknown): JsonRecord | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonRecord)
    : null
}

function cleanString(value: unknown, max = 2_000): string | null {
  if (typeof value !== 'string') return null
  const cleaned = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim()
  return cleaned ? cleaned.slice(0, max) : null
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function safeJson(value: unknown): string {
  return JSON.stringify(value)
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return cleanString(message, 300) ?? 'Catalog sync failed'
}

function openCatalogDb(): Database.Database {
  if (catalogDb) return catalogDb
  const dir = join(app.getPath('appData'), 'Morz')
  mkdirSync(dir, { recursive: true })
  catalogDb = new Database(join(dir, 'morz.db'))
  catalogDb.pragma('journal_mode = WAL')
  catalogDb.exec(`
    CREATE TABLE IF NOT EXISTS catalog_items (
      id              TEXT PRIMARY KEY,
      kind            TEXT NOT NULL CHECK (kind IN ('skill', 'mcp', 'plugin', 'model')),
      name            TEXT NOT NULL,
      description     TEXT NOT NULL,
      source          TEXT NOT NULL,
      source_url      TEXT,
      github_repo     TEXT,
      stars           INTEGER,
      official        INTEGER NOT NULL DEFAULT 0,
      recommended     INTEGER NOT NULL DEFAULT 0,
      install_spec    TEXT,
      benchmark_score REAL,
      benchmark_label TEXT,
      context_length  INTEGER,
      updated_at      TEXT NOT NULL,
      synced_at       INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS catalog_items_kind_idx
      ON catalog_items (kind, recommended, stars DESC, name);
    CREATE INDEX IF NOT EXISTS catalog_items_github_idx
      ON catalog_items (github_repo) WHERE github_repo IS NOT NULL;

    CREATE TABLE IF NOT EXISTS catalog_sources (
      source          TEXT PRIMARY KEY,
      updated_since   TEXT,
      page_cursor     TEXT,
      scan_newest     TEXT,
      last_sync_at    INTEGER,
      last_attempt_at INTEGER,
      last_error      TEXT,
      backoff_until   INTEGER
    );

    CREATE TABLE IF NOT EXISTS catalog_github_cache (
      repo          TEXT PRIMARY KEY,
      stars         INTEGER,
      fetched_at    INTEGER NOT NULL,
      backoff_until INTEGER
    );
  `)
  const sourceColumns = new Set(
    (catalogDb.prepare('PRAGMA table_info(catalog_sources)').all() as { name: string }[]).map(
      (column) => column.name
    )
  )
  if (!sourceColumns.has('page_cursor')) {
    catalogDb.exec('ALTER TABLE catalog_sources ADD COLUMN page_cursor TEXT')
  }
  if (!sourceColumns.has('scan_newest')) {
    catalogDb.exec('ALTER TABLE catalog_sources ADD COLUMN scan_newest TEXT')
  }
  return catalogDb
}

function sourceRow(source: string): SourceRow | undefined {
  return openCatalogDb()
    .prepare('SELECT * FROM catalog_sources WHERE source = ?')
    .get(source) as SourceRow | undefined
}

function markSourceAttempt(source: string): void {
  openCatalogDb()
    .prepare(
      `INSERT INTO catalog_sources (source, last_attempt_at)
       VALUES (?, ?)
       ON CONFLICT(source) DO UPDATE SET last_attempt_at = excluded.last_attempt_at`
    )
    .run(source, Date.now())
}

function markSourceSuccess(source: string, updatedSince?: string | null): void {
  openCatalogDb()
    .prepare(
      `INSERT INTO catalog_sources (
         source, updated_since, page_cursor, scan_newest,
         last_sync_at, last_attempt_at, last_error, backoff_until
       )
       VALUES (?, ?, NULL, NULL, ?, ?, NULL, NULL)
       ON CONFLICT(source) DO UPDATE SET
         updated_since = COALESCE(excluded.updated_since, catalog_sources.updated_since),
         page_cursor = NULL,
         scan_newest = NULL,
         last_sync_at = excluded.last_sync_at,
         last_attempt_at = excluded.last_attempt_at,
         last_error = NULL,
         backoff_until = NULL`
    )
    .run(source, updatedSince ?? null, Date.now(), Date.now())
}

function markSourceProgress(source: string, cursor: string, newest: string | null): void {
  openCatalogDb()
    .prepare(
      `INSERT INTO catalog_sources (source, page_cursor, scan_newest, last_attempt_at, last_error)
       VALUES (?, ?, ?, ?, NULL)
       ON CONFLICT(source) DO UPDATE SET
         page_cursor = excluded.page_cursor,
         scan_newest = COALESCE(excluded.scan_newest, catalog_sources.scan_newest),
         last_attempt_at = excluded.last_attempt_at,
         last_error = NULL`
    )
    .run(source, cursor, newest, Date.now())
}

function markSourceError(source: string, error: unknown, backoffUntil?: number): void {
  openCatalogDb()
    .prepare(
      `INSERT INTO catalog_sources (source, last_attempt_at, last_error, backoff_until)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(source) DO UPDATE SET
         last_attempt_at = excluded.last_attempt_at,
         last_error = excluded.last_error,
         backoff_until = COALESCE(excluded.backoff_until, catalog_sources.backoff_until)`
    )
    .run(source, Date.now(), errorMessage(error), backoffUntil ?? null)
}

async function fetchJson(
  url: URL | string,
  init?: RequestInit,
  timeoutMs = FETCH_TIMEOUT_MS
): Promise<{ data: unknown; response: Response }> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, {
      ...init,
      redirect: 'error',
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        'User-Agent': 'Morz/0.0.2 catalog-sync',
        ...init?.headers
      }
    })
    if (!response.ok) throw new Error(`HTTP ${response.status} from ${new URL(response.url).hostname}`)
    return { data: (await response.json()) as unknown, response }
  } finally {
    clearTimeout(timer)
  }
}

function githubRepo(repository: unknown): string | null {
  const urlValue = cleanString(asRecord(repository)?.url, 500)
  if (!urlValue) return null
  try {
    const url = new URL(urlValue)
    if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== 'github.com') return null
    const parts = url.pathname.replace(/^\/+|\/+$/g, '').split('/')
    if (parts.length < 2) return null
    const owner = parts[0]
    const repo = parts[1].replace(/\.git$/i, '')
    if (!/^[A-Za-z0-9_.-]{1,100}$/.test(owner) || !/^[A-Za-z0-9_.-]{1,100}$/.test(repo)) return null
    return `${owner}/${repo}`
  } catch {
    return null
  }
}

function inputValue(input: JsonRecord): string | null {
  if (input.isSecret === true) return null
  return cleanString(input.value, 4_000) ?? cleanString(input.default, 4_000)
}

function argumentParts(value: unknown): string[] {
  const arg = asRecord(value)
  if (!arg) return []
  const type = cleanString(arg.type, 30)
  const name = cleanString(arg.name, 200)
  const resolved = inputValue(arg)
  const hint = cleanString(arg.valueHint, 100)
  const placeholder = resolved ?? (hint ? `{${hint}}` : null)

  if (type === 'named' && name) {
    if (!placeholder) return arg.isRequired === true ? [name, `{${name.replace(/^-+/, '')}}`] : []
    if (name.endsWith('=')) return [`${name}${placeholder}`]
    if (arg.format === 'boolean' && placeholder === 'true') return [name]
    return [name, placeholder]
  }
  if (type === 'positional' && placeholder) return [placeholder]
  return []
}

function environmentMap(value: unknown): Record<string, string> {
  if (!Array.isArray(value)) return {}
  const env: Record<string, string> = Object.create(null) as Record<string, string>
  for (const raw of value.slice(0, 100)) {
    const item = asRecord(raw)
    const name = cleanString(item?.name, 200)
    if (!item || !name || !/^[A-Za-z_][A-Za-z0-9_]{0,199}$/.test(name)) continue
    env[name] = inputValue(item) ?? ''
  }
  return env
}

function headerMap(value: unknown): Record<string, string> {
  if (!Array.isArray(value)) return {}
  const headers: Record<string, string> = Object.create(null) as Record<string, string>
  for (const raw of value.slice(0, 100)) {
    const item = asRecord(raw)
    const name = cleanString(item?.name, 200)
    if (!item || !name || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,200}$/.test(name)) continue
    headers[name] = inputValue(item) ?? ''
  }
  return headers
}

function safeHttpsUrl(value: unknown, preserveTemplate = false): string | null {
  const raw = cleanString(value, 2_000)
  if (!raw) return null
  try {
    const url = new URL(raw)
    if (url.protocol !== 'https:' || !url.hostname || url.username || url.password) return null
    return preserveTemplate ? raw : url.toString()
  } catch {
    return null
  }
}

function installSpec(server: JsonRecord): CatalogInstallSpec | null {
  const serverName = cleanString(server.name, 300)
  if (!serverName) return null
  const packages = Array.isArray(server.packages) ? server.packages : []
  const packageRecords = packages
    .map(asRecord)
    .filter((value): value is JsonRecord => value !== null)
    .filter((value) => asRecord(value.transport)?.type === 'stdio')

  for (const packageRecord of packageRecords) {
    const registryType = cleanString(packageRecord.registryType, 30)?.toLowerCase()
    const identifier = cleanString(packageRecord.identifier, 500)
    const version = cleanString(packageRecord.version, 100)
    const requestedRuntime = cleanString(packageRecord.runtimeHint, 30)?.toLowerCase()
    const defaults: Record<string, string> = {
      npm: 'npx',
      pypi: 'uvx',
      oci: 'docker',
      nuget: 'dnx'
    }
    const allowedRuntimes = new Set(['npx', 'uvx', 'docker', 'dnx'])
    const command = requestedRuntime && allowedRuntimes.has(requestedRuntime)
      ? requestedRuntime
      : registryType
        ? defaults[registryType]
        : undefined
    if (command && identifier) {
      const runtimeArgs = Array.isArray(packageRecord.runtimeArguments)
        ? packageRecord.runtimeArguments.flatMap(argumentParts)
        : []
      const packageArgs = Array.isArray(packageRecord.packageArguments)
        ? packageRecord.packageArguments.flatMap(argumentParts)
        : []
      let packageId = identifier
      if (version && registryType === 'npm' && !identifier.includes('@', 1)) packageId = `${identifier}@${version}`
      else if (version && registryType === 'pypi') packageId = `${identifier}==${version}`
      else if (version && registryType === 'oci' && !identifier.includes('@') && !identifier.includes(':')) packageId = `${identifier}:${version}`
      const args = [...runtimeArgs]
      if (command === 'npx' && !args.includes('-y') && !args.includes('--yes')) args.push('-y')
      args.push(packageId, ...packageArgs)
      return {
        name: serverName,
        command,
        args: args.slice(0, 200),
        env: environmentMap(packageRecord.environmentVariables),
        transport: 'stdio'
      }
    }
  }

  const remotes = Array.isArray(server.remotes) ? server.remotes : []
  for (const raw of remotes) {
    const remote = asRecord(raw)
    const type = cleanString(remote?.type, 40)
    const url = safeHttpsUrl(remote?.url, true)
    if (!remote || !url || (type !== 'sse' && type !== 'streamable-http')) continue
    return {
      name: serverName,
      args: [],
      env: {},
      url,
      transport: type,
      headers: headerMap(remote.headers)
    }
  }
  return null
}

function registryTimestamp(value: unknown): string | null {
  const raw = cleanString(value, 100)
  if (!raw || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(raw)) {
    return null
  }
  const instant = Date.parse(raw)
  return Number.isFinite(instant) ? new Date(instant).toISOString() : null
}

function registryItem(raw: unknown): {
  item: CatalogItem
  github: string | null
  status: string
  isLatest: boolean
} | null {
  const wrapper = asRecord(raw)
  const server = asRecord(wrapper?.server)
  const official = asRecord(asRecord(wrapper?._meta)?.['io.modelcontextprotocol.registry/official'])
  const canonicalName = cleanString(server?.name, 300)
  if (!server || !canonicalName || !official) return null
  const repo = githubRepo(server.repository)
  const updatedAt = registryTimestamp(official.updatedAt)
  if (!updatedAt) throw new Error(`Registry server ${canonicalName} has an invalid updatedAt timestamp`)
  return {
    item: {
      id: `mcp:${canonicalName}`,
      kind: 'mcp',
      name: cleanString(server.title, 300) ?? canonicalName.split('/').pop() ?? canonicalName,
      description: cleanString(server.description, 2_000) ?? 'Official MCP Registry server.',
      source: repo ?? 'Official MCP Registry',
      sourceUrl: repo ? `https://github.com/${repo}` : safeHttpsUrl(server.websiteUrl),
      stars: null,
      official: true,
      recommended: false,
      installSpec: installSpec(server),
      updatedAt
    },
    github: repo,
    status: cleanString(official.status, 30) ?? 'active',
    isLatest: official.isLatest !== false
  }
}

function upsertRegistryPage(rows: unknown[]): string | null {
  const db = openCatalogDb()
  const upsert = db.prepare(
    `INSERT INTO catalog_items (
       id, kind, name, description, source, source_url, github_repo, stars,
       official, recommended, install_spec, updated_at, synced_at
     ) VALUES (?, 'mcp', ?, ?, ?, ?, ?,
       (SELECT stars FROM catalog_github_cache WHERE repo = ?), 1, 0, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name,
       description = excluded.description,
       source = excluded.source,
       source_url = excluded.source_url,
       github_repo = excluded.github_repo,
       stars = COALESCE(excluded.stars, catalog_items.stars),
       official = 1,
       install_spec = excluded.install_spec,
       updated_at = excluded.updated_at,
       synced_at = excluded.synced_at`
  )
  const remove = db.prepare('DELETE FROM catalog_items WHERE id = ? AND kind = \'mcp\'')
  let newest: string | null = null
  db.transaction(() => {
    for (const raw of rows) {
      const parsed = registryItem(raw)
      if (!parsed) continue
      if (!newest || parsed.item.updatedAt > newest) newest = parsed.item.updatedAt
      if (parsed.status !== 'active') {
        remove.run(parsed.item.id)
        continue
      }
      if (!parsed.isLatest) continue
      upsert.run(
        parsed.item.id,
        parsed.item.name,
        parsed.item.description,
        parsed.item.source,
        parsed.item.sourceUrl,
        parsed.github,
        parsed.github,
        parsed.item.installSpec ? safeJson(parsed.item.installSpec) : null,
        parsed.item.updatedAt,
        Date.now()
      )
    }
  })()
  return newest
}

function registryPageUrl(updatedSince: string | null, cursor: string | null): URL {
  const url = new URL(REGISTRY_URL)
  url.searchParams.set('limit', '100')
  if (updatedSince) url.searchParams.set('updated_since', updatedSince)
  if (cursor) url.searchParams.set('cursor', cursor)
  return url
}

async function readRegistryPage(
  updatedSince: string | null,
  cursor: string | null
): Promise<{ next: string | null; newest: string | null }> {
  const { data } = await fetchJson(
    registryPageUrl(updatedSince, cursor),
    undefined,
    REGISTRY_FETCH_TIMEOUT_MS
  )
  const payload = asRecord(data)
  if (!payload || !Array.isArray(payload.servers)) throw new Error('Registry returned an invalid page')
  return {
    newest: upsertRegistryPage(payload.servers),
    next: cleanString(asRecord(payload.metadata)?.nextCursor, 500)
  }
}

async function continueRegistrySync(
  updatedSince: string | null,
  firstCursor: string,
  firstNewest: string | null
): Promise<void> {
  const source = 'mcp-registry'
  let cursor: string | null = firstCursor
  let newest = firstNewest ?? updatedSince
  const seenCursors = new Set<string>()
  try {
    for (let page = 1; page < MAX_REGISTRY_PAGES && cursor; page++) {
      if (seenCursors.has(cursor)) throw new Error('Registry pagination repeated a cursor')
      seenCursors.add(cursor)
      const result = await readRegistryPage(updatedSince, cursor)
      if (result.newest && (!newest || result.newest > newest)) newest = result.newest
      cursor = result.next
      if (cursor) markSourceProgress(source, cursor, newest)
      if (page === MAX_REGISTRY_PAGES - 1 && cursor) {
        throw new Error('Registry pagination exceeded safety limit')
      }
    }
    markSourceSuccess(source, newest)
  } catch (error) {
    markSourceError(source, error)
    console.error('[morz] registry background sync failed:', errorMessage(error))
  }
}

async function syncRegistry(): Promise<void> {
  if (registryBackgroundPromise) return
  const source = 'mcp-registry'
  const state = sourceRow(source)
  const prior = state?.updated_since ?? null
  const resumeCursor = state?.page_cursor ?? null
  markSourceAttempt(source)
  try {
    const first = await readRegistryPage(prior, resumeCursor)
    const firstNewest =
      first.newest && state?.scan_newest
        ? first.newest > state.scan_newest
          ? first.newest
          : state.scan_newest
        : first.newest ?? state?.scan_newest ?? prior
    if (!first.next) {
      markSourceSuccess(source, firstNewest)
      return
    }
    markSourceProgress(source, first.next, firstNewest)
    registryBackgroundPromise = continueRegistrySync(prior, first.next, firstNewest)
      .then(() => enrichGithubStars())
      .finally(() => {
        registryBackgroundPromise = null
        for (const window of BrowserWindow.getAllWindows()) {
          if (!window.isDestroyed()) window.webContents.send(CatalogApi.updated)
        }
      })
  } catch (error) {
    markSourceError(source, error)
    throw error
  }
}

function benchmarkDetails(model: JsonRecord): { score: number | null; label: string | null } {
  const analysis = asRecord(asRecord(model.benchmarks)?.artificial_analysis)
  if (!analysis) return { score: null, label: null }
  const coding = finiteNumber(analysis.coding_index)
  const agentic = finiteNumber(analysis.agentic_index)
  const intelligence = finiteNumber(analysis.intelligence_index)
  const values = [coding, agentic, intelligence].filter((value): value is number => value !== null)
  const score = values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null
  const parts: string[] = []
  if (coding !== null) parts.push(`Coding ${coding.toFixed(1)}`)
  if (agentic !== null) parts.push(`Agentic ${agentic.toFixed(1)}`)
  if (intelligence !== null) parts.push(`Intelligence ${intelligence.toFixed(1)}`)
  return { score, label: parts.length ? parts.join(' · ') : null }
}

function externalBenchmarkMap(data: unknown): Map<string, { score: number; label: string }> {
  const payload = asRecord(data)
  const rows = Array.isArray(payload?.data) ? payload.data : Array.isArray(data) ? data : []
  const result = new Map<string, { score: number; label: string }>()
  for (const raw of rows) {
    const row = asRecord(raw)
    const id = cleanString(row?.model_permaslug, 300)
      ?? cleanString(row?.id, 300)
      ?? cleanString(row?.model_id, 300)
      ?? cleanString(row?.model, 300)
    const coding = finiteNumber(row?.coding_index)
    const agentic = finiteNumber(row?.agentic_index)
    const intelligence = finiteNumber(row?.intelligence_index)
    const indices = [coding, agentic, intelligence].filter((value): value is number => value !== null)
    const score = indices.length
      ? indices.reduce((sum, value) => sum + value, 0) / indices.length
      : finiteNumber(row?.score) ?? finiteNumber(row?.value)
    const labels: string[] = []
    if (coding !== null) labels.push(`Coding ${coding.toFixed(1)}`)
    if (agentic !== null) labels.push(`Agentic ${agentic.toFixed(1)}`)
    if (intelligence !== null) labels.push(`Intelligence ${intelligence.toFixed(1)}`)
    if (id && score !== null) {
      result.set(id, { score, label: labels.length ? labels.join(' · ') : `Benchmark ${score.toFixed(1)}` })
    }
  }
  return result
}

async function optionalBenchmarks(): Promise<Map<string, { score: number; label: string }>> {
  try {
    const apiKey = cleanString(process.env.OPENROUTER_API_KEY, 2_000)
    const { data } = await fetchJson(OPENROUTER_BENCHMARKS_URL, apiKey
      ? { headers: { Authorization: `Bearer ${apiKey}` } }
      : undefined)
    return externalBenchmarkMap(data)
  } catch {
    return new Map()
  }
}

async function syncModels(): Promise<void> {
  const source = 'openrouter'
  markSourceAttempt(source)
  try {
    const [{ data }, extraBenchmarks] = await Promise.all([
      fetchJson(OPENROUTER_MODELS_URL),
      optionalBenchmarks()
    ])
    const models = asRecord(data)?.data
    if (!Array.isArray(models)) throw new Error('OpenRouter returned an invalid model list')
    if (models.length === 0) throw new Error('OpenRouter returned an empty model list')
    const db = openCatalogDb()
    const insert = db.prepare(
      `INSERT INTO catalog_items (
         id, kind, name, description, source, source_url, stars, official,
         recommended, install_spec, benchmark_score, benchmark_label,
         context_length, updated_at, synced_at
       ) VALUES (?, 'model', ?, ?, ?, ?, NULL, 0, 0, NULL, ?, ?, ?, ?, ?)`
    )
    db.transaction(() => {
      db.prepare("DELETE FROM catalog_items WHERE kind = 'model'").run()
      for (const raw of models) {
        const model = asRecord(raw)
        const modelId = cleanString(model?.id, 300)
        if (!model || !modelId) continue
        const embedded = benchmarkDetails(model)
        const extra = extraBenchmarks.get(modelId)
        const created = finiteNumber(model.created)
        const updatedAt = created ? new Date(created * 1_000).toISOString() : new Date().toISOString()
        const vendor = modelId.split('/')[0]
        insert.run(
          `model:${modelId}`,
          cleanString(model.name, 300) ?? modelId,
          cleanString(model.description, 2_000) ?? 'Model available through OpenRouter.',
          `OpenRouter · ${vendor}`,
          `https://openrouter.ai/${modelId.split('/').map(encodeURIComponent).join('/')}`,
          embedded.score ?? extra?.score ?? null,
          embedded.label ?? extra?.label ?? null,
          finiteNumber(model.context_length),
          updatedAt,
          Date.now()
        )
      }
    })()
    markSourceSuccess(source)
  } catch (error) {
    markSourceError(source, error)
    throw error
  }
}

function githubBackoffFrom(response: Response): number {
  const resetSeconds = Number(response.headers.get('x-ratelimit-reset'))
  if (Number.isFinite(resetSeconds) && resetSeconds > 0) return resetSeconds * 1_000
  const retrySeconds = Number(response.headers.get('retry-after'))
  return Date.now() + (Number.isFinite(retrySeconds) && retrySeconds > 0 ? retrySeconds * 1_000 : 60 * 60 * 1_000)
}

async function fetchGithubStars(repo: string): Promise<number | null> {
  const db = openCatalogDb()
  const cached = db
    .prepare('SELECT stars, fetched_at, backoff_until FROM catalog_github_cache WHERE repo = ?')
    .get(repo) as { stars: number | null; fetched_at: number; backoff_until: number | null } | undefined
  if (cached && Date.now() - cached.fetched_at < GITHUB_CACHE_MS) return cached.stars
  if (cached?.backoff_until && cached.backoff_until > Date.now()) return cached.stars

  const [owner, name] = repo.split('/')
  const url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const response = await fetch(url, {
      redirect: 'error',
      signal: controller.signal,
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'Morz/0.0.2 catalog-sync',
        'X-GitHub-Api-Version': '2022-11-28'
      }
    })
    if (response.status === 403 || response.status === 429) {
      const backoffUntil = githubBackoffFrom(response)
      markSourceError('github', `GitHub rate limited (${response.status})`, backoffUntil)
      db.prepare(
        `INSERT INTO catalog_github_cache (repo, stars, fetched_at, backoff_until)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(repo) DO UPDATE SET fetched_at = excluded.fetched_at, backoff_until = excluded.backoff_until`
      ).run(repo, cached?.stars ?? null, Date.now(), backoffUntil)
      return cached?.stars ?? null
    }
    if (response.status === 404) {
      db.prepare(
        `INSERT INTO catalog_github_cache (repo, stars, fetched_at, backoff_until)
         VALUES (?, NULL, ?, NULL)
         ON CONFLICT(repo) DO UPDATE SET stars = NULL, fetched_at = excluded.fetched_at, backoff_until = NULL`
      ).run(repo, Date.now())
      return null
    }
    if (!response.ok) throw new Error(`GitHub HTTP ${response.status}`)
    const payload = asRecord((await response.json()) as unknown)
    const stars = finiteNumber(payload?.stargazers_count)
    db.prepare(
      `INSERT INTO catalog_github_cache (repo, stars, fetched_at, backoff_until)
       VALUES (?, ?, ?, NULL)
       ON CONFLICT(repo) DO UPDATE SET stars = excluded.stars, fetched_at = excluded.fetched_at, backoff_until = NULL`
    ).run(repo, stars, Date.now())
    const remaining = Number(response.headers.get('x-ratelimit-remaining'))
    if (remaining === 0) {
      markSourceError('github', 'GitHub rate limit exhausted', githubBackoffFrom(response))
    }
    return stars
  } finally {
    clearTimeout(timer)
  }
}

async function enrichGithubStars(): Promise<void> {
  const state = sourceRow('github')
  if (state?.backoff_until && state.backoff_until > Date.now()) return
  markSourceAttempt('github')
  const rows = openCatalogDb()
    .prepare(
      `SELECT i.github_repo AS repo
       FROM catalog_items i
       LEFT JOIN catalog_github_cache g ON g.repo = i.github_repo
       WHERE i.kind = 'mcp'
         AND i.github_repo IS NOT NULL
         AND (g.repo IS NULL OR g.fetched_at < ?)
       GROUP BY i.github_repo
       ORDER BY MAX(i.stars IS NULL) DESC, MAX(i.stars) DESC, MIN(i.name)
       LIMIT ?`
    )
    .all(Date.now() - GITHUB_CACHE_MS, MAX_GITHUB_FETCHES) as { repo: string }[]

  let failed = false
  for (const { repo } of rows) {
    const latestState = sourceRow('github')
    if (latestState?.backoff_until && latestState.backoff_until > Date.now()) {
      failed = true
      break
    }
    try {
      const stars = await fetchGithubStars(repo)
      openCatalogDb().prepare('UPDATE catalog_items SET stars = ? WHERE github_repo = ?').run(stars, repo)
      const updatedState = sourceRow('github')
      if (updatedState?.backoff_until && updatedState.backoff_until > Date.now()) {
        failed = true
        break
      }
    } catch (error) {
      markSourceError('github', error)
      failed = true
      break
    }
  }
  if (!failed) markSourceSuccess('github')

  const db = openCatalogDb()
  db.transaction(() => {
    db.prepare("UPDATE catalog_items SET recommended = 0 WHERE kind = 'mcp'").run()
    db.prepare(
      `UPDATE catalog_items SET recommended = 1
       WHERE id IN (
         SELECT id FROM catalog_items
         WHERE kind = 'mcp' AND install_spec IS NOT NULL
         ORDER BY COALESCE(stars, 0) DESC, official DESC, name
         LIMIT 24
       )`
    ).run()
  })()
}

function sanitizedQuery(value: CatalogQuery | undefined): Required<CatalogQuery> {
  const categories = new Set(['recommended', 'skills', 'mcp', 'plugins', 'models'])
  const category = categories.has(value?.category ?? '') ? value!.category! : 'recommended'
  const requestedLimit = finiteNumber(value?.limit)
  return {
    category,
    search: cleanString(value?.search, 200) ?? '',
    limit: Math.max(1, Math.min(500, Math.trunc(requestedLimit ?? 200)))
  }
}

function rowToItem(row: CatalogRow): CatalogItem {
  let parsedInstallSpec: CatalogInstallSpec | null = null
  if (row.install_spec) {
    try {
      parsedInstallSpec = JSON.parse(row.install_spec) as CatalogInstallSpec
    } catch {
      parsedInstallSpec = null
    }
  }
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    description: row.description,
    source: row.source,
    sourceUrl: row.source_url,
    stars: row.stars,
    official: row.official === 1,
    recommended: row.recommended === 1,
    installSpec: parsedInstallSpec,
    benchmarkScore: row.benchmark_score,
    benchmarkLabel: row.benchmark_label,
    contextLength: row.context_length,
    updatedAt: row.updated_at
  }
}

export function queryCatalog(query?: CatalogQuery): CatalogSnapshot {
  const normalized = sanitizedQuery(query)
  const clauses: string[] = []
  const params: Array<string | number> = []
  if (normalized.category === 'recommended') clauses.push('recommended = 1')
  else if (normalized.category === 'skills') clauses.push("kind = 'skill'")
  else if (normalized.category === 'mcp') clauses.push("kind = 'mcp'")
  else if (normalized.category === 'plugins') clauses.push("kind = 'plugin'")
  else clauses.push("kind = 'model'")
  if (normalized.search) {
    clauses.push("(name LIKE ? ESCAPE '\\' COLLATE NOCASE OR description LIKE ? ESCAPE '\\' COLLATE NOCASE OR source LIKE ? ESCAPE '\\' COLLATE NOCASE)")
    const pattern = `%${normalized.search.replace(/[\\%_]/g, '\\$&')}%`
    params.push(pattern, pattern, pattern)
  }
  params.push(normalized.limit)
  const rows = openCatalogDb()
    .prepare(
      `SELECT id, kind, name, description, source, source_url, stars, official,
              recommended, install_spec, benchmark_score, benchmark_label,
              context_length, updated_at
       FROM catalog_items
       WHERE ${clauses.join(' AND ')}
       ORDER BY
         CASE WHEN kind = 'model' THEN COALESCE(benchmark_score, -1) ELSE COALESCE(stars, -1) END DESC,
         official DESC,
         name COLLATE NOCASE
       LIMIT ?`
    )
    .all(...params) as CatalogRow[]

  const sources = openCatalogDb()
    .prepare("SELECT * FROM catalog_sources WHERE source IN ('mcp-registry', 'openrouter')")
    .all() as SourceRow[]
  const failures = sources.filter((source) => source.last_error)
  const lastSyncAt = sources.reduce<number | null>(
    (latest, source) => source.last_sync_at !== null && (latest === null || source.last_sync_at > latest) ? source.last_sync_at : latest,
    null
  )
  return {
    items: rows.map(rowToItem),
    lastSyncAt,
    offline: failures.length > 0,
    syncing: syncPromise !== null || registryBackgroundPromise !== null,
    error: failures.map((source) => `${source.source}: ${source.last_error}`).join(' · ') || null
  }
}

async function performRefresh(query?: CatalogQuery): Promise<CatalogSnapshot> {
  const outcomes = await Promise.allSettled([syncRegistry(), syncModels()])
  if (outcomes[0].status === 'fulfilled') await enrichGithubStars()
  return queryCatalog(query)
}

export function refreshCatalog(query?: CatalogQuery): Promise<CatalogSnapshot> {
  if (syncPromise) return syncPromise
  syncPromise = performRefresh(query).finally(() => {
    syncPromise = null
  })
  return syncPromise
}

export function registerCatalogIpc(): void {
  if (ipcRegistered) return
  ipcRegistered = true
  openCatalogDb()
  ipcMain.handle(CatalogApi.query, (_event, query?: CatalogQuery) => queryCatalog(query))
  ipcMain.handle(CatalogApi.refresh, (_event, query?: CatalogQuery) => refreshCatalog(query))
}
