import { randomUUID } from 'node:crypto'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { dirname, extname, isAbsolute, join, resolve } from 'node:path'
import {
  app,
  BrowserView,
  BrowserWindow,
  ipcMain,
  safeStorage,
  session
} from 'electron'
import {
  AssistantApi,
  type AssistantConnectionStatus,
  type AssistantProvider,
  type StoredSpawnPlan
} from '../../shared/ipc'
import { extractSpawnPlanBlock, planGoal } from '../orchestrator/planner'
import { PlanStore } from '../orchestrator/plan-store'
import {
  assistantProviderRegistry,
  publicAssistantProvider,
  type AssistantProviderDescriptor,
  type HostedAssistantProvider,
  type LocalAssistantProvider
} from './providers'

const MAX_GOAL_CHARS = 4_000
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024
const HANDSHAKE_TIMEOUT_MS = 20_000
const PROPOSAL_TIMEOUT_MS = 120_000
const HOSTED_LOGIN_TIMEOUT_MS = 5 * 60_000
const MAX_HOSTED_RESPONSE_ELEMENTS = 40
const MAX_HOSTED_RESPONSE_CHARS = 256_000

interface ProcessResult {
  stdout: string
}

interface ProcessOptions {
  input?: string
  cwd?: string
  forceNoShell?: boolean
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function messageOf(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason)
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function terminateProcessTree(child: ChildProcess): void {
  if (!child.pid) return
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
      windowsHide: true,
      shell: false,
      stdio: 'ignore'
    })
  } else {
    try {
      process.kill(-child.pid, 'SIGKILL')
    } catch {
      child.kill('SIGKILL')
    }
  }
}

function windowsCommandPaths(command: string): string[] {
  if (!/^[a-zA-Z0-9_.-]{1,128}$/.test(command)) return []
  try {
    return execFileSync('where.exe', [command], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 5_000
    })
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
  } catch {
    return []
  }
}

function resolveNpmEntrypoint(shimPath: string, command: string): { command: string; prefixArgs: string[] } {
  const packageRoot = join(dirname(shimPath), 'node_modules', command)
  const manifestPath = join(packageRoot, 'package.json')
  if (!existsSync(manifestPath)) {
    throw new Error(`${command} uses a batch shim without a resolvable npm package`)
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as unknown
  if (!isPlainObject(manifest)) throw new Error(`${command} has an invalid npm package manifest`)
  const binValue = manifest.bin
  const relativeBin =
    typeof binValue === 'string'
      ? binValue
      : isPlainObject(binValue) && typeof binValue[command] === 'string'
        ? binValue[command]
        : null
  if (!relativeBin) throw new Error(`${command} npm package does not declare its CLI entrypoint`)
  const entrypoint = resolve(packageRoot, relativeBin)
  const normalizedRoot = `${resolve(packageRoot).toLowerCase()}${process.platform === 'win32' ? '\\' : '/'}`
  if (!entrypoint.toLowerCase().startsWith(normalizedRoot) || !existsSync(entrypoint)) {
    throw new Error(`${command} npm entrypoint escaped its package or does not exist`)
  }
  const nodePath = windowsCommandPaths('node.exe').find((path) => extname(path).toLowerCase() === '.exe')
  if (!nodePath) throw new Error('Node.js executable was not found for the npm assistant CLI')
  return { command: nodePath, prefixArgs: [entrypoint] }
}

function resolveWindowsArgumentCommand(command: string): { command: string; prefixArgs: string[] } {
  const paths = windowsCommandPaths(command)
  const native = paths.find((path) => ['.exe', '.com'].includes(extname(path).toLowerCase()))
  if (native) return { command: native, prefixArgs: [] }
  const shim = paths.find((path) => ['.cmd', '.bat'].includes(extname(path).toLowerCase()))
  if (shim) return resolveNpmEntrypoint(shim, command)
  throw new Error(`${command} did not resolve to a native executable or verified npm entrypoint`)
}

function assistantTempDir(): string {
  return join(app.getPath('appData'), 'Morz', 'assistant-tmp')
}

function clearStalePromptFiles(): void {
  const directory = assistantTempDir()
  if (!existsSync(directory)) return
  for (const name of readdirSync(directory)) {
    if (/^[a-f0-9-]{36}\.txt$/.test(name)) {
      try {
        unlinkSync(join(directory, name))
      } catch {
        // A live process may still own it; the next startup will retry.
      }
    }
  }
}

function isAllowedHostedUrl(rawUrl: string, provider: HostedAssistantProvider): boolean {
  try {
    const url = new URL(rawUrl)
    return url.protocol === 'https:' && provider.allowedHosts.includes(url.hostname.toLowerCase())
  } catch {
    return false
  }
}

function exactPlanString(value: unknown, depth = 0): string | null {
  if (depth > 8) return null
  if (typeof value === 'string') {
    try {
      extractSpawnPlanBlock(value)
      return value
    } catch {
      return null
    }
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = exactPlanString(item, depth + 1)
      if (found) return found
    }
    return null
  }
  if (isPlainObject(value)) {
    for (const item of Object.values(value)) {
      const found = exactPlanString(item, depth + 1)
      if (found) return found
    }
  }
  return null
}

