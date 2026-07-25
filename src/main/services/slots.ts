import Database from 'better-sqlite3'
import { execFile } from 'node:child_process'
import { constants, mkdirSync } from 'node:fs'
import { access } from 'node:fs/promises'
import { delimiter, dirname, extname, join } from 'node:path'
import type { IpcMain } from 'electron'
import { app } from 'electron'
import {
  DEFAULT_SLOT_CHOICES,
  SLOTS,
  SlotsApi,
  findSlotProvider,
  type SlotAvailability,
  type SlotChoices,
  type SlotExternalOpen,
  type SlotId
} from '../../shared/slots'

const SLOT_IDS = new Set<SlotId>(['git', 'review', 'editor'])
const BINARIES = ['lazygit', 'gitui', 'code', 'cursor'] as const
const MAX_PATH_LENGTH = 32_767

class SlotsStore {
  private readonly db: Database.Database

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true })
    this.db = new Database(dbPath)
    this.db.pragma('journal_mode = WAL')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS integration_slots (
        slot_id TEXT PRIMARY KEY CHECK (slot_id IN ('git', 'review', 'editor')),
        provider_id TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `)
  }

  get(): SlotChoices {
    const choices = { ...DEFAULT_SLOT_CHOICES }
    const rows = this.db
      .prepare('SELECT slot_id, provider_id FROM integration_slots')
      .all() as Array<{ slot_id: string; provider_id: string }>
    for (const row of rows) {
      if (!SLOT_IDS.has(row.slot_id as SlotId)) continue
      const slotId = row.slot_id as SlotId
      if (findSlotProvider(slotId, row.provider_id)) choices[slotId] = row.provider_id
    }
    return choices
  }

  set(slotId: SlotId, providerId: string): SlotChoices {
    if (!SLOT_IDS.has(slotId)) throw new Error('Unknown integration slot')
    if (!findSlotProvider(slotId, providerId)) throw new Error('Unknown slot provider')
    this.db
      .prepare(
        `INSERT INTO integration_slots (slot_id, provider_id, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(slot_id) DO UPDATE SET
           provider_id = excluded.provider_id,
           updated_at = excluded.updated_at`
      )
      .run(slotId, providerId, new Date().toISOString())
    return this.get()
  }

  close(): void {
    if (this.db.open) this.db.close()
  }
}

function e2eAvailability(): SlotAvailability | null {
  if (process.env.MORZ_E2E !== '1' || process.env.MORZ_E2E_SLOT_BINS == null) return null
  const enabled = new Set(
    process.env.MORZ_E2E_SLOT_BINS.split(',')
      .map((value) => value.trim())
      .filter(Boolean)
  )
  return Object.fromEntries(BINARIES.map((binary) => [binary, enabled.has(binary)]))
}

async function resolveBinary(binary: string): Promise<string | null> {
  if (process.platform === 'win32') {
    const whereExe = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'where.exe')
    return new Promise((resolve) => {
      execFile(whereExe, [binary], { windowsHide: true }, (error, stdout) => {
        if (error) return resolve(null)
        const candidate = stdout
          .split(/\r?\n/)
          .map((line) => line.trim())
          .find(Boolean)
        resolve(candidate ?? null)
      })
    })
  }
  for (const directory of (process.env.PATH ?? '').split(delimiter)) {
    if (!directory) continue
    const candidate = join(directory, binary)
    try {
      await access(candidate, constants.X_OK)
      return candidate
    } catch {
      // Continue through PATH.
    }
  }
  return null
}

async function detectAvailability(): Promise<SlotAvailability> {
  const override = e2eAvailability()
  if (override) return override
  const resolved = await Promise.all(BINARIES.map((binary) => resolveBinary(binary)))
  return Object.fromEntries(BINARIES.map((binary, index) => [binary, resolved[index] !== null]))
}

function validPath(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_PATH_LENGTH &&
    !/[\u0000-\u001f\u007f]/.test(value)
  )
}

function validLine(value: unknown): value is number | undefined {
  return value === undefined || (Number.isSafeInteger(value) && Number(value) >= 1)
}

function commandForEditor(editor: string): 'code' | 'cursor' | null {
  if (editor === 'vscode') return 'code'
  if (editor === 'cursor') return 'cursor'
  return null
}

function launchEditor(resolved: string, command: string, args: string[]): void {
  const extension = extname(resolved).toLowerCase()
  if (process.platform === 'win32' && (extension === '.cmd' || extension === '.bat')) {
    const powershell =
      process.env.SystemRoot == null
        ? 'powershell.exe'
        : join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    execFile(
      powershell,
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        "& $env:MORZ_EDITOR_BIN '-g' $env:MORZ_EDITOR_TARGET"
      ],
      {
        windowsHide: true,
        env: {
          ...process.env,
          MORZ_EDITOR_BIN: resolved,
          MORZ_EDITOR_TARGET: args[1] ?? ''
        }
      },
      (error) => {
        if (error) console.error(`[morz] ${command} file-open failed`)
      }
    )
    return
  }
  execFile(resolved, args, { windowsHide: true }, (error) => {
    if (error) console.error(`[morz] ${command} file-open failed`)
  })
}

export function registerSlotsIpc(ipcMain: IpcMain): void {
  const dbPath = join(app.getPath('appData'), 'Morz', 'morz.db')
  const store = new SlotsStore(dbPath)
  let availabilityPromise: Promise<SlotAvailability> | null = null
  const externalOpens: SlotExternalOpen[] = []
  const availability = (): Promise<SlotAvailability> =>
    (availabilityPromise ??= detectAvailability())

  ipcMain.handle(SlotsApi.get, () => store.get())
  ipcMain.handle(SlotsApi.availability, () => availability())
  ipcMain.handle(SlotsApi.set, async (_event, input: unknown, providerValue?: unknown) => {
    const slotId =
      typeof input === 'object' && input !== null && 'id' in input
        ? (input as { id?: unknown }).id
        : input
    const providerId =
      typeof input === 'object' && input !== null && 'providerId' in input
        ? (input as { providerId?: unknown }).providerId
        : providerValue
    if (typeof slotId !== 'string' || typeof providerId !== 'string') {
      throw new Error('Slot and provider must be strings')
    }
    if (!SLOT_IDS.has(slotId as SlotId)) throw new Error('Unknown integration slot')
    const provider = findSlotProvider(slotId as SlotId, providerId)
    if (!provider) throw new Error('Unknown slot provider')
    if (provider.requiresBin && !(await availability())[provider.requiresBin]) {
      throw new Error(`${provider.label} is not installed`)
    }
    return store.set(slotId as SlotId, providerId)
  })
  ipcMain.handle(SlotsApi.openExternal, async (_event, input: unknown) => {
    if (typeof input !== 'object' || input === null) throw new Error('Invalid file-open request')
    const { path, line } = input as { path?: unknown; line?: unknown }
    if (!validPath(path) || !validLine(line)) throw new Error('Invalid file-open target')

    const editor = store.get().editor
    const command = commandForEditor(editor)
    if (!command) return
    if (!(await availability())[command]) throw new Error(`${command} is not installed`)

    const args = ['-g', `${path}:${line ?? 1}`]
    if (process.env.MORZ_E2E === '1' && process.env.MORZ_E2E_SLOTS_STUB === '1') {
      externalOpens.push({ command, args })
      return
    }

    const resolved = await resolveBinary(command)
    if (!resolved) throw new Error(`${command} executable is unavailable`)
    launchEditor(resolved, command, args)
  })
  if (process.env.MORZ_E2E === '1') {
    ipcMain.handle(SlotsApi.testExternalOpens, () => externalOpens.map((entry) => ({ ...entry })))
  }
  app.once('before-quit', () => store.close())
}
