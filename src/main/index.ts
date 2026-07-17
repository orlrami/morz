/*
 * Morz main process (0.0.1 Slices 1+2).
 * Hosts the sandboxed window, supervises the PTY-host utilityProcess (watchdog
 * respawn), wires a MessageChannelMain between renderer and host per window,
 * registers control-plane IPC, and stays tray-resident so closing the window
 * keeps PTYs alive (reopen → reattach via pty:list).
 */
import {
  app,
  BrowserWindow,
  ipcMain,
  Menu,
  nativeImage,
  shell,
  Tray,
  utilityProcess,
  type UtilityProcess
} from 'electron'
import { join, basename } from 'path'
import { spawnSync, execFile } from 'child_process'
import { PaneInfoApi, PtyApi, type PaneInfo, type TerminalSpawnOpts } from '../shared/ipc'

/*
 * Test isolation hook: Electron resolves appData via the Windows shell API, so
 * setting the APPDATA env var does NOT redirect it. E2E launches set
 * MORZ_USER_DATA to keep localStorage + morz.db out of the user's real
 * %APPDATA%\Morz / Roaming\morz. Must run before any getPath consumer.
 */
if (process.env.MORZ_USER_DATA) {
  app.setPath('appData', process.env.MORZ_USER_DATA)
  app.setPath('userData', join(process.env.MORZ_USER_DATA, 'morz'))
}
import {
  journalAppend,
  journalDelete,
  journalEntries,
  registerSessionIpc
} from './store/db'
import { registerFileIpc } from './services/file-service'
import { registerFsIpc } from './services/fs-service'
import { registerGitIpc } from './services/git-service'
import { registerEditorIpc } from './services/editor-detect'
import { registerClaudeIpc } from './adapters/claude'
import { notify, registerNotifyCenter } from './services/notify-center'
// w4/mcp — bus pipe server + tool handlers (SqliteBoardPort = the real board)
import { startPipeServer, type BusPipeServer } from './bus/pipe-server'
import { BUS_OPEN_FILE_CHANNEL, createToolHandlers } from './bus/tool-handlers'
import { SqliteBoardPort } from './bus/board-port'
import { registerHandoffIpc } from './bus/handoff' // w4/handoff

// w7/errors-research — last-resort main-process error surface. Producer-level
// handlers should still classify expected failures before they reach this path.
let reportingMainFailure = false