function normalizeProviderOutput(stdout: string, provider: LocalAssistantProvider): string {
  const trimmed = stdout.trim()
  if (provider.output === 'text') return trimmed
  try {
    const found = exactPlanString(JSON.parse(trimmed) as unknown)
    if (found) return found
  } catch (error) {
    throw new Error(`Assistant emitted invalid JSON: ${messageOf(error)}`)
  }
  throw new Error('Assistant JSON did not contain an exact SpawnPlan response')
}

function plannerPromptValue(prompt: string, field: string): string {
  const match = prompt.match(new RegExp(`^- ${field}: exactly (.+)$`, 'm'))
  if (!match) throw new Error(`Stub could not read ${field}`)
  return JSON.parse(match[1]) as string
}

function stubPlanResponse(prompt: string): string {
  const id = plannerPromptValue(prompt, 'id')
  const goal = plannerPromptValue(prompt, 'goal')
  const spaceRoot = plannerPromptValue(prompt, 'spaceRoot')
  const createdAt = plannerPromptValue(prompt, 'createdAt')
  return `\`\`\`json\n${JSON.stringify({
    version: '1.0',
    id,
    goal,
    agents: [
      {
        agentId: 'assistant-builder',
        cli: 'codex',
        role: 'Assistant-proposed builder',
        branch: `run/assistant/${id.slice(0, 8)}`,
        worktree: null,
        cwd: '',
        promptSeed: `Complete the goal safely and verify the result: ${goal}`,
        dependsOn: [],
        port: null
      }
    ],
    spaceRoot,
    caps: { maxUsd: null, maxTokens: null },
    createdAt,
    planHash: '0'.repeat(64)
  })}\n\`\`\``
}

class EncryptedConnectionStore {
  constructor(private readonly path: string) {}

  load(): string | null {
    if (!existsSync(this.path) || !safeStorage.isEncryptionAvailable()) return null
    try {
      const encrypted = Buffer.from(readFileSync(this.path, 'utf8'), 'base64')
      const value = JSON.parse(safeStorage.decryptString(encrypted)) as unknown
      return isPlainObject(value) && typeof value.providerId === 'string' ? value.providerId : null
    } catch {
      return null
    }
  }

  save(providerId: string): void {
    if (process.env.MORZ_E2E === '1') return
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('OS-backed secure storage is unavailable; connection was not saved')
    }
    const encrypted = safeStorage.encryptString(JSON.stringify({ providerId })).toString('base64')
    const temp = `${this.path}.tmp`
    writeFileSync(temp, encrypted, { encoding: 'utf8', mode: 0o600 })
    renameSync(temp, this.path)
  }

  clear(): void {
    if (existsSync(this.path)) unlinkSync(this.path)
  }
}

export class AssistantBridgeService {
  private readonly providers: readonly AssistantProviderDescriptor[]
  private readonly byId: Map<string, AssistantProviderDescriptor>
  private readonly connectionStore: EncryptedConnectionStore
  private readonly planStore: PlanStore
  private enabled = false
  private statusValue: AssistantConnectionStatus
  private readonly children = new Set<ChildProcess>()
  private readonly hostedWindows = new Set<BrowserWindow>()

