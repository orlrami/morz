import { spawn, type ChildProcess } from 'node:child_process'
import { constants } from 'node:fs'
import { access, open, opendir, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { delimiter, extname, join } from 'node:path'
import { app, BrowserWindow, ipcMain } from 'electron'
import { parse as parseToml } from 'smol-toml'
import {
  ConnectionsApi,
  cliOfExecutable,
  type CliConnection,
  type CliId
} from '../../shared/connections'

const PROBE_TIMEOUT_MS = 5_000
const REFRESH_INTERVAL_MS = 60_000
const MAX_OUTPUT_BYTES = 256 * 1024
const MAX_CONFIG_BYTES = 1024 * 1024
const MAX_JSONL_TAIL_BYTES = 128 * 1024
const MAX_JSONL_CANDIDATES = 2_000
const MAX_RECENT_JSONL_FILES = 10
const JSONL_SCAN_BUDGET_MS = 1_500
const CLAUDE_WINDOW_MS = 5 * 60 * 60 * 1_000

const CLI_SPECS: ReadonlyArray<{ id: CliId; executable: string; label: string }> = [
  { id: 'claude', executable: 'claude', label: 'Claude Code' },
  { id: 'codex', executable: 'codex', label: 'Codex' },
  { id: 'agy', executable: 'agy', label: 'Antigravity' },
  { id: 'opencode', executable: 'opencode', label: 'OpenCode' }
]

interface CommandResult {
  ok: boolean
  output: string
}

interface ClaudeTelemetry {
  model: string | null
  usage: CliConnection['usage']
}

let registered = false
let cache: CliConnection[] | null = null
let probeInFlight: Promise<CliConnection[]> | null = null
let refreshTimer: NodeJS.Timeout | null = null

function connectionHome(): string {
  return homedir()
}

function cleanOutput(value: string): string {
  return value
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean)
    ?.slice(0, 160) ?? ''
}

function runFile(
  file: string,
  args: readonly string[],
  windowsVerbatimArguments = false
): Promise<CommandResult> {
  return new Promise((resolve) => {
    let child: ChildProcess
    try {
      child = spawn(file, [...args], {
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        windowsVerbatimArguments
      })
    } catch {
      resolve({ ok: false, output: '' })
      return
    }

    let output = ''
    let outputBytes = 0
    let settled = false
    const finish = (ok: boolean): void => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      resolve({ ok, output: cleanOutput(output) })
    }
    const terminate = (): void => {
      if (settled) return
      terminateProcessTree(child)
      finish(false)
    }
    const collect = (chunk: Buffer): void => {
      if (settled) return
      outputBytes += chunk.byteLength
      if (outputBytes > MAX_OUTPUT_BYTES) {
        terminate()
        return
      }
      output += chunk.toString('utf8')
    }
    const timeout = setTimeout(terminate, PROBE_TIMEOUT_MS)
    timeout.unref()
    child.stdout?.on('data', collect)
    child.stderr?.on('data', collect)
    child.once('error', () => finish(false))
    child.once('close', (code) => finish(code === 0))
  })
}

function terminateProcessTree(child: ChildProcess): void {
  if (!child.pid) return
  if (process.platform === 'win32') {
    const taskkill = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe')
    try {
      const killer = spawn(taskkill, ['/pid', String(child.pid), '/T', '/F'], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true
      })
      killer.once('error', () => child.kill('SIGKILL'))
      killer.once('close', (code) => {
        if (code !== 0) child.kill('SIGKILL')
      })
      killer.unref()
    } catch {
      child.kill('SIGKILL')
    }
    return
  }
  try {
    process.kill(-child.pid, 'SIGKILL')
  } catch {
    child.kill('SIGKILL')
  }
}

function safeCmdPath(file: string): boolean {
  // cmd expands these characters even inside some quoted contexts. A CLI shim
  // in such a path is treated as unprobeable rather than risking a reparse.
  return !/["&|<>^%!\r\n]/.test(file)
}

async function runCli(executable: string, args: readonly string[]): Promise<CommandResult> {
  const extension = extname(executable).toLowerCase()
  if (process.platform !== 'win32' || (extension !== '.cmd' && extension !== '.bat')) {
    return runFile(executable, args)
  }
  if (!safeCmdPath(executable) || args.some((arg) => !/^--?[a-z-]+$/i.test(arg))) {
    return { ok: false, output: '' }
  }
  const command = `call "${executable}" ${args.join(' ')}`
  const commandProcessor = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'cmd.exe')
  return runFile(commandProcessor, ['/d', '/s', '/c', command], true)
}

