import {
  BrowserWindow,
  WebContentsView,
  app,
  clipboard,
  ipcMain,
  type Debugger,
  type IpcMainInvokeEvent
} from 'electron'
import { randomUUID } from 'crypto'
import { writeFile } from 'fs/promises'
import { join } from 'path'
import {
  BrowserApi,
  type BrowserAgentKind,
  type BrowserRect,
  type BrowserState,
  type ElementContext
} from '../../shared/ipc'
import { getAdapter } from '../adapters/registry'
import { notify } from './notify-center'

const COMMON_DEV_PORTS = [3000, 5173, 8080, 4200] as const
const CURATED_PROPERTIES = [
  'color',
  'background-color',
  'font-family',
  'font-size',
  'font-weight',
  'margin-top',
  'margin-right',
  'margin-bottom',
  'margin-left',
  'padding-top',
  'padding-right',
  'padding-bottom',
  'padding-left',
  'border-top-width',
  'border-top-style',
  'border-top-color'
] as const

interface CdpNode {
  nodeId: number
  backendNodeId: number
  nodeName: string
  attributes?: string[]
  children?: CdpNode[]
  shadowRoots?: CdpNode[]
  contentDocument?: CdpNode
}

interface NodeIndexEntry {
  node: CdpNode
  parent: CdpNode | null
}

const EMPTY_STATE: BrowserState = {
  url: '',
  title: '',
  canGoBack: false,
  canGoForward: false,
  loading: false,
  picking: false
}

function normalizeHttpUrl(value: string): string {
  const input = value.trim()
  if (!input) throw new Error('Enter an HTTP or HTTPS address.')
  const hasExplicitScheme = /^[a-z][a-z\d+.-]*:/i.test(input)
  const withProtocol = hasExplicitScheme
    ? input
    : /^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:\/|$)/i.test(input)
      ? `http://${input}`
      : `https://${input}`
  const url = new URL(withProtocol)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Only HTTP and HTTPS pages can be opened.')
  }
  if (url.username || url.password) throw new Error('Addresses containing credentials are not allowed.')
  return url.toString().replace(/\/$/, url.pathname === '/' && !url.search && !url.hash ? '' : '/')
}

function isAllowedNavigation(value: string): boolean {
  try {
    const url = new URL(value)
    return (url.protocol === 'http:' || url.protocol === 'https:') && !url.username && !url.password
  } catch {
    return false
  }
}

function cleanError(value: unknown): string {
  const message = value instanceof Error ? value.message : String(value)
  return message.replace(/https?:\/\/[^\s]+/gi, '[url]').slice(0, 240)
}

function attrs(node: CdpNode): Record<string, string> {
  const values = node.attributes ?? []
  const result: Record<string, string> = {}
  for (let index = 0; index + 1 < values.length; index += 2) result[values[index]] = values[index + 1]
  return result
}

function cssString(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\r/g, '\\d ')
    .replace(/\n/g, '\\a ')
    .replace(/\f/g, '\\c ')
}

function indexTree(root: CdpNode): Map<number, NodeIndexEntry> {
  const index = new Map<number, NodeIndexEntry>()
  const visit = (node: CdpNode, parent: CdpNode | null): void => {
    index.set(node.nodeId, { node, parent })
    for (const child of node.children ?? []) visit(child, node)
    for (const shadow of node.shadowRoots ?? []) visit(shadow, node)
    if (node.contentDocument) visit(node.contentDocument, node)
  }
  visit(root, null)
  return index
}

function quadValue(values: Record<string, string>, prefix: 'margin' | 'padding'): string {
  const parts = ['top', 'right', 'bottom', 'left'].map((side) => values[`${prefix}-${side}`] || '0px')
  if (parts.every((part) => part === parts[0])) return parts[0]
  if (parts[0] === parts[2] && parts[1] === parts[3]) return `${parts[0]} ${parts[1]}`
  if (parts[1] === parts[3]) return `${parts[0]} ${parts[1]} ${parts[2]}`
  return parts.join(' ')
}

