/*
 * E2E harness helpers — launch/teardown for the built Morz Electron app.
 *
 * Terminal I/O is asserted through the preload bridge (window.morz.pty), not
 * the xterm DOM: the WebGL renderer paints to a canvas, so on-screen text is
 * not in the DOM. A collector subscribes to pty.onData in the page and
 * accumulates raw PTY bytes per pane; specs regex-match that buffer and write
 * keystrokes via pty.write. The xterm mount itself is asserted separately.
 *
 * Morz is tray-resident: closing the last window does NOT quit the app, and
 * app.quit() can hang if the PTY-host is wedged — teardown always ends with
 * taskkill /T /F on the Electron PID.
 */
import { _electron, type ElectronApplication, type Page } from '@playwright/test'
import { spawnSync } from 'child_process'
import { existsSync, mkdirSync } from 'fs'
import { join } from 'path'

export const ROOT = join(__dirname, '..')
const MAIN_JS = join(ROOT, 'out', 'main', 'index.js')
// explicit exe: require('electron') needs path.txt, which the shared
// node_modules junction lacks (postinstall scripts gated by allowScripts)
const ELECTRON_EXE = join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')

/** Default panes the shell hydrates on a fresh launch (layoutStore DEFAULT_PANES). */
export const PANE_1 = 'term-1'
export const PANE_2 = 'term-2'

/** pwsh/powershell prompt, or a bash-ish WSL prompt. */
export const PROMPT_RE = /PS [^\r\n]*>|\w+@[\w.-]+:[^\r\n]*[$#]/

export interface MorzApp {
  app: ElectronApplication
  page: Page
  /** Isolated %APPDATA% used by this launch (morz.db lives under it). */
  appDataDir: string
}

let launchSeq = 0

/**
 * Launch the built app with an isolated APPDATA so tests never touch the
 * user's real %APPDATA%\Morz\morz.db. Pass a previous appDataDir to relaunch
 * against the same store (session-restore scenarios).
 *
 * w15/modules-core — MORZ_MODULES seeds the module enabled-map on a FRESH
 * profile ('all' | 'none' | 'defaults' | CSV of module ids). The harness
 * defaults to 'all' so pre-wave specs keep their surfaces; modules.spec passes
 * its own seed via opts.env. Persisted rows always win over the seed.
 */
export async function launchMorz(opts?: {
  appDataDir?: string
  env?: Record<string, string>
  /** false = leave the first-run wizard up for the spec to drive. */
  skipOnboarding?: boolean
  /** false = leave the launcher up for the spec to drive. */
  skipStartScreen?: boolean
  /** true = same as skipStartScreen:false (start-screen.spec's spelling). */
  showStartScreen?: boolean
}): Promise<MorzApp> {
  if (!existsSync(MAIN_JS)) {
    throw new Error(`Missing ${MAIN_JS} — run \`npm run build\` before the E2E suite.`)
  }
  const appDataDir =
    opts?.appDataDir ?? join(ROOT, 'e2e', '.tmp', `appdata-${Date.now()}-${launchSeq++}`)
  mkdirSync(appDataDir, { recursive: true })

  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
  delete env['ELECTRON_RENDERER_URL'] // force the packaged renderer, never a dev server
  // APPDATA env alone does NOT redirect Electron's appData (Windows shell API
  // resolves it) — MORZ_USER_DATA is the main-process isolation hook.
  env['APPDATA'] = appDataDir
  env['MORZ_USER_DATA'] = appDataDir
  Object.assign(env, opts?.env)
  env['MORZ_MODULES'] ??= 'all' // w15/modules-core (see doc comment above)
  // w15/start-screen — legacy specs seed their own layout and expect the shell;
  // the launcher would replace that layout with fresh panes. Specs that drive
  // the launcher pass showStartScreen and opt back in.
  if (opts?.showStartScreen !== true && opts?.skipStartScreen !== false) {
    env['MORZ_START_SCREEN'] ??= 'off'
  }

  const app = await _electron.launch({
    executablePath: ELECTRON_EXE,
    args: [ROOT],
    cwd: ROOT,
    env
  })
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0]
    win?.show()
    win?.focus()
  })
  await page.bringToFront()
  await installCollector(page)
  // w15 integration — a fresh profile now boots through TWO gates before the
  // shell: the first-run wizard (w15/onboarding) and the launcher
  // (w15/start-screen, shown whenever there is no restorable session). Specs
  // that assert shell surfaces get walked past both; first-run.spec and
  // start-screen.spec opt out to drive the gates themselves.
  if (opts?.skipOnboarding !== false) {
    await passOnboarding(page)
  }
  if (opts?.skipStartScreen !== false && opts?.showStartScreen !== true) {
    await passStartScreen(page)
  }
  return { app, page, appDataDir }
}

/**
 * Accept the first-run wizard as pre-seeded, if it is showing. The wizard
 * mirrors the module registry (MORZ_MODULES seeds it), so the harness must NOT
 * flip toggles — doing so would overwrite a spec's own module seed.
 */