function mainFailureDetail(value: unknown): string {
  const raw = value instanceof Error
    ? value.message
    : typeof value === 'string'
      ? value
      : 'An unknown main-process failure occurred.'
  const clean = raw
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
    .replace(/\b(api[_-]?key|token|password|secret|authorization)\s*[:=]\s*(["'])[^"'\r\n]*\2/gi, '$1=[redacted]')
    .replace(/\b(authorization)\s*[:=]\s*(?:Basic|Bearer|Digest|Negotiate|ApiKey)\s+[^\s,;]+/gi, '$1=[redacted]')
    .replace(/\b(api[_-]?key|token|password|secret|authorization)\s*[:=]\s*[^\s,;]+/gi, '$1=[redacted]')
    .replace(/\bhttps?:\/\/[^\s]+/gi, (candidate) => {
      try {
        const url = new URL(candidate)
        return `${url.origin}${url.pathname}`
      } catch {
        return '[url]'
      }
    })
    .replace(/\b[A-Za-z]:\\[^\r\n]*/g, '[path]')
    .replace(/\s+/g, ' ')
    .trim()
  return clean.slice(0, 300) || 'An unknown main-process failure occurred.'
}

function reportMainFailure(id: string, title: string, value: unknown): void {
  if (reportingMainFailure) return
  reportingMainFailure = true
  try {
    notify({
      id,
      level: 'error',
      source: 'app',
      title,
      detail: mainFailureDetail(value)
    })
  } catch {
    // Avoid recursively throwing from the last-resort failure path.
  } finally {
    reportingMainFailure = false
  }
}

process.on('unhandledRejection', (reason) => {
  reportMainFailure('app:unhandled-rejection', 'Background task failed', reason)
})

process.on('uncaughtException', (error) => {
  reportMainFailure('app:uncaught-exception', 'Morz encountered an unexpected error', error)
  app.exit(1)
})

/* ── PTY-host supervisor ─────────────────────────────────────── */

interface SpawnJournal {
  paneId: string
  pid: number
  shell: string
  argv?: string[] // w11/lanes-runs — absent on journal rows from older builds
  foreground?: string
  cwd: string
  sessionGuid: string
}

let ptyHost: UtilityProcess | null = null
let hostGeneration = 0
let reqId = 0
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
let restartTimestamps: number[] = []
let shuttingDown = false
/** MORZ_SMOKE only: taps relayed PTY output. */
let smokeDataTap: ((paneId: string, data: string) => void) | null = null

function startPtyHost(): void {
  const host = utilityProcess.fork(join(__dirname, 'pty-host.js'), [], {
    serviceName: 'morz-pty-host'
  })
  ptyHost = host
  hostGeneration++

  host.on('spawn', () => {
    // e2e handle: the torture spec reads this pid to hard-kill the host
    ;(globalThis as Record<string, unknown>).__MORZ_PTY_HOST_PID = host.pid
  })

  host.on('message', (msg: { type: string; [k: string]: unknown }) => {
    if (!msg || typeof msg !== 'object') return
    switch (msg.type) {
      case 'res': {
        const p = pending.get(msg.id as number)
        if (!p) return
        pending.delete(msg.id as number)
        if (msg.ok) p.resolve(msg.result)
        else p.reject(new Error(String(msg.error)))
        break
      }
      case 'spawned':
        journalAppend('pty-spawn', msg.info)
        break
      case 'exit': {
        // pane gone → its journal row no longer represents a live child
        const paneId = msg.paneId as string
        for (const row of journalEntries('pty-spawn')) {
          if ((row.payload as SpawnJournal | null)?.paneId === paneId) journalDelete(row.id)
        }
        break
      }
      case 'pty': {
        // relay PTY output/exit to every window's renderer
        const relayed = msg.msg as { type: string; paneId: string; data?: string }
        for (const win of BrowserWindow.getAllWindows()) {
          if (!win.isDestroyed()) win.webContents.send(PtyApi.data, relayed)
        }
        if (smokeDataTap && relayed.type === 'data') smokeDataTap(relayed.paneId, relayed.data ?? '')
        break
      }
    }
  })

  host.on('exit', (code) => {
    if (ptyHost === host) ptyHost = null
    for (const p of pending.values()) p.reject(new Error('pty-host exited'))
    pending.clear()
    if (shuttingDown) return
    console.error(`[morz] pty-host exited (code ${code}) — watchdog respawn`)

    // every pane died with the host — the journal rows ARE the live-pane set
    // (pane-exit messages prune rows as panes die, so what's left was alive).
    // Broadcast a tagged exit per pane so the UI shows dead-pane state.
    const deadPanes = new Set<string>()
    for (const row of journalEntries('pty-spawn')) {
      const info = row.payload as SpawnJournal | null
      if (info?.paneId) deadPanes.add(info.paneId)
    }
    console.error(`[morz] dead panes: ${[...deadPanes].join(',')}`)
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed()) continue
      for (const paneId of deadPanes) {
        win.webContents.send(PtyApi.data, { type: 'exit', paneId, exitCode: -1 })
      }
    }
    // the dead host's shells lost their ConPTY handles — unreachable forever;
    // reap them now via the same journal+PID-guard path as the startup sweep
    sweepOrphans()

    // watchdog: at most 3 respawns per minute, then give up (dead panes stay dead)
    const now = Date.now()
    restartTimestamps = restartTimestamps.filter((t) => now - t < 60_000)
    if (restartTimestamps.length >= 3) {
      console.error('[morz] pty-host crash-looping — not respawning')
      return
    }
    restartTimestamps.push(now)
    startPtyHost()
    // renderer's old MessagePort closed with the host; hand every open window a
    // fresh one and let the UI toast "terminal engine restarted"
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed()) continue
      win.webContents.send('pty:host-restarted', { generation: hostGeneration })
      wirePtyPort(win)
    }
  })
}

function hostRequest<T>(op: 'spawn' | 'resize' | 'kill' | 'list', payload?: unknown): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (!ptyHost) return reject(new Error('pty-host not running'))
    const id = ++reqId
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject })
    ptyHost.postMessage({ type: 'req', id, op, payload })
    setTimeout(() => {
      if (pending.delete(id)) reject(new Error(`pty-host ${op} timed out`))
    }, 15_000)
  })
}