function boundsFromQuad(quad: number[]): BrowserRect {
  const xs = quad.filter((_value, index) => index % 2 === 0)
  const ys = quad.filter((_value, index) => index % 2 === 1)
  const left = Math.min(...xs)
  const top = Math.min(...ys)
  const right = Math.max(...xs)
  const bottom = Math.max(...ys)
  return { x: left, y: top, width: right - left, height: bottom - top }
}

class BrowserHost {
  readonly view: WebContentsView
  private picking = false
  private error: string | undefined
  private debuggerReady = false

  constructor(private readonly owner: BrowserWindow) {
    this.view = new WebContentsView({
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
        partition: `morz-browser-${owner.webContents.id}-${randomUUID()}`
      }
    })
    this.view.setVisible(false)
    this.view.setBackgroundColor('#ffffff')
    owner.contentView.addChildView(this.view)

    const contents = this.view.webContents
    contents.session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false))
    contents.session.setPermissionCheckHandler(() => false)
    contents.session.on('will-download', (event) => event.preventDefault())
    contents.setWindowOpenHandler(() => ({ action: 'deny' }))
    contents.on('will-navigate', (event) => {
      if (!isAllowedNavigation(event.url)) event.preventDefault()
    })
    contents.on('will-redirect', (event) => {
      if (!isAllowedNavigation(event.url)) event.preventDefault()
    })
    contents.on('did-start-loading', () => this.pushState())
    contents.on('did-stop-loading', () => this.pushState())
    contents.on('did-navigate', () => {
      this.error = undefined
      this.pushState()
    })
    contents.on('did-navigate-in-page', () => this.pushState())
    contents.on('page-title-updated', () => this.pushState())
    contents.on('did-fail-load', (_event, code, description, _url, isMainFrame) => {
      if (!isMainFrame || code === -3) return
      this.error = description
      this.pushState()
      this.raiseFailure('Page failed to load', description)
    })
    contents.debugger.on('message', (_event, method, params) => {
      if (method !== 'Overlay.inspectNodeRequested' || !this.picking) return
      const backendNodeId = Number((params as { backendNodeId?: number }).backendNodeId)
      if (!Number.isFinite(backendNodeId)) return
      void this.captureByBackendNodeId(backendNodeId).catch((error) => {
        this.picking = false
        this.pushState()
        this.raiseFailure('Element pick failed', error)
      })
    })
    contents.debugger.on('detach', () => {
      this.debuggerReady = false
      this.picking = false
      this.pushState()
    })
    owner.once('closed', () => this.destroy())
  }

  state(): BrowserState {
    const contents = this.view.webContents
    if (contents.isDestroyed()) return { ...EMPTY_STATE }
    return {
      url: contents.getURL(),
      title: contents.getTitle(),
      canGoBack: contents.navigationHistory.canGoBack(),
      canGoForward: contents.navigationHistory.canGoForward(),
      loading: contents.isLoading(),
      picking: this.picking,
      ...(this.error ? { error: this.error } : {})
    }
  }

  setBounds(rect: BrowserRect): void {
    if (![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite)) return
    const ownerBounds = this.owner.getContentBounds()
    const x = Math.max(0, Math.round(rect.x))
    const y = Math.max(0, Math.round(rect.y))
    const width = Math.max(0, Math.min(Math.round(rect.width), ownerBounds.width - x))
    const height = Math.max(0, Math.min(Math.round(rect.height), ownerBounds.height - y))
    this.view.setBounds({ x, y, width, height })
    this.view.setVisible(width > 0 && height > 0)
  }

  async navigate(value: string): Promise<BrowserState> {
    const url = normalizeHttpUrl(value)
    this.error = undefined
    await this.view.webContents.loadURL(url)
    return this.state()
  }

  async back(): Promise<BrowserState> {
    if (this.view.webContents.navigationHistory.canGoBack()) {
      this.view.webContents.navigationHistory.goBack()
    }
    return this.state()
  }

  async forward(): Promise<BrowserState> {
    if (this.view.webContents.navigationHistory.canGoForward()) {
      this.view.webContents.navigationHistory.goForward()
    }
    return this.state()
  }

  async reload(): Promise<BrowserState> {
    if (this.view.webContents.getURL()) this.view.webContents.reload()
    return this.state()
  }

  async setPickMode(enabled: boolean): Promise<BrowserState> {
    if (!this.view.webContents.getURL()) throw new Error('Open a page before picking an element.')
    await this.ensureDebugger()
    this.picking = enabled
    await this.view.webContents.debugger.sendCommand('Overlay.setInspectMode', {
      mode: enabled ? 'searchForNode' : 'none',
      highlightConfig: {
        showInfo: true,
        showStyles: true,
        showAccessibilityInfo: true,
        contentColor: { r: 203, g: 162, b: 90, a: 0.22 },
        borderColor: { r: 203, g: 162, b: 90, a: 0.95 }
      }
    })
    this.pushState()
    return this.state()
  }

  async captureSelector(selector: string): Promise<ElementContext> {
    if (!selector.trim()) throw new Error('A selector is required.')
    await this.ensureDebugger()
    const { root } = (await this.command('DOM.getDocument', {
      depth: -1,
      pierce: true
    })) as { root: CdpNode }
    const match = (await this.command('DOM.querySelector', {
      nodeId: root.nodeId,
      selector
    })) as { nodeId: number }
    if (!match.nodeId) throw new Error(`No element matches ${selector}.`)
    const described = (await this.command('DOM.describeNode', { nodeId: match.nodeId })) as {
      node: CdpNode
    }
    return this.captureByBackendNodeId(described.node.backendNodeId, root)
  }

  destroy(): void {
    const contents = this.view.webContents
    try {
      this.view.setVisible(false)
      this.owner.contentView.removeChildView(this.view)
      if (!contents.isDestroyed() && contents.debugger.isAttached()) contents.debugger.detach()
      if (!contents.isDestroyed()) contents.close()
    } catch {
      // Idempotent teardown: the owner may already be closing.
    }
  }

  private async ensureDebugger(): Promise<void> {
    const target: Debugger = this.view.webContents.debugger
    if (!target.isAttached()) target.attach('1.3')
    if (this.debuggerReady) return
    await Promise.all([
      target.sendCommand('DOM.enable'),
      target.sendCommand('CSS.enable'),
      target.sendCommand('Accessibility.enable'),
      target.sendCommand('Page.enable'),
      target.sendCommand('Overlay.enable')
    ])
    this.debuggerReady = true
  }

  private command(method: string, params?: unknown): Promise<unknown> {
    return this.view.webContents.debugger.sendCommand(method, params)
  }

  private async uniqueSelector(
    root: CdpNode,
    target: CdpNode,
    index: Map<number, NodeIndexEntry>
  ): Promise<string> {
    const targetAttrs = attrs(target)
    for (const name of ['id', 'data-testid', 'data-test', 'name']) {
      if (!targetAttrs[name]) continue
      const candidate = `[${name}="${cssString(targetAttrs[name])}"]`
      const result = (await this.command('DOM.querySelectorAll', {
        nodeId: root.nodeId,
        selector: candidate
      })) as { nodeIds: number[] }
      if (result.nodeIds.length === 1) return candidate
    }

    const segments: string[] = []
    let current: CdpNode | null = target
    while (current && current.nodeName !== '#document') {
      const tag = current.nodeName.toLowerCase()
      if (!tag.startsWith('#')) {
        const parent = index.get(current.nodeId)?.parent ?? null
        const siblings = (parent?.children ?? []).filter(
          (candidate) => candidate.nodeName === current!.nodeName
        )
        const nth = siblings.length > 1 ? `:nth-of-type(${siblings.indexOf(current) + 1})` : ''
        segments.unshift(`${tag}${nth}`)
        const candidate = segments.join(' > ')
        const result = (await this.command('DOM.querySelectorAll', {
          nodeId: root.nodeId,
          selector: candidate
        })) as { nodeIds: number[] }
        if (result.nodeIds.length === 1) return candidate
      }
      current = index.get(current.nodeId)?.parent ?? null
    }
    return segments.join(' > ')
  }

  private async captureByBackendNodeId(
    backendNodeId: number,
    knownRoot?: CdpNode
  ): Promise<ElementContext> {
    const root = knownRoot ??
      ((await this.command('DOM.getDocument', { depth: -1, pierce: true })) as { root: CdpNode }).root
    const index = indexTree(root)
    const entry = [...index.values()].find((candidate) => candidate.node.backendNodeId === backendNodeId)
    if (!entry) throw new Error('The selected element is no longer in the document.')
    const node = entry.node

    await this.command('DOM.scrollIntoViewIfNeeded', { backendNodeId })

    const [selector, axResult, styleResult, boxResult, htmlResult, layoutResult] = await Promise.all([
      this.uniqueSelector(root, node, index),
      this.command('Accessibility.getPartialAXTree', { backendNodeId, fetchRelatives: false }),
      this.command('CSS.getComputedStyleForNode', { nodeId: node.nodeId }),
      this.command('DOM.getBoxModel', { backendNodeId }),
      this.command('DOM.getOuterHTML', { nodeId: node.nodeId }),
      this.command('Page.getLayoutMetrics')
    ]) as [
      string,
      { nodes: Array<{ role?: { value?: string }; name?: { value?: string } }> },
      { computedStyle: Array<{ name: string; value: string }> },
      { model: { border: number[] } },
      { outerHTML: string },
      { visualViewport?: { pageX?: number; pageY?: number; clientWidth?: number; clientHeight?: number } }
    ]

    const boundingRect = boundsFromQuad(boxResult.model.border)
    if (boundingRect.width <= 0 || boundingRect.height <= 0) {
      throw new Error('The selected element has no visible bounds.')
    }
    const pageX = layoutResult.visualViewport?.pageX ?? 0
    const pageY = layoutResult.visualViewport?.pageY ?? 0
    const viewportWidth = layoutResult.visualViewport?.clientWidth ?? boundingRect.width
    const viewportHeight = layoutResult.visualViewport?.clientHeight ?? boundingRect.height
    const cropX = Math.max(0, boundingRect.x)
    const cropY = Math.max(0, boundingRect.y)
    const cropWidth = Math.min(boundingRect.width, Math.max(1, viewportWidth - cropX), 4096)
    const cropHeight = Math.min(boundingRect.height, Math.max(1, viewportHeight - cropY), 4096)
    const screenshot = (await this.command('Page.captureScreenshot', {
      format: 'png',
      fromSurface: true,
      captureBeyondViewport: false,
      clip: {
        x: cropX + pageX,
        y: cropY + pageY,
        width: Math.max(1, cropWidth),
        height: Math.max(1, cropHeight),
        scale: 1
      }
    })) as { data: string }
    const screenshotPath = join(app.getPath('temp'), `morz-element-${randomUUID()}.png`)
    await writeFile(screenshotPath, Buffer.from(screenshot.data, 'base64'), { flag: 'wx' })

    const computed = Object.fromEntries(
      styleResult.computedStyle
        .filter((property) => (CURATED_PROPERTIES as readonly string[]).includes(property.name))
        .map((property) => [property.name, property.value])
    )
    const border = [computed['border-top-width'], computed['border-top-style'], computed['border-top-color']]
      .filter(Boolean)
      .join(' ')
    const accessibility = axResult.nodes[0] ?? {}
    const context: ElementContext = {
      selector,
      a11y: {
        role: accessibility.role?.value ?? '',
        name: accessibility.name?.value ?? ''
      },
      curatedStyles: {
        color: computed.color ?? '',
        backgroundColor: computed['background-color'] ?? '',
        fontFamily: computed['font-family'] ?? '',
        fontSize: computed['font-size'] ?? '',
        fontWeight: computed['font-weight'] ?? '',
        margin: quadValue(computed, 'margin'),
        padding: quadValue(computed, 'padding'),
        border
      },
      boundingRect,
      croppedScreenshotDataUrl: `data:image/png;base64,${screenshot.data}`,
      screenshotPath,
      sourceLoc: attrs(node)['data-morz-loc'] || undefined,
      html: htmlResult.outerHTML.slice(0, 100_000)
    }

    this.picking = false
    try {
      await this.command('Overlay.setInspectMode', { mode: 'none', highlightConfig: {} })
    } catch {
      // Capture succeeded; a detached overlay must not discard the ElementContext.
    }
    this.pushState()
    this.owner.webContents.send(BrowserApi.picked, context)
    return context
  }

  private pushState(): void {
    if (!this.owner.isDestroyed()) this.owner.webContents.send(BrowserApi.stateChanged, this.state())
  }

  private raiseFailure(title: string, error: unknown): void {
    notify({
      id: `browser:${title.toLowerCase().replace(/\W+/g, '-')}`,
      level: 'error',
      source: 'app',
      title,
      detail: cleanError(error)
    })
  }
}