  constructor() {
    this.providers = assistantProviderRegistry(process.env.MORZ_E2E === '1')
    this.byId = new Map(this.providers.map((provider) => [provider.id, provider]))
    this.connectionStore = new EncryptedConnectionStore(
      join(app.getPath('appData'), 'Morz', 'assistant-connection.bin')
    )
    this.planStore = new PlanStore(join(app.getPath('appData'), 'Morz', 'morz.db'))
    clearStalePromptFiles()
    const savedProviderId = this.connectionStore.load()
    this.statusValue = {
      state: 'disconnected',
      providerId: savedProviderId && this.byId.has(savedProviderId) ? savedProviderId : null,
      detail: savedProviderId ? 'Reconnect to verify this assistant.' : undefined
    }
  }

  listProviders(): AssistantProvider[] {
    return this.providers.map(publicAssistantProvider)
  }

  status(): AssistantConnectionStatus {
    return { ...this.statusValue }
  }

  setEnabled(enabled: boolean): AssistantConnectionStatus {
    this.enabled = enabled
    if (!enabled) this.stopActiveWork()
    return this.status()
  }

  async connect(providerId: string): Promise<AssistantConnectionStatus> {
    this.assertEnabled()
    const provider = this.requireProvider(providerId)
    this.statusValue = { state: 'connecting', providerId }
    try {
      if (provider.id === 'stub') {
        // Deterministic E2E seam; no process, network, credentials, or planner bypass.
      } else if (provider.kind === 'local') {
        await this.runProcess(provider.command, provider.handshakeArgs, HANDSHAKE_TIMEOUT_MS)
      } else {
        await this.openHostedLogin(provider)
      }
      this.assertEnabled()
      this.connectionStore.save(providerId)
      this.statusValue = { state: 'connected', providerId }
      return this.status()
    } catch (error) {
      const detail = messageOf(error)
      this.statusValue = { state: 'error', providerId, detail }
      throw new Error(`Could not connect ${provider.name}: ${detail}`)
    }
  }

  async disconnect(): Promise<AssistantConnectionStatus> {
    const providerId = this.statusValue.providerId
    this.stopActiveWork()
    const provider = providerId ? this.byId.get(providerId) : undefined
    if (provider?.kind === 'hosted') {
      await session.fromPartition(`persist:morz-assistant-${provider.id}`).clearStorageData()
    }
    this.connectionStore.clear()
    this.statusValue = { state: 'disconnected', providerId: null }
    return this.status()
  }

  async propose(rawGoal: string, spaceRoot: string): Promise<StoredSpawnPlan> {
    this.assertEnabled()
    const goal = rawGoal.trim()
    if (!goal || goal.length > MAX_GOAL_CHARS) throw new Error('Goal must be 1-4000 characters')
    if (!isAbsolute(spaceRoot) || spaceRoot.length > 2_000) {
      throw new Error('Space root must be an absolute path')
    }
    if (this.statusValue.state !== 'connected' || !this.statusValue.providerId) {
      throw new Error('Connect an assistant before asking it to propose a plan')
    }
    const provider = this.requireProvider(this.statusValue.providerId)
    if (process.env.MORZ_E2E === '1') {
      const global = globalThis as unknown as { __morzAssistantCalls?: number }
      global.__morzAssistantCalls = (global.__morzAssistantCalls ?? 0) + 1
    }

    try {
      const plan = await planGoal(goal, spaceRoot, {
        runClaude: (prompt) => this.callProvider(provider, prompt)
      })
      this.assertEnabled()
      const draft = this.planStore.createDraft(plan)
      return this.planStore.propose(draft.plan.id)
    } catch (error) {
      throw new Error(`Assistant could not propose a valid plan: ${messageOf(error)}`)
    }
  }

  close(): void {
    this.stopActiveWork()
    this.planStore.close()
  }

  private assertEnabled(): void {
    if (!this.enabled) throw new Error('Assistant bridge is disabled outside Orchestrated mode')
  }