/** On (re)load, ask the host to replay each live pane's scrollback so a reopened
 * or reloaded window shows current terminal state (PTY data relays through main). */
function wirePtyPort(win: BrowserWindow): void {
  if (!ptyHost || win.isDestroyed()) return
  void hostRequest<string[]>('list')
    .then((ids) => {
      for (const paneId of ids) ptyHost?.postMessage({ type: 'attach', paneId })
    })
    .catch(() => {})
}

/* ── orphan sweep (previous crashed run) ─────────────────────── */

function imageNameOfPid(pid: number): string | null {
  try {
    const out = spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], {
      timeout: 10_000,
      windowsHide: true
    })
      .stdout?.toString()
      .trim()
    const m = out?.match(/^"([^"]+)"/)
    return m ? m[1].toLowerCase() : null
  } catch {
    return null
  }
}

function sweepOrphans(): void {
  // journal rows only survive a crash — clean shutdown deletes them as panes exit
  for (const row of journalEntries('pty-spawn')) {
    const info = row.payload as SpawnJournal | null
    if (info && typeof info.pid === 'number') {
      const image = imageNameOfPid(info.pid)
      // PID-reuse guard: only kill if the process is still the shell we spawned
      if (image && image === basename(info.shell).toLowerCase()) {
        console.error(`[morz] sweeping orphan ${image} (pid ${info.pid}) from crashed run`)
        spawnSync('taskkill', ['/pid', String(info.pid), '/T', '/F'], {
          timeout: 10_000,
          windowsHide: true
        })
      }
    }
    journalDelete(row.id)
  }
}

/* ── control-plane IPC ───────────────────────────────────────── */

/* ── w12/agent-detect — live foreground-CLI detection ─────────────
 * ConPTY reports the SHELL name (pwsh), never the `claude`/`codex`/`agy` the
 * user typed inside it, so the spawn-journal `foreground` is not enough. Walk
 * each pane's shell-PID process tree for a running CLI. One process snapshot
 * per poll window is shared across every pane (the renderer polls each pane
 * every 1s; the snapshot is cached ~2.5s so PowerShell is spawned sparingly).
 * Windows-only: on Unix pty.process already reports the foreground child. */
const CLI_IMAGE_RE = /^(claude|codex|agy|opencode|antigravity)(\.(exe|cmd|bat|ps1))?$/i
interface ProcRow {
  pid: number
  name: string
}
let procSnapshot: { at: number; byParent: Map<number, ProcRow[]> } | null = null

async function processTreeByParent(): Promise<Map<number, ProcRow[]>> {
  const now = Date.now()
  if (procSnapshot && now - procSnapshot.at < 2_500) return procSnapshot.byParent
  const byParent = new Map<number, ProcRow[]>()
  if (process.platform === 'win32') {
    try {
      const stdout = await new Promise<string>((resolve, reject) => {
        execFile(
          'powershell',
          [
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name | ConvertTo-Json -Compress'
          ],
          { windowsHide: true, timeout: 8_000, maxBuffer: 24 * 1024 * 1024 },
          (err, out) => (err ? reject(err) : resolve(out))
        )
      })
      const parsed = JSON.parse(stdout) as
        | { ProcessId: number; ParentProcessId: number; Name: string }[]
        | { ProcessId: number; ParentProcessId: number; Name: string }
      for (const r of Array.isArray(parsed) ? parsed : [parsed]) {
        if (typeof r?.ProcessId !== 'number' || typeof r?.ParentProcessId !== 'number') continue
        const arr = byParent.get(r.ParentProcessId) ?? []
        arr.push({ pid: r.ProcessId, name: String(r.Name ?? '') })
        byParent.set(r.ParentProcessId, arr)
      }
    } catch {
      // Snapshot unavailable (offline/timeout) — detection just doesn't augment
      // this cycle; lanes + dispatched runs still show via their own stores.
    }
  }
  procSnapshot = { at: now, byParent }
  return byParent
}