const hosts = new Map<number, BrowserHost>()
const liveAgents: Record<BrowserAgentKind, Set<string>> = {
  agy: new Set<string>(),
  claude: new Set<string>()
}
let agentsObserved = false

function observeLiveAgents(): void {
  if (agentsObserved) return
  agentsObserved = true
  for (const kind of ['agy', 'claude'] as const) {
    getAdapter(kind).onEvent((agentId, event) => {
      if (event.type === 'init') liveAgents[kind].add(agentId)
      if (event.type === 'exit') liveAgents[kind].delete(agentId)
    })
  }
}

function ownerFor(event: IpcMainInvokeEvent): BrowserWindow {
  const owner = BrowserWindow.fromWebContents(event.sender)
  if (!owner || owner.webContents.id !== event.sender.id) {
    throw new Error('Browser IPC is only available to the Morz renderer.')
  }
  return owner
}

function hostFor(event: IpcMainInvokeEvent, create = false): BrowserHost {
  const owner = ownerFor(event)
  const id = owner.webContents.id
  let host = hosts.get(id)
  if (!host && create) {
    host = new BrowserHost(owner)
    hosts.set(id, host)
    owner.once('closed', () => hosts.delete(id))
  }
  if (!host) throw new Error('The embedded browser is not open.')
  return host
}