async function resolveExecutable(id: CliId, executable: string): Promise<string | null> {
  if (process.platform === 'win32') {
    const whereExe = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'where.exe')
    const result = await runFile(whereExe, [executable])
    if (!result.ok) return null
    // runFile intentionally returns only the first non-empty line.
    return cliOfExecutable(result.output) === id ? result.output : null
  }

  const pathValue = process.env.PATH ?? ''
  for (const dir of pathValue.split(delimiter)) {
    if (!dir) continue
    const candidate = join(dir, executable)
    try {
      await access(candidate, constants.X_OK)
      if (cliOfExecutable(candidate) === id) return candidate
    } catch {
      // Continue through PATH. A missing or non-executable entry is not fatal.
    }
  }
  return null
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

async function readSmallFile(path: string): Promise<string | null> {
  try {
    const info = await stat(path)
    if (!info.isFile() || info.size > MAX_CONFIG_BYTES) return null
    return await readFile(path, 'utf8')
  } catch {
    return null
  }
}

async function jsonPathField(
  paths: readonly string[],
  fieldPaths: ReadonlyArray<readonly string[]>
): Promise<string | null> {
  for (const path of paths) {
    const raw = await readSmallFile(path)
    if (!raw) continue
    try {
      const value = JSON.parse(raw) as unknown
      for (const fieldPath of fieldPaths) {
        let candidate = value
        for (const field of fieldPath) {
          if (!candidate || typeof candidate !== 'object') {
            candidate = null
            break
          }
          candidate = (candidate as Record<string, unknown>)[field]
        }
        if (typeof candidate === 'string' && candidate.trim()) {
          return candidate.trim().slice(0, 120)
        }
      }
    } catch {
      // Invalid or non-JSON auth/config files expose no safe metadata.
    }
  }
  return null
}

async function codexAuthPaths(home: string): Promise<string[]> {
  const root = join(home, '.codex')
  const candidates = [join(root, 'auth.json'), join(root, 'auth')]
  const result: string[] = []
  for (const candidate of candidates) if (await exists(candidate)) result.push(candidate)
  return result
}

function hasCredentialField(value: unknown, names: ReadonlySet<string>, depth = 0): boolean {
  if (!value || typeof value !== 'object' || depth > 6) return false
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const normalized = key.replace(/[-_]/g, '').toLowerCase()
    if (names.has(normalized) && typeof child === 'string' && child.trim().length > 0) return true
    if (hasCredentialField(child, names, depth + 1)) return true
  }
  return false
}

async function hasJsonCredential(path: string, names: ReadonlySet<string>): Promise<boolean | null> {
  const raw = await readSmallFile(path)
  if (!raw) return null
  try {
    return hasCredentialField(JSON.parse(raw) as unknown, names) ? true : null
  } catch {
    return null
  }
}

async function codexAuthStatus(home: string): Promise<boolean | null> {
  const paths = await codexAuthPaths(home)
  if (paths.length === 0) return false
  const credentialFields = new Set(['accesstoken', 'idtoken', 'refreshtoken', 'openaiapikey'])
  for (const path of paths) if (await hasJsonCredential(path, credentialFields)) return true
  return null
}

async function authStatus(id: CliId, executable: string, home: string): Promise<boolean | null> {
  if (id === 'claude') {
    if (
      process.env.ANTHROPIC_API_KEY?.trim() ||
      process.env.ANTHROPIC_AUTH_TOKEN?.trim() ||
      process.env.CLAUDE_CODE_OAUTH_TOKEN?.trim()
    ) {
      return null
    }
    if (!(await exists(join(home, '.claude')))) return false
    const help = await runCli(executable, ['--help'])
    if (!help.ok) return null
    return hasJsonCredential(
      join(home, '.claude', '.credentials.json'),
      new Set(['accesstoken', 'refreshtoken'])
    )
  }
  if (id === 'codex') {
    if (process.env.OPENAI_API_KEY?.trim()) return null
    return codexAuthStatus(home)
  }
  return null
}

async function planFor(id: CliId, home: string): Promise<string | null> {
  if (id === 'claude') {
    return jsonPathField(
      [
        join(home, '.claude.json'),
        join(home, '.claude', 'settings.json'),
        join(home, '.claude', '.credentials.json')
      ],
      [
        ['oauthAccount', 'subscriptionType'],
        ['oauthAccount', 'billingType'],
        ['claudeAiOauth', 'subscriptionType'],
        ['subscriptionType']
      ]
    )
  }
  return null
}

