import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { access, open, opendir, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { delimiter, extname, join } from 'node:path'
import { app, BrowserWindow, ipcMain } from 'electron'
import { parse as parseToml } from 'smol-toml'
import type { RunPaneCreated, TerminalSpawnOpts } from '../../shared/ipc'
import {
  ConnectionsApi,
  cliOfExecutable,
  type CliConnection,
  type CliId
} from '../../shared/connections'
// w15/model-choice — catalog refresh piggybacks on connections sync.
import { refreshModelCatalogs } from './model-choice'
import { dismissNotice, notify, registerNotifyAction } from './notify-center'

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
  fullOutput: string
}

interface UpdateCommand {
  executable: string
  args: string[]
  display: string
}

export interface ConnectionsRuntime {
  spawnPane(opts: TerminalSpawnOpts): Promise<{ ok: boolean; error?: string }>
  writePane(paneId: string, data: string): void
  killPane(paneId: string): Promise<unknown>
  announcePane(info: RunPaneCreated): void
  waitForAttach(paneId: string, timeoutMs: number): Promise<boolean>
  restartClaudeSessions(): { total: number; resumed: number; plain: number }
}

interface ClaudeTelemetry {
  model: string | null
  usage: CliConnection['usage']
}

let registered = false
let cache: CliConnection[] | null = null
let probeInFlight: Promise<CliConnection[]> | null = null
let refreshTimer: NodeJS.Timeout | null = null
const updateCommands = new Map<CliId, UpdateCommand>()
const updatePanes = new Map<string, { id: CliId; label: string }>()

function connectionHome(): string {
  return homedir()
}

function cleanOutputLines(value: string): string[] {
  return value
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.slice(0, 500))
    .slice(0, 200)
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
      resolve({ ok: false, output: '', fullOutput: '' })
      return
    }

    let output = ''
    let outputBytes = 0
    let settled = false
    const finish = (ok: boolean): void => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      const lines = cleanOutputLines(output)
      resolve({ ok, output: lines[0] ?? '', fullOutput: lines.join('\n') })
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
  if (!safeCmdPath(executable) || args.some((arg) => !/^[-@/a-z0-9=._]+$/i.test(arg))) {
    return { ok: false, output: '', fullOutput: '' }
  }
  const command = `call "${executable}" ${args.join(' ')}`
  const commandProcessor = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'cmd.exe')
  return runFile(commandProcessor, ['/d', '/s', '/c', command], true)
}

/** Shim kinds Windows can actually execute; extensionless sh-shims (npm writes
 * one next to its .cmd for git-bash) are skipped — CreateProcess can't run them. */
const WINDOWS_RUNNABLE_EXTENSIONS = new Set(['.exe', '.com', '.cmd', '.bat'])

/**
 * ALL PATH matches, in PATH order. Duplicate installs are real (npm shim vs a
 * stale chocolatey exe was found live, 2026-07-25 — PATH order made Morz probe
 * a 2.1.187 leftover while the user's shell ran 2.1.220), so the caller probes
 * every candidate instead of trusting the first hit.
 */
async function resolveCandidatesOnPath(executable: string): Promise<string[]> {
  if (process.platform === 'win32') {
    const whereExe = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'where.exe')
    const result = await runFile(whereExe, [executable])
    if (!result.ok) return []
    return result.fullOutput
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .filter((line) => WINDOWS_RUNNABLE_EXTENSIONS.has(extname(line).toLowerCase()))
  }

  const candidates: string[] = []
  const pathValue = process.env.PATH ?? ''
  for (const dir of pathValue.split(delimiter)) {
    if (!dir) continue
    const candidate = join(dir, executable)
    try {
      await access(candidate, constants.X_OK)
      candidates.push(candidate)
    } catch {
      // Continue through PATH. A missing or non-executable entry is not fatal.
    }
  }
  return candidates
}