  private requireProvider(providerId: string): AssistantProviderDescriptor {
    if (!/^[a-z0-9-]{1,64}$/.test(providerId)) throw new Error('Assistant provider id is invalid')
    const provider = this.byId.get(providerId)
    if (!provider) throw new Error('Unknown assistant provider')
    return provider
  }

  private async callProvider(provider: AssistantProviderDescriptor, prompt: string): Promise<string> {
    this.assertEnabled()
    if (provider.id === 'stub') return stubPlanResponse(prompt)
    if (provider.kind === 'local') {
      if (provider.promptTransport === 'argument') {
        return normalizeProviderOutput(
          (await this.runPromptArgumentProcess(provider, prompt)).stdout,
          provider
        )
      }
      if (provider.promptTransport === 'stdin') {
        const result = await this.runProcess(provider.command, provider.proposalArgs, PROPOSAL_TIMEOUT_MS, {
          input: prompt
        })
        return normalizeProviderOutput(result.stdout, provider)
      }
      const tempDir = assistantTempDir()
      mkdirSync(tempDir, { recursive: true })
      const promptFile = `${randomUUID()}.txt`
      const promptPath = join(tempDir, promptFile)
      writeFileSync(promptPath, prompt, { encoding: 'utf8', mode: 0o600 })
      try {
        const args = provider.proposalArgs.map((arg) => (arg === '{promptFile}' ? promptFile : arg))
        const result = await this.runProcess(provider.command, args, PROPOSAL_TIMEOUT_MS, {
          cwd: tempDir
        })
        return normalizeProviderOutput(result.stdout, provider)
      } finally {
        if (existsSync(promptPath)) unlinkSync(promptPath)
      }
    }
    return this.runHostedProposal(provider, prompt)
  }

  private runPromptArgumentProcess(
    provider: LocalAssistantProvider,
    prompt: string
  ): Promise<ProcessResult> {
    const promptCount = provider.proposalArgs.filter((arg) => arg === '{prompt}').length
    if (promptCount !== 1) throw new Error('Assistant provider prompt binding is invalid')
    const args = provider.proposalArgs.map((arg) => (arg === '{prompt}' ? prompt : arg))
    if (process.platform !== 'win32') {
      return this.runProcess(provider.command, args, PROPOSAL_TIMEOUT_MS, { forceNoShell: true })
    }

    // Batch shims parse metacharacters a second time, even when PowerShell
    // splats a variable. Resolve to a native executable or the verified npm
    // JS entrypoint so libuv passes the prompt as one argv item with no shell.
    const resolved = resolveWindowsArgumentCommand(provider.command)
    return this.runProcess(
      resolved.command,
      [...resolved.prefixArgs, ...args],
      PROPOSAL_TIMEOUT_MS,
      { forceNoShell: true }
    )
  }

