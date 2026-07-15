import { test, expect } from '@playwright/test'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { createInterface } from 'node:readline'
import { join } from 'node:path'
import { closeMorz, launchMorz, ROOT, type MorzApp } from './app'

interface RoutingBridge {
  route(
    taskText: string,
    options: { spaceRoot?: string; spacePrivate?: boolean }
  ): Promise<{
    target: 'agy' | 'codex' | 'claude' | 'local'
    reason: string
    warning?: string
    claudeEnv?: { ANTHROPIC_BASE_URL: string; ANTHROPIC_MODEL: string }
  }>
  snapshot(spaceRoot?: string): Promise<{
    rules: Array<{ id: string; match: { keywords: string[] } }>
    localModels: Array<{ provider: string; healthy: boolean; models: string[] }>
    spacePrivate: boolean
  }>
  refreshLocalModels(): Promise<Array<{ provider: string; healthy: boolean; models: string[] }>>
}

interface PendingRpc {
  resolve(value: Record<string, unknown>): void
  reject(error: Error): void
  timer: ReturnType<typeof setTimeout>
}

function startMcpClient(
  pipe: string,
  token: string
): {
  child: ChildProcessWithoutNullStreams
  request(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>>
  notify(method: string): void
} {
  const child = spawn(process.execPath, [join(ROOT, 'packages/morz-mcp/dist/morz-mcp.cjs')], {
    env: {
      ...process.env,
      MORZ_BUS_PIPE: pipe,
      MORZ_BUS_TOKEN: token,
      MORZ_AGENT_ID: 'routing-e2e'
    },
    stdio: ['pipe', 'pipe', 'pipe']
  })
  const pending = new Map<number, PendingRpc>()
  let nextId = 1
  createInterface({ input: child.stdout }).on('line', (line) => {
    let message: Record<string, unknown>
    try {
      message = JSON.parse(line) as Record<string, unknown>
    } catch {
      return
    }
    const id = typeof message.id === 'number' ? message.id : null
    if (id === null) return
    const waiter = pending.get(id)
    if (!waiter) return
    pending.delete(id)
    clearTimeout(waiter.timer)
    waiter.resolve(message)
  })
  child.stderr.resume()
  return {
    child,
    request(method, params) {
      const id = nextId++
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id)
          reject(new Error(`MCP request timed out: ${method}`))
        }, 10_000)
        pending.set(id, { resolve, reject, timer })
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
      })
    },
    notify(method) {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method })}\n`)
    }
  }
}

function routingBridge(page: MorzApp['page']): Promise<RoutingBridge> {
  return page.evaluate(() => {
    const bridge = (window as unknown as { morzRouting?: RoutingBridge }).morzRouting
    if (!bridge) throw new Error('routing bridge is unavailable')
    return bridge
  })
}

test.describe.serial('wave 8 routing', () => {
  let fixture: Server
  let fixtureUrl = ''
  let morz: MorzApp

  test.beforeAll(async () => {
    fixture = createServer((request, response) => {
      if (request.url === '/api/tags') {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ models: [{ name: 'qwen3:8b' }] }))
        return
      }
      response.writeHead(404).end()
    })
    await new Promise<void>((resolve) => fixture.listen(0, '127.0.0.1', resolve))
    const address = fixture.address()
    if (!address || typeof address === 'string') throw new Error('fixture did not bind a TCP port')
    fixtureUrl = `http://127.0.0.1:${address.port}`
    process.env.MORZ_E2E = '1'
    process.env.MORZ_E2E_CONSULT_STUB = '1'
    process.env.MORZ_OLLAMA_URL = fixtureUrl
    morz = await launchMorz()
  })

  test.afterAll(async () => {
    if (morz) await closeMorz(morz.app)
    await new Promise<void>((resolve) => fixture.close(() => resolve()))
    delete process.env.MORZ_E2E
    delete process.env.MORZ_E2E_CONSULT_STUB
    delete process.env.MORZ_OLLAMA_URL
  })

  test('rules route math to Antigravity and review to Codex', async () => {
    const results = await morz.page.evaluate(async () => {
      const bridge = (window as unknown as { morzRouting: RoutingBridge }).morzRouting
      return Promise.all([
        bridge.route('prove this theorem', {}),
        bridge.route('review this diff', {})
      ])
    })
    expect(results[0].target).toBe('agy')
    expect(results[1].target).toBe('codex')
  })

  test('detects Ollama models through the loopback fixture', async () => {
    const models = await morz.page.evaluate(async () => {
      const bridge = (window as unknown as { morzRouting: RoutingBridge }).morzRouting
      return bridge.refreshLocalModels()
    })
    expect(models).toContainEqual(
      expect.objectContaining({ provider: 'ollama', healthy: true, models: ['qwen3:8b'] })
    )
  })

  test('private spaces force a detected local model', async () => {
    const result = await morz.page.evaluate(async () => {
      const bridge = (window as unknown as { morzRouting: RoutingBridge }).morzRouting
      return bridge.route('summarize these notes', { spacePrivate: true })
    })
    expect(result.target).toBe('local')
    expect(result.warning).toBeUndefined()
    expect(result.claudeEnv).toEqual({
      ANTHROPIC_BASE_URL: fixtureUrl,
      ANTHROPIC_MODEL: 'qwen3:8b'
    })
  })

  test('settings edits and persists routing rules and the private-space toggle', async () => {
    const { page } = morz
    await page.getByRole('button', { name: 'Settings' }).click()
    await page.getByRole('button', { name: 'Control' }).click()
    const settings = page.getByRole('region', { name: 'Routing settings' })
    await expect(settings).toBeVisible()
    const keywords = settings.getByLabel('Math and proofs keywords')
    await keywords.fill('math, theorem, proof, algebraic')
    await settings.getByRole('button', { name: 'Save routing rules' }).click()
    await expect(settings.getByText('Routing rules saved')).toBeVisible()
    await settings.getByLabel('Private space — force local').check()

    const appDataDir = morz.appDataDir
    await closeMorz(morz.app)
    morz = await launchMorz({ appDataDir })
    const snapshot = await morz.page.evaluate(async () => {
      const bridge = (window as unknown as { morzRouting: RoutingBridge }).morzRouting
      return {
        route: await bridge.route('algebraic simplification', {}),
        snapshot: await bridge.snapshot('C:\\Projects\\morz')
      }
    })
    expect(snapshot.route.target).toBe('agy')
    expect(snapshot.snapshot.spacePrivate).toBe(true)
    expect(snapshot.snapshot.rules.find((rule) => rule.id === 'math')?.match.keywords).toContain('algebraic')
  })

  test('consult round-trips through MCP and labels the stub answer untrusted', async () => {
    const bus = await morz.app.evaluate(() => ({
      pipe: process.env.MORZ_BUS_PIPE ?? '',
      token: process.env.MORZ_BUS_TOKEN ?? ''
    }))
    expect(bus.pipe).not.toBe('')
    expect(bus.token).not.toBe('')
    const client = startMcpClient(bus.pipe, bus.token)
    try {
      await client.request('initialize', {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'routing-e2e', version: '0' }
      })
      client.notify('notifications/initialized')
      const response = await client.request('tools/call', {
        name: 'consult',
        arguments: { brain: 'codex', question: 'What should I verify?' }
      })
      const result = response.result as { content?: Array<{ text?: string }>; isError?: boolean }
      expect(result.isError).not.toBe(true)
      const payload = JSON.parse(result.content?.[0]?.text ?? '{}') as {
        answer?: string
        untrusted?: boolean
      }
      expect(payload.answer).toContain('[consult:codex]')
      expect(payload.answer).toContain('MORZ_E2E consult answer')
      expect(payload.untrusted).toBe(true)
    } finally {
      client.child.kill()
    }
  })
})