async function resolveExecutables(id: CliId, executable: string): Promise<string[]> {
  const resolved = await resolveCandidatesOnPath(executable)
  return resolved.filter((candidate) => cliOfExecutable(candidate) === id)
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

/**
 * Best-effort Antigravity auth probe. Returns false when there is no evidence
 * of configuration, null (unknown) when a config directory or env credential
 * is present but can't be confirmed without an interactive TTY.
 */
async function agyAuthStatus(home: string): Promise<boolean | null> {
  if (process.env.ANTIGRAVITY_API_KEY?.trim() || process.env.GOOGLE_API_KEY?.trim()) return null
  for (const dir of [join(home, '.antigravity'), join(home, '.agy')]) {
    if (await exists(dir)) return null
  }
  return false
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
  if (id === 'agy') return agyAuthStatus(home)
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

function versionToken(value: string): string | null {
  return value.match(/\bv?(\d+(?:\.\d+){1,3}(?:[-+][0-9a-z.-]+)?)/i)?.[1] ?? null
}

function latestVersionFromOutput(value: string): string | null {
  const patterns = [
    /update available(?:\s+(?:to|version))?\s*[:=-]?\s*v?(\d+(?:\.\d+){1,3}(?:[-+][0-9a-z.-]+)?)/i,
    /latest version\s*[:=-]\s*v?(\d+(?:\.\d+){1,3}(?:[-+][0-9a-z.-]+)?)/i,
    /last update attempt\s*:\s*success\s*(?:->|\u2192)\s*v?(\d+(?:\.\d+){1,3}(?:[-+][0-9a-z.-]+)?)/i
  ]
  for (const pattern of patterns) {
    const match = value.match(pattern)
    if (match?.[1]) return match[1]
  }
  return null
}

function compareVersions(left: string, right: string): number {
  const parts = (value: string): number[] =>
    value.split(/[+-]/, 1)[0].split('.').map((part) => Number.parseInt(part, 10) || 0)
  const a = parts(left)
  const b = parts(right)
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const delta = (a[index] ?? 0) - (b[index] ?? 0)
    if (delta !== 0) return delta
  }
  return 0
}

function updateState(
  id: CliId,
  currentVersion: string,
  latestVersion: string | null,
  command: UpdateCommand
): CliConnection['update'] {
  if (!latestVersion || compareVersions(currentVersion, latestVersion) >= 0) return null
  updateCommands.set(id, command)
  return { available: true, latestVersion, command: command.display }
}

function parseJsonOutput(value: string): unknown {
  const start = value.indexOf('{')
  const end = value.lastIndexOf('}')
  if (start < 0 || end < start) throw new Error('Command output did not include JSON')
  return JSON.parse(value.slice(start, end + 1)) as unknown
}

async function npmCodexUpdate(
  currentVersion: string
): Promise<CliConnection['update']> {
  const [npm] = await resolveCandidatesOnPath('npm')
  if (!npm) return null
  const installed = await runCli(npm, ['ls', '-g', '@openai/codex', '--depth=0', '--json'])
  let installedVersion: string | null = null
  try {
    const parsed = parseJsonOutput(installed.fullOutput) as {
      dependencies?: Record<string, { version?: unknown }>
    }
    const version = parsed.dependencies?.['@openai/codex']?.version
    installedVersion = typeof version === 'string' ? version : null
  } catch {
    return null
  }
  if (!installedVersion) return null
  const outdated = await runCli(npm, ['outdated', '-g', '@openai/codex', '--json'])
  let latestVersion: string | null = null
  try {
    const parsed = parseJsonOutput(outdated.fullOutput) as Record<string, { latest?: unknown }>
    const latest = parsed['@openai/codex']?.latest
    latestVersion = typeof latest === 'string' ? latest : null
  } catch {
    latestVersion = latestVersionFromOutput(outdated.fullOutput)
  }
  return updateState('codex', currentVersion, latestVersion, {
    executable: npm,
    args: ['update', '-g', '@openai/codex'],
    display: 'npm update -g @openai/codex'
  })
}

async function updateFor(
  id: CliId,
  executable: string,
  versionProbe: CommandResult
): Promise<CliConnection['update']> {
  const currentVersion = versionToken(versionProbe.output)
  if (!currentVersion) return null
  if (id === 'claude') {
    const doctor = await runCli(executable, ['doctor'])
    const latestVersion = latestVersionFromOutput(
      `${versionProbe.fullOutput}\n${doctor.fullOutput}`
    )
    return updateState('claude', currentVersion, latestVersion, {
      executable,
      args: ['update'],
      display: 'claude update'
    })
  }
  if (id === 'codex') return npmCodexUpdate(currentVersion)
  if (id === 'agy') {
    const help = await runCli(executable, ['update', '--help'])
    if (!/\b(?:usage of update|update cli|update command)\b/i.test(help.fullOutput)) return null
    const latestVersion = latestVersionFromOutput(`${versionProbe.fullOutput}\n${help.fullOutput}`)
    return updateState('agy', currentVersion, latestVersion, {
      executable,
      args: ['update'],
      display: 'agy update'
    })
  }
  return null
}

async function detectConnection(
  spec: (typeof CLI_SPECS)[number],
  previous: CliConnection | undefined
): Promise<CliConnection> {
  const detectedAt = Date.now()
  updateCommands.delete(spec.id)
  const candidates = await resolveExecutables(spec.id, spec.executable)
  if (candidates.length === 0) {
    // The last known version stays visible (honest staleness), but nothing
    // resolves on PATH any more: present goes false so the planner stops
    // treating a removed CLI as available (w17 review).
    if (previous?.installed && previous.version) {
      return { ...previous, detectedAt, present: false, versionStale: true, update: null }
    }
    return {
      id: spec.id,
      label: spec.label,
      installed: false,
      present: false,
      version: null,
      detectedAt,
      versionStale: false,
      update: null,
      authed: null,
      plan: null,
      model: null,
      usage: null
    }
  }

  /* Probe every PATH candidate and adopt the NEWEST working install: PATH
   * order lies when package managers leave stale duplicates behind. Lower-
   * version duplicates are surfaced, never silently ignored. */
  const probes = await Promise.all(
    candidates.slice(0, 4).map(async (path) => {
      const result = await runCli(path, ['--version'])
      const token = result.ok && result.output ? versionToken(result.output) : null
      return { path, result, token }
    })
  )
  const working = probes.filter((probe) => probe.result.ok && probe.result.output)
  const best =
    working.reduce<(typeof probes)[number] | null>((current, probe) => {
      if (!current) return probe
      if (!probe.token) return current
      if (!current.token) return probe
      return compareVersions(probe.token, current.token) > 0 ? probe : current
    }, null) ?? probes[0]
  const executable = best.path
  const versionProbe = best.result
  const duplicates = working
    .filter(
      (probe) =>
        probe !== best &&
        probe.token &&
        best.token &&
        compareVersions(probe.token, best.token) < 0
    )
    .map((probe) => `${probe.token} · ${probe.path}`)

  const home = connectionHome()
  const [authed, plan, configured, telemetry] = await Promise.all([
    authStatus(spec.id, executable, home),
    planFor(spec.id, home),
    configuredModel(spec.id, home),
    spec.id === 'claude' ? claudeTelemetry(home) : Promise.resolve<ClaudeTelemetry>({ model: null, usage: null })
  ])
  const versionFailed = !versionProbe.ok || !versionProbe.output
  const version = versionFailed ? previous?.version ?? null : versionProbe.output
  const update = versionFailed ? null : await updateFor(spec.id, executable, versionProbe)
  return {
    id: spec.id,
    label: spec.label,
    installed: true,
    present: true,
    version,
    detectedAt,
    versionStale: versionFailed,
    duplicates: duplicates.length > 0 ? duplicates : undefined,
    update,
    authed,
    plan,
    model: configured ?? telemetry.model,
    usage: spec.id === 'claude' ? telemetry.usage : null
  }
}

async function detectAll(): Promise<CliConnection[]> {
  const previous = new Map((cache ?? []).map((connection) => [connection.id, connection]))
  return Promise.all(CLI_SPECS.map((spec) => detectConnection(spec, previous.get(spec.id))))
}

function sameConnections(left: CliConnection[] | null, right: CliConnection[]): boolean {
  const comparable = (connections: CliConnection[]): unknown =>
    connections.map(({ detectedAt: _detectedAt, ...connection }) => connection)
  return left !== null && JSON.stringify(comparable(left)) === JSON.stringify(comparable(right))
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
      const timestampChanged = connections.some(
        (connection, index) => connection.detectedAt !== cache?.[index]?.detectedAt
      )
      cache = connections
      // Fresh timestamps are user-visible even when every other field is stable.
      // Refresh/model-catalog work still keys off material changes below.
      if (forceBroadcast || changed || timestampChanged) broadcast(connections)
      // w15/model-choice — refresh `agy models` / `opencode models` catalogs
      // on connections sync (best-effort; static tables stay the floor).
      if (changed) void refreshModelCatalogs().catch(() => undefined)
      return connections
    })
    .finally(() => {
      probeInFlight = null
    })
  return probeInFlight
}

