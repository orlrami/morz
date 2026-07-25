import { spawn, type ChildProcess } from 'node:child_process'
import { constants } from 'node:fs'
import { access } from 'node:fs/promises'
import { delimiter, extname, join } from 'node:path'
import Database from 'better-sqlite3'
import { app, ipcMain } from 'electron'
import { mkdirSync } from 'node:fs'
import { MODULES, type ModuleId } from '../../shared/modules'
import {
  minimalOnboardingSnapshot,
  OnboardingApi,
  ONBOARDING_SLOTS,
  ONBOARDING_TARGETS,
  type OnboardingDetection,
  type OnboardingMode,
  type OnboardingSlotId,
  type OnboardingSnapshot,
  type OnboardingTargetId
} from '../../shared/onboarding'

const PROBE_TIMEOUT_MS = 5_000
const MAX_OUTPUT_BYTES = 32 * 1024
const MAX_VERSION_CHARS = 160
const MAX_MODEL_CHARS = 120

let db: Database.Database | null = null
let registered = false

function openDb(): Database.Database {
  if (db) return db
  const dir = join(app.getPath('appData'), 'Morz')
  mkdirSync(dir, { recursive: true })
  db = new Database(join(dir, 'morz.db'))
  db.pragma('journal_mode = WAL')
  db.exec(`
    CREATE TABLE IF NOT EXISTS onboarding_settings (
      id            INTEGER PRIMARY KEY CHECK (id = 1),
      completed     INTEGER NOT NULL CHECK (completed IN (0, 1)),
      settings_json TEXT NOT NULL,
      updated_at    INTEGER NOT NULL
    )
  `)
  return db
}

function cleanVersion(value: string): string | null {
  const first = value
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean)
  return first ? first.slice(0, MAX_VERSION_CHARS) : null
}

function safeCmdPath(file: string): boolean {
  return !/["&|<>^%!\r\n]/.test(file)
}

function runFile(file: string, args: readonly string[], windowsVerbatimArguments = false): Promise<string | null> {
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
      resolve(null)
      return
    }

    let output = ''
    let bytes = 0
    let settled = false
    const finish = (ok: boolean): void => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      resolve(ok ? cleanVersion(output) : null)
    }
    const collect = (chunk: Buffer): void => {
      if (settled) return
      bytes += chunk.byteLength
      if (bytes > MAX_OUTPUT_BYTES) {
        child.kill('SIGKILL')
        finish(false)
        return
      }
      output += chunk.toString('utf8')
    }
    const timeout = setTimeout(() => {
      child.kill('SIGKILL')
      finish(false)
    }, PROBE_TIMEOUT_MS)
    timeout.unref()
    child.stdout?.on('data', collect)
    child.stderr?.on('data', collect)
    child.once('error', () => finish(false))
    child.once('close', (code) => finish(code === 0))
  })
}

async function runVersion(executable: string): Promise<string | null> {
  const extension = extname(executable).toLowerCase()
  if (process.platform !== 'win32' || (extension !== '.cmd' && extension !== '.bat')) {
    return runFile(executable, ['--version'])
  }
  if (!safeCmdPath(executable)) return null
  const commandProcessor = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'cmd.exe')
  return runFile(commandProcessor, ['/d', '/s', '/c', `call "${executable}" --version`], true)
}

async function resolveExecutable(executable: string): Promise<string | null> {
  if (process.platform === 'win32') {
    const whereExe = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'where.exe')
    return runFile(whereExe, [executable])
  }
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir) continue
    const candidate = join(dir, executable)
    try {
      await access(candidate, constants.X_OK)
      return candidate
    } catch {
      // Continue through PATH.
    }
  }
  return null
}

async function detectTarget(
  target: (typeof ONBOARDING_TARGETS)[number]
): Promise<OnboardingDetection> {
  const executable = await resolveExecutable(target.executable)
  if (!executable) return { id: target.id, installed: false, version: null }
  return { id: target.id, installed: true, version: await runVersion(executable) }
}

async function detectAll(): Promise<OnboardingDetection[]> {
  return Promise.all(ONBOARDING_TARGETS.map(detectTarget))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function normalizeSnapshot(value: unknown, completedOverride?: boolean): OnboardingSnapshot {
  const fallback = minimalOnboardingSnapshot(false)
  if (!isRecord(value)) return fallback

  const rawModules = isRecord(value.modules) ? value.modules : {}
  const modules = Object.fromEntries(
    MODULES.map((module) => [module.id, rawModules[module.id] === true])
  ) as Record<ModuleId, boolean>

  const rawModels = isRecord(value.models) ? value.models : {}
  const models = Object.fromEntries(
    ONBOARDING_TARGETS.map((target) => {
      const candidate = rawModels[target.id]
      const allowed =
        typeof candidate === 'string' &&
        candidate.length <= MAX_MODEL_CHARS &&
        target.models.some((model) => model.value === candidate)
      return [target.id, allowed ? candidate : 'inherit']
    })
  ) as Record<OnboardingTargetId, string>

  const rawSlots = isRecord(value.slots) ? value.slots : {}
  const slots = Object.fromEntries(
    ONBOARDING_SLOTS.map((slot) => {
      const candidate = rawSlots[slot.id]
      return [
        slot.id,
        typeof candidate === 'string' && slot.providers.some((provider) => provider.id === candidate)
          ? candidate
          : fallback.slots[slot.id]
      ]
    })
  ) as Record<OnboardingSlotId, string>

  const rawMode = value.autonomy
  const autonomy: OnboardingMode =
    rawMode === 'assisted' || rawMode === 'orchestrated' ? rawMode : 'manual'
  if (!modules.orchestration && autonomy === 'orchestrated') {
    return {
      completed: completedOverride ?? value.completed === true,
      modules,
      models,
      slots,
      autonomy: 'manual'
    }
  }
  return {
    completed: completedOverride ?? value.completed === true,
    modules,
    models,
    slots,
    autonomy
  }
}

function load(): OnboardingSnapshot {
  const row = openDb()
    .prepare('SELECT completed, settings_json FROM onboarding_settings WHERE id = 1')
    .get() as { completed: number; settings_json: string } | undefined
  if (!row) return minimalOnboardingSnapshot(false)
  try {
    return normalizeSnapshot({ ...JSON.parse(row.settings_json), completed: row.completed === 1 })
  } catch {
    return minimalOnboardingSnapshot(false)
  }
}

function save(value: unknown): OnboardingSnapshot {
  const snapshot = normalizeSnapshot(value, true)
  const settings = {
    modules: snapshot.modules,
    models: snapshot.models,
    slots: snapshot.slots,
    autonomy: snapshot.autonomy
  }
  openDb()
    .prepare(
      `INSERT INTO onboarding_settings (id, completed, settings_json, updated_at)
       VALUES (1, 1, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         completed = excluded.completed,
         settings_json = excluded.settings_json,
         updated_at = excluded.updated_at`
    )
    .run(JSON.stringify(settings), Date.now())
  return snapshot
}

export function registerOnboardingIpc(): void {
  if (registered) return
  registered = true
  ipcMain.handle(OnboardingApi.get, () => load())
  ipcMain.handle(OnboardingApi.detect, () => detectAll())
  ipcMain.handle(OnboardingApi.save, (_event, value: unknown) => save(value))
}