async function discoverLocalhost(): Promise<string[]> {
  const probes = COMMON_DEV_PORTS.map(async (port) => {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 900)
    try {
      const response = await fetch(`http://127.0.0.1:${port}`, {
        method: 'HEAD',
        redirect: 'manual',
        signal: controller.signal
      })
      return response.status > 0 ? `http://localhost:${port}` : null
    } catch {
      return null
    } finally {
      clearTimeout(timeout)
    }
  })
  return (await Promise.all(probes)).filter((url): url is string => Boolean(url))
}

export function registerBrowserIpc(): void {
  observeLiveAgents()
  ipcMain.handle(BrowserApi.create, (event) => hostFor(event, true).state())
  ipcMain.handle(BrowserApi.destroy, (event) => {
    const owner = ownerFor(event)
    const host = hosts.get(owner.webContents.id)
    host?.destroy()
    hosts.delete(owner.webContents.id)
  })
  ipcMain.handle(BrowserApi.state, (event) => hostFor(event).state())
  ipcMain.handle(BrowserApi.navigate, async (event, url: string) => hostFor(event).navigate(url))
  ipcMain.on(BrowserApi.setBounds, (event, rect: BrowserRect) => {
    const owner = BrowserWindow.fromWebContents(event.sender)
    if (!owner || owner.webContents.id !== event.sender.id) return
    hosts.get(owner.webContents.id)?.setBounds(rect)
  })
  ipcMain.handle(BrowserApi.back, (event) => hostFor(event).back())
  ipcMain.handle(BrowserApi.forward, (event) => hostFor(event).forward())
  ipcMain.handle(BrowserApi.reload, (event) => hostFor(event).reload())
  ipcMain.handle(BrowserApi.setPickMode, (event, enabled: boolean) =>
    hostFor(event).setPickMode(Boolean(enabled))
  )
  ipcMain.handle(BrowserApi.discoverLocalhost, (event) => {
    ownerFor(event)
    return discoverLocalhost()
  })
  ipcMain.handle(BrowserApi.liveAgents, (event, kind: BrowserAgentKind) => {
    ownerFor(event)
    if (kind !== 'agy' && kind !== 'claude') return []
    return [...liveAgents[kind]]
  })
  ipcMain.handle(BrowserApi.copyText, (event, text: string) => {
    ownerFor(event)
    clipboard.writeText(String(text).slice(0, 200_000))
  })
  if (process.env.MORZ_E2E === '1') {
    ipcMain.handle(BrowserApi.testPick, (event, selector: string) =>
      hostFor(event).captureSelector(selector)
    )
  }
}