/** First CLI image found under `shellPid` (breadth-first over descendants). */
function descendantCliImage(shellPid: number, byParent: Map<number, ProcRow[]>): string | undefined {
  const seen = new Set<number>()
  const queue = [shellPid]
  while (queue.length > 0) {
    const pid = queue.shift()!
    if (seen.has(pid)) continue
    seen.add(pid)
    for (const child of byParent.get(pid) ?? []) {
      if (CLI_IMAGE_RE.test(child.name)) return child.name
      queue.push(child.pid)
    }
  }
  return undefined
}

function registerPtyIpc(): void {
  ipcMain.handle(PtyApi.spawn, (_e, opts: TerminalSpawnOpts) => hostRequest('spawn', opts))
  ipcMain.handle(PtyApi.list, () => hostRequest<string[]>('list'))
  // w11/lanes-runs — intersect the durable spawn journal with the host's live
  // pane set. This fails closed: malformed/stale rows never reach the renderer.
  ipcMain.handle(PaneInfoApi.list, async (): Promise<PaneInfo[]> => {
    const paneIds = await hostRequest<string[]>('list')
    const live = new Set(paneIds)
    const shellPidByPane = new Map<string, number>()
    const latest = new Map<string, PaneInfo>()
    for (const row of journalEntries('pty-spawn')) {
      const info = row.payload as SpawnJournal | null
      if (!info || !live.has(info.paneId) || typeof info.shell !== 'string') continue
      if (typeof info.pid === 'number') shellPidByPane.set(info.paneId, info.pid)
      latest.set(info.paneId, {
        paneId: info.paneId,
        shell: info.shell,
        argv: Array.isArray(info.argv)
          ? info.argv.filter((value): value is string => typeof value === 'string')
          : [],
        ...(typeof info.foreground === 'string' && info.foreground.trim()
          ? { foreground: info.foreground.trim() }
          : {})
      })
    }
    // w12/agent-detect — live scan: a CLI launched by hand inside a shell pane
    // becomes a descendant of the shell PID. Overrides the stale spawn-time
    // foreground so `claude` typed into pwsh is detected as an agent.
    const byParent = await processTreeByParent()
    if (byParent.size > 0) {
      for (const [paneId, shellPid] of shellPidByPane) {
        const image = descendantCliImage(shellPid, byParent)
        const info = latest.get(paneId)
        if (image && info) latest.set(paneId, { ...info, foreground: image })
      }
    }
    return paneIds.flatMap((paneId) => {
      const info = latest.get(paneId)
      return info ? [info] : []
    })
  })
  ipcMain.on(PtyApi.resize, (_e, p: { paneId: string; cols: number; rows: number }) => {
    hostRequest('resize', p).catch(() => {})
  })
  ipcMain.on(PtyApi.kill, (_e, p: { paneId: string }) => {
    hostRequest('kill', p).catch(() => {})
  })
  // keystrokes / flow-control ack / reattach — forwarded straight to the host
  ipcMain.on(PtyApi.write, (_e, p: { paneId: string; data: string }) =>
    ptyHost?.postMessage({ type: 'write', paneId: p.paneId, data: p.data })
  )
  ipcMain.on(PtyApi.ack, (_e, p: { paneId: string; bytes: number }) =>
    ptyHost?.postMessage({ type: 'ack', paneId: p.paneId, bytes: p.bytes })
  )
  ipcMain.on(PtyApi.attach, (_e, p: { paneId: string }) =>
    ptyHost?.postMessage({ type: 'attach', paneId: p.paneId })
  )
}

/* ── window + tray ───────────────────────────────────────────── */

let tray: Tray | null = null

// w10/identity — one packaged-safe source for the window and tray brand icon.
function appIconPath(): string {
  return join(app.getAppPath(), 'resources', 'icon.png')
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 940,
    minHeight: 600,
    show: false,
    icon: appIconPath(),
    backgroundColor: '#26241E', // graphite base — matches the design tokens
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#2E2B24', symbolColor: '#EEE6D9', height: 38 },
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false
    }
  })

  win.on('ready-to-show', () => win.show())

  win.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e) => e.preventDefault())

  win.webContents.on('did-finish-load', () => wirePtyPort(win)) // covers reloads too

  win.on('closed', () => {
    // window gone, PTYs stay alive (tray-resident); unclog host flow control
    ptyHost?.postMessage({ type: 'renderer-gone' })
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }
  return win
}