async function configuredModel(id: CliId, home: string): Promise<string | null> {
  if (id === 'claude') {
    return jsonPathField([join(home, '.claude', 'settings.json')], [['model']])
  }
  if (id === 'codex') {
    const raw = await readSmallFile(join(home, '.codex', 'config.toml'))
    if (!raw) return null
    try {
      const model = parseToml(raw).model
      return typeof model === 'string' ? model.trim().slice(0, 120) || null : null
    } catch {
      return null
    }
  }
  return null
}

function asResetTime(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const millis = value < 10_000_000_000 ? value * 1_000 : value
    const date = new Date(millis)
    return Number.isNaN(date.getTime()) ? null : date.toISOString()
  }
  if (typeof value !== 'string' || value.length > 100) return null
  const millis = Date.parse(value)
  return Number.isNaN(millis) ? null : new Date(millis).toISOString()
}

function hasTelemetryType(value: unknown, expected: string, depth = 0): boolean {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  for (const key of ['type', 'subtype', 'event_type', 'eventType']) {
    const candidate = record[key]
    if (
      typeof candidate === 'string' &&
      candidate.replace(/[-_]/g, '').toLowerCase() === expected
    ) return true
  }
  const event = record.event
  return depth === 0 && event && typeof event === 'object'
    ? hasTelemetryType(event, expected, depth + 1)
    : false
}

function rateLimitUsageEvent(
  value: unknown
): { timestamp: number; usage: NonNullable<CliConnection['usage']> } | null {
  if (!hasTelemetryType(value, 'ratelimitevent')) return null
  const record = value as Record<string, unknown>
  const info = record.rate_limit_info ?? record.rateLimitInfo
  if (!info || typeof info !== 'object') return null
  const fields = info as Record<string, unknown>
  const rawPercentage = fields.used_pct ?? fields.usedPct ?? fields.utilization
  let usedPct: number | null = null
  if (typeof rawPercentage === 'number' && Number.isFinite(rawPercentage)) {
    const percentage = fields.utilization === rawPercentage && rawPercentage >= 0 && rawPercentage <= 1
      ? rawPercentage * 100
      : rawPercentage
    if (percentage >= 0 && percentage <= 100) usedPct = Math.round(percentage * 10) / 10
  }
  const resetsAt = asResetTime(fields.resets_at ?? fields.resetsAt ?? fields.reset_at ?? fields.resetAt)
  const timestamp = telemetryTimestamp(value)
  if (timestamp === null || (usedPct === null && resetsAt === null)) return null
  return { timestamp, usage: { usedPct, resetsAt } }
}

function modelFromTelemetry(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  const type = typeof record.type === 'string' ? record.type : ''
  if (!/^(assistant|system)$/i.test(type)) return null
  if (typeof record.model === 'string') return record.model.trim().slice(0, 120) || null
  const message = record.message
  if (!message || typeof message !== 'object') return null
  const model = (message as Record<string, unknown>).model
  return typeof model === 'string' ? model.trim().slice(0, 120) || null : null
}

function telemetryTimestamp(value: unknown): number | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  for (const key of ['timestamp', 'created_at', 'createdAt']) {
    const candidate = record[key]
    if (typeof candidate === 'number' && Number.isFinite(candidate)) {
      return candidate < 10_000_000_000 ? candidate * 1_000 : candidate
    }
    if (typeof candidate === 'string') {
      const parsed = Date.parse(candidate)
      if (!Number.isNaN(parsed)) return parsed
    }
  }
  return null
}

