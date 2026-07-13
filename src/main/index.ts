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
import { spawnSync } from 'child_process'
import { PtyApi, type TerminalSpawnOpts } from '../shared/ipc'
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

/* ── PTY-host supervisor ─────────────────────────────────────── */

interface SpawnJournal {
  paneId: string
  pid: number
  shell: string
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

function registerPtyIpc(): void {
  ipcMain.handle(PtyApi.spawn, (_e, opts: TerminalSpawnOpts) => hostRequest('spawn', opts))
  ipcMain.handle(PtyApi.list, () => hostRequest<string[]>('list'))
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

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 940,
    minHeight: 600,
    show: false,
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

function bronzeTrayIcon(): Electron.NativeImage {
  // 16x16 bronze square (BGRA) — placeholder until real brand assets land
  const size = 16
  const buf = Buffer.alloc(size * size * 4)
  for (let i = 0; i < size * size; i++) buf.writeUInt32LE(0xffb08d57, i * 4) // A R G B → LE bytes B,G,R,A
  return nativeImage.createFromBitmap(buf, { width: size, height: size })
}

function createTray(): void {
  tray = new Tray(bronzeTrayIcon())
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

/* ── app lifecycle ───────────────────────────────────────────── */

app.whenReady().then(() => {
  sweepOrphans()
  registerPtyIpc()
  registerSessionIpc()
  registerFileIpc(ipcMain)
  registerFsIpc(ipcMain)
  registerGitIpc()
  registerEditorIpc(ipcMain)
  registerClaudeIpc()
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
