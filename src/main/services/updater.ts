import { app, BrowserWindow, ipcMain, net } from 'electron'
import { autoUpdater, type ProgressInfo, type UpdateDownloadedEvent, type UpdateInfo } from 'electron-updater'
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import {
  UpdaterApi,
  type UpdaterSnapshot,
  type UpdaterStatus
} from '../../shared/ipc'
import { notify, registerNotifyAction } from './notify-center'

const BOOT_CHECK_DELAY_MS = 30_000
const RESTART_ACTION = 'restart-update'
const UPDATE_OWNER = 'orlrami'
const UPDATE_REPO = 'morz'

// Capture the private-feed credential before any PTY/utility process inherits
// process.env, then remove it from the environment shared with terminal children.
const updateToken = process.env.MORZ_UPDATE_TOKEN?.trim() || null
delete process.env.MORZ_UPDATE_TOKEN

let registered = false
let activated = false
let bootTimer: NodeJS.Timeout | null = null
let visibilityCheck: Promise<boolean> | null = null

function e2eFeedUrl(): string | null {
  if (process.env.MORZ_E2E !== '1') return null
  const value = process.env.MORZ_UPDATE_FEED_URL?.trim()
  if (!value) return null
  try {
    const url = new URL(value)
    if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '::1'].includes(url.hostname)) return null
    return url.toString().replace(/\/$/, '')
  } catch {
    return null
  }
}

function updaterEnabled(): boolean {
  return Boolean(e2eFeedUrl() || updateToken || process.env.MORZ_UPDATE_PUBLIC === '1')
}

function disabledDetail(): string {
  return 'Updates are off while the GitHub repository is private and no MORZ_UPDATE_TOKEN is configured.'
}

function safeErrorDetail(value: unknown): string {
  const raw = value instanceof Error ? value.message : 'The update service is unavailable.'
  return raw
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
    .replace(/\b(token|authorization)\s*[:=]\s*[^\s,;]+/gi, '$1=[redacted]')
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
    .slice(0, 300) || 'The update service is unavailable.'
}

function initialSnapshot(): UpdaterSnapshot {
  const enabled = updaterEnabled()
  return {
    version: app.getVersion(),
    channel: 'stable',
    enabled,
    status: enabled ? 'idle' : 'disabled',
    detail: enabled ? 'Morz will check for stable updates.' : disabledDetail()
  }
}

let snapshot = initialSnapshot()

function publish(patch: Partial<UpdaterSnapshot>): UpdaterSnapshot {
  snapshot = { ...snapshot, ...patch }
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send(UpdaterApi.changed, snapshot)
  }
  return snapshot
}

function setStatus(status: UpdaterStatus, detail: string, patch: Partial<UpdaterSnapshot> = {}): void {
  publish({ status, detail, ...patch })
}

function onUpdateAvailable(info: UpdateInfo): void {
  setStatus('available', `Morz ${info.version} is available and will download in the background.`, {
    availableVersion: info.version,
    progress: 0
  })
  notify({
    id: 'app:update-available',
    level: 'info',
    source: 'app',
    title: `Morz ${info.version} is available`,
    detail: 'The update is downloading in the background.'
  })
}

function onDownloadProgress(info: ProgressInfo): void {
  const progress = Math.max(0, Math.min(100, Math.round(info.percent)))
  setStatus('downloading', `Downloading Morz ${snapshot.availableVersion ?? 'update'}: ${progress}%`, {
    progress
  })
  notify({
    id: 'app:update-downloading',
    level: 'info',
    source: 'app',
    title: 'Downloading Morz update',
    detail: `${progress}% complete.`
  })
}

function onUpdateDownloaded(info: UpdateDownloadedEvent): void {
  setStatus('ready', `Morz ${info.version} is ready. Restart to finish updating.`, {
    availableVersion: info.version,
    progress: 100
  })
  notify({
    id: 'app:update-ready',
    level: 'success',
    source: 'app',
    title: `Morz ${info.version} is ready`,
    detail: 'Restart Morz to install the downloaded update.',
    actions: [{ id: RESTART_ACTION, label: 'Restart to update' }]
  })
}