async function readTail(path: string): Promise<string | null> {
  let handle: Awaited<ReturnType<typeof open>> | null = null
  try {
    handle = await open(path, 'r')
    const info = await handle.stat()
    const length = Math.min(info.size, MAX_JSONL_TAIL_BYTES)
    const start = Math.max(0, info.size - length)
    const buffer = Buffer.alloc(length)
    await handle.read(buffer, 0, length, start)
    const raw = buffer.toString('utf8')
    if (start === 0) return raw
    const firstNewline = raw.indexOf('\n')
    return firstNewline === -1 ? null : raw.slice(firstNewline + 1)
  } catch {
    return null
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

async function recentClaudeJsonl(home: string): Promise<Array<{ path: string; mtimeMs: number }>> {
  const root = join(home, '.claude', 'projects')
  const threshold = Date.now() - CLAUDE_WINDOW_MS
  const deadline = Date.now() + JSONL_SCAN_BUDGET_MS
  const files: Array<{ path: string; mtimeMs: number }> = []
  let inspected = 0
  let projectCount = 0
  let truncated = false
  try {
    const projects = await opendir(root)
    projectLoop: for await (const project of projects) {
      if (Date.now() >= deadline) {
        truncated = true
        break
      }
      if (!project.isDirectory()) continue
      projectCount += 1
      if (projectCount > 300) {
        truncated = true
        break
      }
      const projectRoot = join(root, project.name)
      let directory
      try {
        directory = await opendir(projectRoot)
      } catch {
        continue
      }
      for await (const entry of directory) {
        inspected += 1
        if (inspected > MAX_JSONL_CANDIDATES || Date.now() >= deadline) {
          truncated = true
          break projectLoop
        }
        if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.jsonl')) continue
        const path = join(projectRoot, entry.name)
        try {
          const info = await stat(path)
          if (info.mtimeMs >= threshold) files.push({ path, mtimeMs: info.mtimeMs })
        } catch {
          // The transcript may have rotated between directory iteration and stat.
        }
      }
    }
  } catch {
    return []
  }
  if (truncated || files.length > MAX_RECENT_JSONL_FILES) return []
  return files
    .sort((left, right) => right.mtimeMs - left.mtimeMs)
}

async function claudeTelemetry(home: string): Promise<ClaudeTelemetry> {
  let model: string | null = null
  let usage: CliConnection['usage'] = null
  let usageTimestamp = -Infinity
  const now = Date.now()
  const threshold = now - CLAUDE_WINDOW_MS
  const futureThreshold = now + 5 * 60 * 1_000
  const files = (await recentClaudeJsonl(home)).reverse()
  for (const file of files) {
    const raw = await readTail(file.path)
    if (!raw) continue
    for (const line of raw.split(/\r?\n/)) {
      if (!line || !/("model"|used[_-]?pct|utilization|resets?[_-]?at|usage[_-]?percentage)/i.test(line)) {
        continue
      }
      try {
        const value = JSON.parse(line) as unknown
        const timestamp = telemetryTimestamp(value)
        if (timestamp !== null && (timestamp < threshold || timestamp > futureThreshold)) continue
        const foundModel = modelFromTelemetry(value)
        if (foundModel) model = foundModel
        const foundUsage = rateLimitUsageEvent(value)
        if (foundUsage && foundUsage.timestamp > usageTimestamp) {
          usage = foundUsage.usage
          usageTimestamp = foundUsage.timestamp
        }
      } catch {
        // A malformed JSONL line does not invalidate other local telemetry.
      }
    }
  }
  if (usage?.resetsAt && Date.parse(usage.resetsAt) <= Date.now()) usage = null
  return { model, usage }
}

async function detectConnection(spec: (typeof CLI_SPECS)[number]): Promise<CliConnection> {
  const executable = await resolveExecutable(spec.id, spec.executable)
  if (!executable) {
    return {
      id: spec.id,
      label: spec.label,
      installed: false,
      version: null,
      authed: null,
      plan: null,
      model: null,
      usage: null
    }
  }

  const home = connectionHome()
  const [versionProbe, authed, plan, configured, telemetry] = await Promise.all([
    runCli(executable, ['--version']),
    authStatus(spec.id, executable, home),
    planFor(spec.id, home),
    configuredModel(spec.id, home),
    spec.id === 'claude' ? claudeTelemetry(home) : Promise.resolve<ClaudeTelemetry>({ model: null, usage: null })
  ])
  return {
    id: spec.id,
    label: spec.label,
    installed: true,
    version: versionProbe.ok ? versionProbe.output || null : null,
    authed,
    plan,
    model: configured ?? telemetry.model,
    usage: spec.id === 'claude' ? telemetry.usage : null
  }
}

async function detectAll(): Promise<CliConnection[]> {
  return Promise.all(CLI_SPECS.map((spec) => detectConnection(spec)))
}

function sameConnections(left: CliConnection[] | null, right: CliConnection[]): boolean {
  return left !== null && JSON.stringify(left) === JSON.stringify(right)
}

function broadcast(connections: CliConnection[]): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send(ConnectionsApi.changed, connections)
  }
}

function probe(forceBroadcast: boolean): Promise<CliConnection[]> {
  if (probeInFlight) return probeInFlight
  probeInFlight = detectAll()
    .then((connections) => {
      const changed = !sameConnections(cache, connections)
      cache = connections
      if (forceBroadcast || changed) broadcast(connections)
      return connections
    })
    .finally(() => {
      probeInFlight = null
    })
  return probeInFlight
}

export function registerConnectionsIpc(): void {
  if (registered) return
  registered = true
  ipcMain.handle(ConnectionsApi.list, () => cache ?? probe(false))
  ipcMain.handle(ConnectionsApi.refresh, () => probe(true))
  void probe(false)
  refreshTimer = setInterval(() => void probe(false), REFRESH_INTERVAL_MS)
  refreshTimer.unref()
  app.once('will-quit', () => {
    if (refreshTimer) clearInterval(refreshTimer)
    refreshTimer = null
  })
}
