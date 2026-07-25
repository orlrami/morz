/*
 * w15/model-choice — main-process ModelChoice service (WAVE15 slice 6).
 *
 * Owns the singleton ModelChoiceStore (morz.db), the per-CLI model catalogs
 * (static tables + best-effort `agy models` / `opencode models` refresh on
 * connections sync), the launch-surface resolution helpers (Claude lanes,
 * dispatcher, planner, pulse, BYO opencode), and the window.morzModels IPC.
 *
 * cli-config choices NEVER write directly: proposeConfig routes through the
 * 0.0.2 config-writer (diff proposal → user approval → mtime-guarded apply).
 *
 * Registration is electron-gated (dynamic import, PlannerEngineStore
 * pattern); before init every resolver falls back to inherit = no flag.
 */
import { spawn, type ChildProcess } from 'child_process'
import {
  claudeFallbackArgs,
  inheritChoice,
  isSafeModelId,
  launchCommandModelSuffix,
  MODEL_CATALOGS,
  modelFlagArgs,
  type ModelCatalogEntry,
  type ModelChoice,
  type ModelCli
} from '../../shared/model-choice'
import {
  ModelChoiceStore,
  type ModelChoiceInput,
  GLOBAL_SCOPE
} from '../store/model-choice-store'
import {
  ModelChoiceApi,
  type ModelChoiceSetInput,
  type ModelChoiceSnapshot
} from '../../shared/ipc'
import { defaultConfigWriter, type ConfigTarget } from './config-writer'

let store: ModelChoiceStore | null = null

/** Idempotent; the smoke path and tests can init against any db path. */
export function initModelChoiceStore(dbPath: string): ModelChoiceStore {
  return (store ??= new ModelChoiceStore(dbPath))
}

export function modelChoiceStore(): ModelChoiceStore | null {
  return store
}

/* ── launch-surface resolution (sync, inherit-safe before init) ── */

/** Effective choice for a launch surface; inherit when nothing was saved. */
export function resolveModelChoice(cli: ModelCli, spaceRoot?: string | null): ModelChoice {
  return store?.resolve(cli, spaceRoot) ?? inheritChoice(cli)
}

/** argv model flags for a spawned CLI (claude lanes, planner, pulse).
 * Inherit or cli-config = [] — no flag, the CLI's own config decides. */
export function modelArgsForLaunch(cli: ModelCli, spaceRoot?: string | null): string[] {
  const choice = resolveModelChoice(cli, spaceRoot)
  return [...modelFlagArgs(choice), ...claudeFallbackArgs(choice)]
}

/** Typed-command suffix for the dispatcher's visible pane launch. */
export function launchSuffixFor(cli: ModelCli, spaceRoot?: string | null): string {
  return launchCommandModelSuffix(resolveModelChoice(cli, spaceRoot))
}

/* ── catalogs: static floor + best-effort CLI-reported refresh ── */

const dynamicCatalogs = new Map<ModelCli, ModelCatalogEntry[]>()
let refreshInFlight: Promise<void> | null = null

export function modelCatalog(cli: ModelCli): ModelCatalogEntry[] {
  const dynamic = dynamicCatalogs.get(cli) ?? []
  const merged = new Map<string, ModelCatalogEntry>()
  for (const entry of MODEL_CATALOGS[cli]) merged.set(entry.id, entry)
  for (const entry of dynamic) if (!merged.has(entry.id)) merged.set(entry.id, entry)
  return [...merged.values()]
}

function parseModelList(output: string): ModelCatalogEntry[] {
  const entries: ModelCatalogEntry[] = []
  for (const rawLine of output.split(/\r?\n/)) {
    // strip ANSI + bullets/markers, keep the first token that looks like an id
    const line = rawLine.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').trim()
    const token = line.split(/\s+/)[0]?.replace(/^[-*•]+/, '')
    if (token && isSafeModelId(token) && token.length > 2 && !/^(model|models|name|id)s?:?$/i.test(token)) {
      entries.push({ id: token, label: token })
    }
    if (entries.length >= 100) break
  }
  return entries
}

function runModelsCommand(command: string): Promise<string | null> {
  return new Promise((resolve) => {
    let child: ChildProcess
    try {
      child = spawn(command, ['models'], {
        windowsHide: true,
        // fixed literal command name — the shell only resolves the .cmd shim
        shell: process.platform === 'win32',
        stdio: ['ignore', 'pipe', 'pipe']
      })
    } catch {
      resolve(null)
      return
    }
    let output = ''
    let settled = false
    const finish = (value: string | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }
    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        // best effort
      }
      finish(null)
    }, 10_000)
    child.stdout?.on('data', (chunk: Buffer) => {
      if (output.length < 256 * 1024) output += chunk.toString('utf8')
    })
    child.once('error', () => finish(null))
    child.once('close', (code) => finish(code === 0 ? output : null))
  })
}