async function passOnboarding(page: Page): Promise<void> {
  const setup = page.getByRole('heading', { name: 'Make Morz yours' })
  if (!(await setup.isVisible().catch(() => false))) {
    await setup.waitFor({ state: 'visible', timeout: 8_000 }).catch(() => undefined)
  }
  if (!(await setup.isVisible().catch(() => false))) return
  await page.getByRole('button', { name: 'Open Morz' }).click()
  await setup.waitFor({ state: 'hidden', timeout: 15_000 }).catch(() => undefined)
}

/** Enter the shell from the launcher (plain shell, no agent), if it is showing. */
export async function passStartScreen(page: Page): Promise<void> {
  const start = page.getByTestId('start-screen')
  if (!(await start.isVisible().catch(() => false))) {
    await start.waitFor({ state: 'visible', timeout: 8_000 }).catch(() => undefined)
  }
  if (!(await start.isVisible().catch(() => false))) return
  await page.getByTestId('start-launch').click()
  await start.waitFor({ state: 'detached', timeout: 15_000 }).catch(() => undefined)
}

/** Quit gracefully (before-quit → PTY-host shutdown), then hard-kill the tree. */
export async function closeMorz(app: ElectronApplication): Promise<void> {
  let pid: number | undefined
  try {
    pid = app.process().pid
  } catch {
    return // already closed (idempotent — specs + afterAll may both call this)
  }
  try {
    await Promise.race([
      app.evaluate(({ app: a }) => a.quit()),
      new Promise((r) => setTimeout(r, 5_000))
    ])
  } catch {
    /* window/app already gone */
  }
  try {
    await Promise.race([app.close(), new Promise((r) => setTimeout(r, 5_000))])
  } catch {
    /* close can throw once the process is dead */
  }
  if (pid) {
    // tray-resident fallback + reaps any straggler conhost/pwsh children
    spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, timeout: 15_000 })
  }
}

/** Subscribe to PTY output in the page; bytes accumulate in window.__morzBuf[paneId]. */
export async function installCollector(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as {
      __morzBuf?: Record<string, string>
      __morzCollector?: boolean
      morz: { pty: { onData(cb: (m: { paneId: string; data?: string }) => void): void } }
    }
    if (w.__morzCollector) return
    w.__morzCollector = true
    w.__morzBuf = {}
    w.morz.pty.onData((m) => {
      if (typeof m.data === 'string') {
        w.__morzBuf![m.paneId] = (w.__morzBuf![m.paneId] ?? '') + m.data
      }
    })
  })
}

/** Everything the pane has emitted since the collector was installed. */
export function termText(page: Page, paneId: string): Promise<string> {
  return page.evaluate(
    (id) => ((window as unknown as { __morzBuf?: Record<string, string> }).__morzBuf?.[id] ?? ''),
    paneId
  )
}

/** Wait until the pane's accumulated output matches `pattern`; returns the buffer. */
export async function waitForTerm(
  page: Page,
  paneId: string,
  pattern: RegExp,
  timeout = 60_000
): Promise<string> {
  await page.waitForFunction(
    ({ id, source, flags }) => {
      const buf =
        (window as unknown as { __morzBuf?: Record<string, string> }).__morzBuf?.[id] ?? ''
      return new RegExp(source, flags).test(buf)
    },
    { id: paneId, source: pattern.source, flags: pattern.flags },
    { timeout, polling: 250 }
  )
  return termText(page, paneId)
}

/** Send keystrokes to a pane through the real write path (renderer → main → host). */
export function writePane(page: Page, paneId: string, data: string): Promise<void> {
  return page.evaluate(
    ({ id, d }) =>
      (window as unknown as { morz: { pty: { write(p: string, x: string): void } } }).morz.pty.write(
        id,
        d
      ),
    { id: paneId, d: data }
  )
}

/** Type a line + Enter. */
export function runInPane(page: Page, paneId: string, command: string): Promise<void> {
  return writePane(page, paneId, `${command}\r`)
}

/** Ask the PTY-host to replay a pane's scrollback (reattach path). */
export function attachPane(page: Page, paneId: string): Promise<void> {
  return page.evaluate(
    (id) =>
      (window as unknown as { morz: { pty: { attach(p: string): void } } }).morz.pty.attach(id),
    paneId
  )
}

/** Live pane ids as the PTY-host sees them. */
export function listPanes(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    (window as unknown as { morz: { pty: { list(): Promise<string[]> } } }).morz.pty.list()
  )
}

/**
 * Close the (only) window from the main process and wait for it to be gone.
 * The app stays alive in the tray; PTYs keep running.
 */
export async function closeWindow(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ BrowserWindow }) => {
    for (const w of BrowserWindow.getAllWindows()) w.close()
  })
  await app.evaluate(
    ({ BrowserWindow }) =>
      new Promise<void>((resolve) => {
        const tick = (): void => {
          if (BrowserWindow.getAllWindows().length === 0) resolve()
          else setTimeout(tick, 100)
        }
        tick()
      })
  )
}

/** Reopen a window on the tray-resident app (main listens for 'activate'). */
export async function reopenWindow(app: ElectronApplication): Promise<Page> {
  const winPromise = app.waitForEvent('window')
  await app.evaluate(({ app: a }) => a.emit('activate'))
  const page = await winPromise
  await page.waitForLoadState('domcontentloaded')
  await installCollector(page)
  return page
}