function openOrFocusWindow(): void {
  const win = BrowserWindow.getAllWindows()[0]
  if (win) {
    if (win.isMinimized()) win.restore()
    win.focus()
  } else {
    createWindow()
  }
}

function brandTrayIcon(): Electron.NativeImage {
  // w10/identity — Windows' notification area is 16px; other platforms prefer 32px.
  const size = process.platform === 'win32' ? 16 : 32
  return nativeImage.createFromPath(appIconPath()).resize({ width: size, height: size })
}

function createTray(): void {
  tray = new Tray(brandTrayIcon())
  tray.setToolTip('Morz — terminals keep running here')
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Open Morz', click: openOrFocusWindow },
      { type: 'separator' },
      { label: 'Quit (stops all terminals)', click: () => app.quit() }
    ])
  )
  tray.on('click', openOrFocusWindow)
}

/* ── shutdown ────────────────────────────────────────────────── */

function shutdownHost(): Promise<void> {
  return new Promise((resolve) => {
    const host = ptyHost
    if (!host) return resolve()
    const timer = setTimeout(() => {
      host.kill()
      resolve()
    }, 3_000)
    host.once('exit', () => {
      clearTimeout(timer)
      resolve()
    })
    host.postMessage({ type: 'shutdown' })
  })
}

/* ── smoke test (MORZ_SMOKE=1) — headless backend check ──────── */

function runSmoke(): void {
  let done = false
  let stage = 0 // 0=echo 1=npm-on-PATH 2=reattach
  const finish = (ok: boolean, why: string): void => {
    if (done) return
    done = true
    smokeDataTap = null
    console.log(ok ? `[smoke] PASS — ${why}` : `[smoke] FAIL at stage ${stage} — ${why}`)
    hostRequest('kill', { paneId: 'smoke' })
      .catch(() => {})
      .finally(() => app.quit())
  }
  setTimeout(() => finish(false, 'timeout'), 40_000)

  // PTY output relays through main via smokeDataTap (see the host 'pty' handler)
  let buffer = ''
  let replay = ''
  smokeDataTap = (_paneId, data) => {
    if (stage < 2) {
      buffer += data
      if (stage === 0 && buffer.includes('MORZ_SMOKE_OK_4')) {
        stage = 1
        console.log('[smoke] stage 0 ok: pwsh spawned, bytes flowed both ways')
        ptyHost?.postMessage({
          type: 'write',
          paneId: 'smoke',
          data: '"MORZ_NPM_$($null -ne (Get-Command npm -ErrorAction SilentlyContinue))"\r'
        })
      } else if (stage === 1 && buffer.includes('MORZ_NPM_True')) {
        stage = 2
        console.log('[smoke] stage 1 ok: npm resolves on real PATH')
        // simulate reopen: request scrollback replay and expect the prompt back
        hostRequest<string[]>('list')
          .then((ids) => {
            if (!ids.includes('smoke')) return finish(false, `list() = ${JSON.stringify(ids)}`)
            ptyHost?.postMessage({ type: 'attach', paneId: 'smoke' })
          })
          .catch((e) => finish(false, e.message))
      }
    } else {
      replay += data
      if (replay.includes('MORZ_SMOKE_OK_4')) {
        finish(true, 'echo + PATH + reattach scrollback replay all good')
      }
    }
  }

  hostRequest<{ ok: boolean; error?: string }>('spawn', {
    paneId: 'smoke',
    shell: 'pwsh',
    cols: 100,
    rows: 30
  } satisfies TerminalSpawnOpts)
    .then((r) => {
      if (!r.ok) return finish(false, r.error ?? 'spawn failed')
      setTimeout(() => {
        ptyHost?.postMessage({ type: 'write', paneId: 'smoke', data: '"MORZ_SMOKE_OK_$(2+2)"\r' })
      }, 3_000)
    })
    .catch((e) => finish(false, e.message))
}

/* ── bus pipe server (w4/mcp) ────────────────────────────────── */

/* Nonce+token minted per run; children reach the bus via env — buildChildEnv
 * copies process.env into every PTY child and utilityProcess.fork inherits it,
 * so setting process.env BEFORE startPtyHost() covers all spawn paths. */