/** Current CONNECTIONS roster, probing once when startup detection is still in flight. */
export function listDetectedConnections(): Promise<CliConnection[]> {
  return cache ? Promise.resolve(cache) : probe(false)
}

function shellCommand(command: UpdateCommand): {
  shell: string
  argv: string[]
  input: string
} {
  if (process.platform === 'win32') {
    if (!safeCmdPath(command.executable)) throw new Error('Updater path cannot be run safely')
    // Args are allowlist-validated upstream (no spaces/specials possible), but
    // quote each one anyway so a future validation change can't reopen a
    // cmd.exe word-splitting seam (review finding, w16).
    const args = command.args.map((arg) => `"${arg}"`).join(' ')
    return {
      shell: 'cmd',
      argv: ['/d', '/v:on', '/k'],
      input:
        `echo [Morz] Running: ${command.display}` +
        ` & call "${command.executable}" ${args}` +
        ' & set MORZ_UPDATE_EXIT=!errorlevel!' +
        ' & exit /b !MORZ_UPDATE_EXIT!\r'
    }
  }
  const quote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`
  return {
    shell: '/bin/sh',
    argv: [],
    input:
      `printf '\\n[Morz] Running: %s\\n' ${quote(command.display)}; ` +
      `${quote(command.executable)} ${command.args.map(quote).join(' ')}; ` +
      'MORZ_UPDATE_EXIT=$?; exit "$MORZ_UPDATE_EXIT"\n'
  }
}

async function startUpdate(id: CliId, runtime: ConnectionsRuntime): Promise<{ paneId: string }> {
  const connection = cache?.find((candidate) => candidate.id === id)
  const command = updateCommands.get(id)
  if (!connection?.installed || connection.versionStale || !connection.update?.available || !command) {
    throw new Error('No verified update is available for this CLI')
  }
  if (id === 'opencode') throw new Error('OpenCode has no configured updater')

  const paneId = `cli-update-${id}-${randomUUID().slice(0, 8)}`
  const invocation = shellCommand(command)
  const cwd = connectionHome()
  const result = await runtime.spawnPane({
    paneId,
    shell: invocation.shell,
    argv: invocation.argv,
    cwd,
    cols: 120,
    rows: 36
  })
  if (!result.ok) throw new Error(result.error ?? `Could not open the ${connection.label} updater`)

  runtime.announcePane({
    paneId,
    runId: `cli-update:${id}`,
    agentId: `update-${id}`,
    cwd,
    cli: id
  })
  const attached = await runtime.waitForAttach(paneId, 10_000)
  if (!attached) {
    await runtime.killPane(paneId)
    throw new Error('The updater pane did not become visible')
  }
  updatePanes.set(paneId, { id, label: connection.label })
  runtime.writePane(paneId, invocation.input)
  return { paneId }
}

function registerRestartAction(runtime: ConnectionsRuntime): void {
  registerNotifyAction('restart-claude-sessions', (noticeId) => {
    const summary = runtime.restartClaudeSessions()
    dismissNotice(noticeId)
    notify({
      id: 'connections:claude-sessions-restarted',
      level: 'success',
      source: 'adapter',
      title: 'Claude sessions restarted',
      detail:
        summary.total === 0
          ? 'There were no live Claude sessions to restart.'
          : `${summary.resumed} resumed with held session IDs; ${summary.plain} restarted without a resume ID.`
    })
  })
}

export function handleCliUpdateExit(paneId: string, exitCode: number): void {
  const pendingUpdate = updatePanes.get(paneId)
  if (!pendingUpdate) return
  updatePanes.delete(paneId)
  if (exitCode !== 0) {
    notify({
      id: `connections:update:${pendingUpdate.id}`,
      level: 'error',
      source: 'adapter',
      title: `${pendingUpdate.label} update failed`,
      detail: `The visible updater pane exited with code ${exitCode}.`
    })
    return
  }
  notify({
    id: `connections:update:${pendingUpdate.id}`,
    level: 'success',
    source: 'adapter',
    title: `${pendingUpdate.label} updated`,
    detail:
      pendingUpdate.id === 'claude'
        ? 'Restart live Claude sessions to use the updated CLI. Sessions without a held resume ID restart plain.'
        : 'The updater completed successfully in the visible terminal pane.',
    actions:
      pendingUpdate.id === 'claude'
        ? [{ id: 'restart-claude-sessions', label: 'Restart Claude sessions' }]
        : undefined
  })
  void probe(true)
}

export function registerConnectionsIpc(runtime: ConnectionsRuntime): void {
  if (registered) return
  registered = true
  registerRestartAction(runtime)
  ipcMain.handle(ConnectionsApi.list, () => cache ?? probe(false))
  ipcMain.handle(ConnectionsApi.refresh, () => probe(true))
  ipcMain.handle(ConnectionsApi.update, (_event, id: unknown) => {
    if (typeof id !== 'string' || !CLI_SPECS.some((spec) => spec.id === id)) {
      throw new Error('Unknown CLI updater')
    }
    return startUpdate(id as CliId, runtime)
  })
  void probe(false)
  refreshTimer = setInterval(() => void probe(false), REFRESH_INTERVAL_MS)
  refreshTimer.unref()
  app.once('will-quit', () => {
    if (refreshTimer) clearInterval(refreshTimer)
    refreshTimer = null
  })
}
