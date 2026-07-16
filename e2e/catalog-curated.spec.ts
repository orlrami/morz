import { expect, test } from '@playwright/test'
import { createServer, type Server } from 'http'
import { closeMorz, launchMorz, type MorzApp } from './app'

function registryServer(
  name: string,
  title: string,
  repository: string,
  packageName: string
): Record<string, unknown> {
  return {
    server: {
      name,
      title,
      description: `${title} fixture from the official registry.`,
      repository: { url: `https://github.com/${repository}` },
      packages: [{
        registryType: 'npm',
        identifier: packageName,
        version: '1.0.0',
        transport: { type: 'stdio' }
      }]
    },
    _meta: {
      'io.modelcontextprotocol.registry/official': {
        status: 'active',
        isLatest: true,
        updatedAt: '2026-07-16T12:00:00.000Z'
      }
    }
  }
}

test.describe.serial('Curated MCP catalog', () => {
  let api: Server
  let morz: MorzApp
  let apiBaseUrl: string
  let registryRequests = 0
  const requestedUrls: string[] = []

  test.beforeAll(async () => {
    api = createServer((request, response) => {
      if (request.url) requestedUrls.push(request.url)
      if (request.url?.startsWith('/registry')) {
        registryRequests += 1
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({
          servers: [
            registryServer('com.stripe/mcp', 'Stripe', 'stripe/agent-toolkit', '@stripe/mcp'),
            registryServer('com.ibm/granite-mcp', 'IBM Granite MCP', 'ibm/granite-mcp', '@ibm/granite-mcp')
          ],
          metadata: {}
        }))
        return
      }
      if (request.url === '/github/repos/stripe/agent-toolkit') {
        response.writeHead(200, {
          'content-type': 'application/json',
          'x-ratelimit-remaining': '100'
        })
        response.end(JSON.stringify({ stargazers_count: 10 }))
        return
      }
      if (request.url === '/github/repos/ibm/granite-mcp') {
        response.writeHead(200, {
          'content-type': 'application/json',
          'x-ratelimit-remaining': '100'
        })
        response.end(JSON.stringify({ stargazers_count: 1_000_000 }))
        return
      }
      if (request.url === '/models') {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({
          data: [{
            id: 'test/catalog-model',
            name: 'Catalog Model',
            description: 'Model fixture for catalog refresh.',
            context_length: 128_000,
            created: 1_784_188_800
          }]
        }))
        return
      }
      response.writeHead(404).end()
    })
    await new Promise<void>((resolve) => api.listen(0, '127.0.0.1', resolve))
    const address = api.address()
    if (!address || typeof address === 'string') throw new Error('E2E catalog API did not bind a TCP port')
    apiBaseUrl = `http://127.0.0.1:${address.port}`

    process.env.MORZ_E2E = '1'
    process.env.MORZ_CATALOG_REGISTRY_URL = `${apiBaseUrl}/registry`
    process.env.MORZ_CATALOG_MODELS_URL = `${apiBaseUrl}/models`
    process.env.MORZ_CATALOG_GITHUB_URL = `${apiBaseUrl}/github/`
    delete process.env.OPENROUTER_API_KEY
    morz = await launchMorz()
  })

  test.afterAll(async () => {
    if (morz) await closeMorz(morz.app)
    await new Promise<void>((resolve, reject) => api.close((error) => error ? reject(error) : resolve()))
    delete process.env.MORZ_E2E
    delete process.env.MORZ_CATALOG_REGISTRY_URL
    delete process.env.MORZ_CATALOG_MODELS_URL
    delete process.env.MORZ_CATALOG_GITHUB_URL
  })

  test('recommends curated Stripe and denies higher-star Granite', async () => {
    const snapshot = await morz.page.evaluate(() => window.morz.catalog?.refresh({
      category: 'mcp',
      limit: 50
    }))
    const stripe = snapshot?.items.find((item) => item.id === 'mcp:com.stripe/mcp')
    const granite = snapshot?.items.find((item) => item.id === 'mcp:com.ibm/granite-mcp')

    expect(stripe?.recommended).toBe(true)
    expect(granite?.recommended).toBe(false)
    expect(requestedUrls).toContain('/github/repos/stripe/agent-toolkit')
    expect(requestedUrls).toContain('/github/repos/ibm/granite-mcp')
    expect(stripe?.stars).toBe(10)
    expect(granite?.stars).toBe(1_000_000)
  })

  test('refreshes the incremental catalog when an app window gains focus', async () => {
    const beforeFocus = registryRequests
    await morz.app.evaluate(({ app, BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0]
      if (!window) throw new Error('Expected a Morz browser window')
      app.emit('browser-window-focus', { preventDefault() {} } as never, window)
    })

    await expect.poll(() => registryRequests).toBeGreaterThan(beforeFocus)
  })
})