let busServer: BusPipeServer | null = null

function startBus(): void {
  try {
    busServer = startPipeServer({
      handlers: createToolHandlers({
        board: new SqliteBoardPort(), // real board: SQLite task board + Maildir mailbox
        openFile: (evt) => {
          for (const win of BrowserWindow.getAllWindows()) {
            if (!win.isDestroyed()) win.webContents.send(BUS_OPEN_FILE_CHANNEL, evt)
          }
        }
      })
    })
    process.env.MORZ_BUS_PIPE = busServer.pipePath
    process.env.MORZ_BUS_TOKEN = busServer.token
    busServer.ready.catch((e) => console.error('[morz] bus pipe failed to listen:', e))
  } catch (e) {
    console.error('[morz] bus pipe server failed to start:', e)
  }
}

/* ── app lifecycle ───────────────────────────────────────────── */

app.whenReady().then(() => {
  Menu.setApplicationMenu(null) // w10/identity — app shortcuts are renderer key listeners.
  sweepOrphans()
  startBus()
  registerPtyIpc()
  registerSessionIpc()
  registerFileIpc(ipcMain)
  registerFsIpc(ipcMain)
  registerGitIpc()
  registerEditorIpc(ipcMain)
  registerClaudeIpc()
  registerHandoffIpc() // w4/handoff — handlers only; nothing runs until Assisted UI calls
  startPtyHost()

  if (process.env['MORZ_SMOKE']) {
    runSmoke()
    return
  }

  createTray()
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// tray-resident: closing the last window does NOT quit — PTYs keep running
app.on('window-all-closed', () => {
  if (process.env['MORZ_SMOKE']) app.quit()
})

app.on('before-quit', (e) => {
  if (shuttingDown) return
  shuttingDown = true
  e.preventDefault()
  tray?.destroy()
  // host killAll reaps every child tree; pane-exit messages already pruned the
  // journal for panes that died, and sweepOrphans() next run covers the rest
  void shutdownHost().then(() => app.exit(0))
})

/* ── w4/bus: agent bus — task board + mailbox + lease sweeper ── */
// import hoists; registration chains onto whenReady after the block above
import { registerBusIpc } from './bus'
app.whenReady().then(() => registerBusIpc())

// w4/workshop
import { registerCatalogIpc } from './services/catalog'

registerCatalogIpc()
// w4/config
import { registerConfigWriterIpc } from './services/config-writer'
app.whenReady().then(() => registerConfigWriterIpc(ipcMain))
// w4/obsidian
import { registerObsidianIpc } from './services/obsidian'
app.whenReady().then(() => registerObsidianIpc(ipcMain))
// w4/organizer
import { registerOrganizerIpc } from './organizer'
registerOrganizerIpc(ipcMain)

/* ── w5/dispatch: dispatcher — approved SpawnPlan → worktrees + $PORT +
 * visible PTY panes, with global Stop + cleanup. The PTY bridge is injected
 * because hostRequest/ptyHost live in this module. ── */
import { registerDispatchIpc, approvePlan, dispatch as dispatchPlan } from './orchestrator/dispatcher'
import { RunApi } from '../shared/ipc'
import type { RunStatus } from '../shared/spawn-plan'
app.whenReady().then(() =>
  registerDispatchIpc(ipcMain, {
    spawnPane: (opts) => hostRequest<{ ok: boolean; error?: string }>('spawn', opts),
    writePane: (paneId, data) => ptyHost?.postMessage({ type: 'write', paneId, data }),
    killPane: (paneId) => hostRequest('kill', { paneId }).catch(() => undefined),
    listPanes: () => hostRequest<string[]>('list'),
    push: (status: RunStatus) => {
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) win.webContents.send(RunApi.changed, status)
      }
    }
  })
)
// end w5/dispatch