function onUpdaterError(error: Error): void {
  const detail = safeErrorDetail(error)
  setStatus('error', detail)
  notify({
    id: 'app:update-error',
    level: 'warning',
    source: 'app',
    title: 'Update check unavailable',
    detail
  })
}

async function checkForUpdates(): Promise<UpdaterSnapshot> {
  if (!snapshot.enabled && !(await enableWhenRepositoryIsPublic())) return snapshot
  try {
    await autoUpdater.checkForUpdates()
  } catch (error) {
    if (snapshot.status !== 'error') onUpdaterError(error instanceof Error ? error : new Error(String(error)))
  }
  return snapshot
}

async function repositoryIsPublic(): Promise<boolean> {
  if (process.env.MORZ_E2E === '1') return false
  if (process.env.MORZ_UPDATE_PUBLIC === '1') return true
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 5_000)
  try {
    const response = await net.fetch(`https://api.github.com/repos/${UPDATE_OWNER}/${UPDATE_REPO}`, {
      headers: { accept: 'application/vnd.github+json' },
      signal: controller.signal
    })
    await response.body?.cancel()
    return response.status === 200
  } catch {
    return false
  } finally {
    clearTimeout(timeout)
  }
}

function enableWhenRepositoryIsPublic(): Promise<boolean> {
  if (snapshot.enabled) return Promise.resolve(true)
  if (visibilityCheck) return visibilityCheck
  visibilityCheck = repositoryIsPublic().then((isPublic) => {
    if (!isPublic) return false
    publish({
      enabled: true,
      status: 'idle',
      detail: 'Morz will check GitHub for stable updates.'
    })
    activateUpdater()
    return true
  }).finally(() => {
    visibilityCheck = null
  })
  return visibilityCheck
}

function configureFeed(): void {
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = false
  autoUpdater.disableDifferentialDownload = false
  autoUpdater.allowPrerelease = false

  const testFeed = e2eFeedUrl()
  if (testFeed) {
    const configPath = join(app.getPath('userData'), 'e2e-app-update.yml')
    mkdirSync(app.getPath('userData'), { recursive: true })
    writeFileSync(
      configPath,
      `provider: generic\nurl: ${JSON.stringify(testFeed)}\nupdaterCacheDirName: morz-updater-e2e\n`,
      { encoding: 'utf8', mode: 0o600 }
    )
    autoUpdater.forceDevUpdateConfig = true
    autoUpdater.updateConfigPath = configPath
    autoUpdater.setFeedURL({
      provider: 'generic',
      url: testFeed,
      channel: 'latest',
      useMultipleRangeRequest: false
    })
    return
  }
  if (updateToken) {
    autoUpdater.setFeedURL({
      provider: 'github',
      owner: UPDATE_OWNER,
      repo: UPDATE_REPO,
      private: true,
      token: updateToken
    })
  }
}

function activateUpdater(): void {
  if (activated) return
  activated = true
  configureFeed()
  autoUpdater.on('checking-for-update', () => setStatus('checking', 'Checking for a Morz update.'))
  autoUpdater.on('update-available', onUpdateAvailable)
  autoUpdater.on('download-progress', onDownloadProgress)
  autoUpdater.on('update-downloaded', onUpdateDownloaded)
  autoUpdater.on('update-not-available', () => {
    setStatus('up-to-date', 'Morz is up to date.', { availableVersion: undefined, progress: undefined })
  })
  autoUpdater.on('error', onUpdaterError)

  registerNotifyAction(RESTART_ACTION, () => {
    if (snapshot.status === 'ready') autoUpdater.quitAndInstall()
  })
}

export function registerUpdater(): void {
  if (registered) return
  registered = true
  snapshot = initialSnapshot()

  ipcMain.handle(UpdaterApi.status, () => snapshot)
  ipcMain.handle(UpdaterApi.check, () => checkForUpdates())
  if (snapshot.enabled) activateUpdater()

  bootTimer = setTimeout(() => {
    bootTimer = null
    void checkForUpdates()
  }, BOOT_CHECK_DELAY_MS)
  bootTimer.unref()
  app.once('before-quit', () => {
    if (bootTimer) clearTimeout(bootTimer)
    bootTimer = null
  })
}