  private runProcess(
    command: string,
    args: string[],
    timeoutMs: number,
    options: ProcessOptions = {}
  ): Promise<ProcessResult> {
    this.assertEnabled()
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, {
        cwd: options.cwd,
        windowsHide: true,
        // Windows CLI installs are commonly trusted .cmd shims. No untrusted
        // value enters this command line: prompts use stdin or a random basename.
        shell: process.platform === 'win32' && !options.forceNoShell,
        stdio: [options.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
        detached: process.platform !== 'win32'
      })
      this.children.add(child)
      let stdout = ''
      let settled = false
      const finish = (error?: Error): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        this.children.delete(child)
        if (error) reject(error)
        else resolve({ stdout })
      }
      const timer = setTimeout(() => {
        terminateProcessTree(child)
        finish(new Error(`Assistant process timed out after ${Math.round(timeoutMs / 1_000)} seconds`))
      }, timeoutMs)
      child.stdout?.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8')
        if (Buffer.byteLength(stdout) > MAX_OUTPUT_BYTES) {
          terminateProcessTree(child)
          finish(new Error('Assistant output exceeded the size limit'))
        }
      })
      // Drain without reflecting provider stderr into logs or renderer errors;
      // CLI diagnostics can contain paths, account ids, or credential prefixes.
      child.stderr?.resume()
      child.once('error', (error) => finish(new Error(`Could not start ${command}: ${error.message}`)))
      child.once('close', (code) => {
        if (code === 0) finish()
        else finish(new Error(`${command} exited ${code}; run its status command in a terminal for details`))
      })
      if (options.input !== undefined) child.stdin?.end(options.input)
    })
  }

  private createHostedPane(
    provider: HostedAssistantProvider,
    title: string,
    footerHeight = 0
  ): { window: BrowserWindow; view: BrowserView } {
    const window = new BrowserWindow({
      title,
      width: 860,
      height: 760,
      minWidth: 560,
      minHeight: 480,
      show: true,
      autoHideMenuBar: true,
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false
      }
    })
    const view = new BrowserView({
      webPreferences: {
        partition: `persist:morz-assistant-${provider.id}`,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false
      }
    })
    window.setBrowserView(view)
    const resize = (): void => {
      const [width, height] = window.getContentSize()
      view.setBounds({ x: 0, y: 0, width, height: Math.max(0, height - footerHeight) })
    }
    resize()
    window.on('resize', resize)
    view.webContents.on('will-navigate', (event, url) => {
      if (!isAllowedHostedUrl(url, provider)) event.preventDefault()
    })
    view.webContents.setWindowOpenHandler(({ url }) => {
      if (isAllowedHostedUrl(url, provider)) void view.webContents.loadURL(url)
      return { action: 'deny' }
    })
    this.hostedWindows.add(window)
    window.once('closed', () => this.hostedWindows.delete(window))
    return { window, view }
  }

  private async openHostedLogin(provider: HostedAssistantProvider): Promise<void> {
    const footerHeight = 64
    const { window, view } = this.createHostedPane(provider, `Connect ${provider.name}`, footerHeight)
    try {
      const confirmUrl = 'morz-assistant://login-confirmed'
      const footer = `<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">\n<style>body{margin:0;background:#171511;color:#d7cdb9;font:13px system-ui;display:flex;align-items:flex-end;height:100vh}footer{box-sizing:border-box;width:100%;height:${footerHeight}px;padding:12px 16px;display:flex;align-items:center;justify-content:space-between;border-top:1px solid #403a31}a{background:#c99552;color:#171511;padding:9px 14px;border-radius:7px;text-decoration:none;font-weight:700}</style><footer><span>Sign in above. Morz never sees your credentials.</span><a href="${confirmUrl}">Iâ€™m signed in and ready</a></footer>`
      await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(footer)}`)
      await view.webContents.loadURL(provider.loginUrl)
      await new Promise<void>((resolve, reject) => {
        let settled = false
        const timer = setTimeout(() => {
          finish(new Error('Hosted assistant login confirmation timed out'))
        }, HOSTED_LOGIN_TIMEOUT_MS)
        const finish = (error?: Error): void => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          window.webContents.removeListener('will-navigate', onNavigate)
          window.removeListener('closed', onClosed)
          if (error) reject(error)
          else resolve()
        }
        const onNavigate = (event: Electron.Event, url: string): void => {
          if (url !== confirmUrl) return
          event.preventDefault()
          finish()
        }
        const onClosed = (): void => finish(new Error('Hosted assistant connection was cancelled'))
        window.webContents.on('will-navigate', onNavigate)
        window.once('closed', onClosed)
      })
      this.assertEnabled()
      if (view.webContents.isDestroyed()) throw new Error('Hosted assistant pane closed before verification')
      const inputSelectors = JSON.stringify(provider.inputSelectors)
      const ready = await view.webContents.executeJavaScript(`(() => {
        const selectors = ${inputSelectors};
        return selectors.some((selector) => {
          const input = document.querySelector(selector);
          return input instanceof HTMLTextAreaElement || input instanceof HTMLInputElement;
        });
      })()`, true) as boolean
      if (!ready) throw new Error('Hosted assistant is not ready after login confirmation')
    } finally {
      if (!window.isDestroyed()) window.close()
    }
  }

  private async runHostedProposal(provider: HostedAssistantProvider, prompt: string): Promise<string> {
    const { window, view } = this.createHostedPane(provider, `${provider.name} proposal`)
    try {
      await view.webContents.loadURL(provider.assistantUrl)
      this.assertEnabled()
      const selectors = JSON.stringify({
        inputs: provider.inputSelectors,
        submits: provider.submitSelectors,
        prompt
      })
      const submitted = await view.webContents.executeJavaScript(`(() => {
        const config = ${selectors};
        const input = config.inputs.map((selector) => document.querySelector(selector)).find(Boolean);
        if (!(input instanceof HTMLTextAreaElement || input instanceof HTMLInputElement)) return false;
        const prototype = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
        setter?.call(input, config.prompt);
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        const submit = config.submits.map((selector) => document.querySelector(selector)).find(Boolean);
        if (submit instanceof HTMLElement) submit.click();
        else input.form?.requestSubmit();
        return true;
      })()`, true) as boolean
      if (!submitted) throw new Error('Hosted assistant input was not found; reconnect or update the provider')

      const deadline = Date.now() + PROPOSAL_TIMEOUT_MS
      while (Date.now() < deadline) {
        this.assertEnabled()
        if (window.isDestroyed() || view.webContents.isDestroyed()) {
          throw new Error('Hosted assistant pane was closed before it returned a plan')
        }
        await delay(1_000)
        const responseSelectors = JSON.stringify(provider.responseSelectors)
        const responsesValue = await view.webContents.executeJavaScript(`(() => {
          const selectors = ${responseSelectors};
          return selectors.flatMap((selector) => Array.from(document.querySelectorAll(selector)).slice(-10))
            .map((element) => (element.textContent ?? '').slice(0, ${MAX_HOSTED_RESPONSE_CHARS}).trim())
            .filter(Boolean)
            .reverse()
            .slice(0, ${MAX_HOSTED_RESPONSE_ELEMENTS});
        })()`, true) as string[]
        if (!Array.isArray(responsesValue) || responsesValue.length > MAX_HOSTED_RESPONSE_ELEMENTS) {
          throw new Error('Hosted assistant returned an invalid response collection')
        }
        const responses: string[] = []
        let responseBytes = 0
        for (const response of responsesValue) {
          if (typeof response !== 'string' || response.length > MAX_HOSTED_RESPONSE_CHARS) {
            throw new Error('Hosted assistant response exceeded the element size limit')
          }
          responseBytes += Buffer.byteLength(response)
          if (responseBytes > MAX_OUTPUT_BYTES) {
            throw new Error('Hosted assistant output exceeded the size limit')
          }
          responses.push(response)
        }
        for (const response of responses) {
          try {
            extractSpawnPlanBlock(response)
            return response
          } catch {
            // Keep waiting for the assistant's final, exact fenced response.
          }
        }
      }
      throw new Error('Hosted assistant did not return a SpawnPlan before timeout')
    } finally {
      if (!window.isDestroyed()) window.close()
    }
  }

  private stopActiveWork(): void {
    for (const child of this.children) terminateProcessTree(child)
    this.children.clear()
    for (const window of this.hostedWindows) if (!window.isDestroyed()) window.close()
    this.hostedWindows.clear()
  }
}

/** Register the append-only wave-6 assistant IPC surface after Electron is ready. */
export function registerAssistantIpc(): void {
  const service = new AssistantBridgeService()
  app.once('before-quit', () => service.close())

  ipcMain.handle(AssistantApi.listProviders, () => service.listProviders())
  ipcMain.handle(AssistantApi.status, () => service.status())
  ipcMain.handle(AssistantApi.setEnabled, (_event, enabled: unknown) => {
    if (typeof enabled !== 'boolean') throw new Error('Assistant enabled flag is invalid')
    return service.setEnabled(enabled)
  })
  ipcMain.handle(AssistantApi.connect, (_event, providerId: unknown) =>
    service.connect(String(providerId ?? ''))
  )
  ipcMain.handle(AssistantApi.disconnect, () => service.disconnect())
  ipcMain.handle(AssistantApi.propose, (_event, input: unknown) => {
    if (!isPlainObject(input)) throw new Error('Invalid assistant proposal request')
    return service.propose(String(input.goal ?? ''), String(input.spaceRoot ?? ''))
  })
}