// w5/planner — inject the REAL dispatcher (integration): "Approve & Run" both
// registers the plan in the dispatcher's approved store and dispatches it, so
// the two separate approval stores can't drift. Planner's own store still
// gates the UI (DRAFT/PROPOSED/APPROVED); the dispatcher's store guards spawn.
import { registerPlannerIpc } from './orchestrator/planner'
app.whenReady().then(() =>
  registerPlannerIpc({
    dispatch: async (plan) => {
      approvePlan(plan) // stamp+store in the dispatcher's approved-plan store
      return dispatchPlan(plan) // re-hash + verify + spawn the visible team
    }
  })
)
// w5/reviewer
import { registerReviewerIpc } from './reviewer/reviewer'
app.whenReady().then(() => registerReviewerIpc())
// w5/dag
import { registerDodIpc } from './orchestrator/dod'
app.whenReady().then(() => registerDodIpc())
// w5/commit
import { registerCommitIpc } from './services/commit-service'
app.whenReady().then(() => registerCommitIpc(ipcMain))
// w5/cost
import { registerCostMeterIpc } from './orchestrator/cost-meter'
app.whenReady().then(() => registerCostMeterIpc())

// w6/errors
registerNotifyCenter()
// end w6/errors
// w6/assistant — APPEND-ONLY: optional assistant proposal source
import { registerAssistantIpc } from './assistant/bridge'
app.whenReady().then(() => registerAssistantIpc())
// w6/pulse — append-only Daily Pulse registration and native-notification open path.
import { registerPulseIpc } from './services/pulse'
import { PulseApi as PulseChannels, type PulseBrief } from '../shared/ipc'
app.whenReady().then(() =>
  registerPulseIpc({
    openBrief: (brief: PulseBrief) => {
      let win = BrowserWindow.getAllWindows()[0]
      if (!win) win = createWindow()
      if (win.isMinimized()) win.restore()
      win.show()
      win.focus()
      const push = (): void => win.webContents.send(PulseChannels.open, brief)
      if (win.webContents.isLoading()) win.webContents.once('did-finish-load', push)
      else push()
    }
  })
)

// w8/memory-core — append-only learning-memory registration
import { registerMemoryIpc } from './memory'
app.whenReady().then(() => registerMemoryIpc())
// w8/routing — append-only routing registration and consult registry seam.
import { configureConsultAdapters } from './bus/tool-handlers'
import { getAdapter, installE2eConsultStub } from './adapters/registry'
import { registerRoutingIpc } from './routing/rules'

installE2eConsultStub()
configureConsultAdapters(
  (brain) => getAdapter(brain),
  (brain) => notify({
    id: `adapter:consult:${brain}`,
    level: 'error',
    source: 'adapter',
    title: `${brain} consult failed`,
    detail: 'The one-shot consult failed or timed out. Check the target brain configuration.'
  })
)
app.whenReady().then(() => registerRoutingIpc())
// end w8/routing
// w8/voice — append-only local Whisper registration.
import { registerVoiceIpc } from './services/voice'
app.whenReady().then(() => registerVoiceIpc())

// w9/spaces — append-only native folder picker registration.
import { registerDialogIpc } from './services/dialog-service'
app.whenReady().then(() => registerDialogIpc(ipcMain))
// end w9/spaces
// w9/browser — append-only WebContentsView + CDP browser registration.
import { registerBrowserIpc } from './services/browser-host'
app.whenReady().then(() => registerBrowserIpc())
// end w9/browser
// w9/installer
import { registerUpdater } from './services/updater'
app.whenReady().then(() => {
  registerUpdater()
  tray?.setToolTip(`Morz ${app.getVersion()} — terminals keep running here`)
})

// w11/connections — append-only CLI detection and usage registration.
import { registerConnectionsIpc } from './services/connections'
app.whenReady().then(() => registerConnectionsIpc())
// w11/report-engine — append-only configurable AI report registration.
import { registerReportIpc } from './services/report-engine'
app.whenReady().then(() => registerReportIpc())
// w11/commit-ai — append-only read-only commit intelligence registration.
import { registerCommitAiIpc } from './services/commit-service'
app.whenReady().then(() => registerCommitAiIpc(ipcMain))
// end w11/commit-ai
// w11/sessions — append-only per-project work-session history registration.
import { registerSessionsIpc } from './services/sessions'
app.whenReady().then(() => registerSessionsIpc())
// end w11/sessions

// w12/orch-engine — append-only persisted planner engine registration.
import { registerPlannerEngineIpc } from './orchestrator/planner'
app.whenReady().then(() => registerPlannerEngineIpc())
// end w12/orch-engine