/** Best-effort; static catalogs always remain the floor. Called on
 * connections sync (services/connections.ts probe) and via IPC. */
export function refreshModelCatalogs(): Promise<void> {
  if (refreshInFlight) return refreshInFlight
  refreshInFlight = (async () => {
    for (const cli of ['agy', 'opencode'] as const) {
      const output = await runModelsCommand(cli)
      if (!output) continue
      const entries = parseModelList(output)
      if (entries.length > 0) dynamicCatalogs.set(cli, entries)
    }
  })().finally(() => {
    refreshInFlight = null
  })
  return refreshInFlight
}

/* ── e2e seam: last recorded Claude lane spawn args (MORZ_E2E only) ── */

let lastLaneSpawnArgs: string[] | null = null

export function recordLaneSpawnArgs(args: string[]): void {
  lastLaneSpawnArgs = [...args]
}

/* ── snapshots + IPC ── */

function rowToChoice(
  cli: ModelCli,
  row: { model: string; source: ModelChoice['source']; fallback?: string | null } | null
): ModelChoice | null {
  return row ? { cli, model: row.model, source: row.source, fallback: row.fallback ?? null } : null
}

export function modelChoiceSnapshots(spaceRoot?: string | null): ModelChoiceSnapshot[] {
  return (['claude', 'codex', 'agy', 'opencode'] as const).map((cli) => {
    const globalRow = store?.get(cli, GLOBAL_SCOPE) ?? null
    const overrideRow = spaceRoot ? (store?.get(cli, spaceRoot) ?? null) : null
    return {
      cli,
      global: rowToChoice(cli, globalRow) ?? inheritChoice(cli),
      spaceOverride: rowToChoice(cli, overrideRow),
      effective: resolveModelChoice(cli, spaceRoot),
      catalog: modelCatalog(cli)
    }
  })
}

const CONFIG_TARGETS: readonly ConfigTarget[] = ['claude', 'codex', 'opencode']

export async function registerModelChoiceIpc(): Promise<void> {
  const { app, ipcMain, BrowserWindow } = await import('electron')
  const { join } = await import('path')
  const st = initModelChoiceStore(join(app.getPath('appData'), 'Morz', 'morz.db'))
  app.once('before-quit', () => {
    st.close()
    store = null
  })

  const broadcast = (): void => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send(ModelChoiceApi.changed)
    }
  }

  ipcMain.handle(ModelChoiceApi.list, (_event, spaceRoot?: unknown) =>
    modelChoiceSnapshots(typeof spaceRoot === 'string' && spaceRoot ? spaceRoot : null)
  )

  ipcMain.handle(ModelChoiceApi.set, (_event, input: ModelChoiceSetInput) => {
    if (!input || typeof input !== 'object') throw new Error('Invalid model choice')
    const scope = typeof input.spaceRoot === 'string' && input.spaceRoot ? input.spaceRoot : GLOBAL_SCOPE
    const stored: ModelChoiceInput = {
      cli: input.cli,
      model: input.model,
      source: input.source,
      fallback: input.fallback ?? null,
      scope
    }
    st.set(stored)
    broadcast()
    return modelChoiceSnapshots(scope === GLOBAL_SCOPE ? null : scope)
  })

  ipcMain.handle(ModelChoiceApi.clearOverride, (_event, cli: ModelCli, spaceRoot: string) => {
    if (typeof spaceRoot !== 'string' || !spaceRoot) throw new Error('clearOverride needs a spaceRoot')
    st.clear(cli, spaceRoot)
    broadcast()
    return modelChoiceSnapshots(spaceRoot)
  })

  ipcMain.handle(ModelChoiceApi.refreshCatalogs, async () => {
    await refreshModelCatalogs()
    broadcast()
  })

  // Diff-first ONLY: propose returns a diff; nothing lands until applyConfig
  // is called with the user's explicit approval (ConfigDiffDialog flow).
  ipcMain.handle(ModelChoiceApi.proposeConfig, (_event, cli: unknown, model: unknown) => {
    if (typeof cli !== 'string' || !CONFIG_TARGETS.includes(cli as ConfigTarget)) {
      throw new Error(`No config write supported for ${String(cli)} — use a session flag`)
    }
    return defaultConfigWriter().proposeModel(cli as ConfigTarget, String(model))
  })

  ipcMain.handle(ModelChoiceApi.applyConfig, (_event, proposalId: string) =>
    defaultConfigWriter().apply(proposalId)
  )

  if (process.env.MORZ_E2E === '1') {
    ipcMain.handle(ModelChoiceApi.testLaneSpawnArgs, () => lastLaneSpawnArgs)
  }
}
