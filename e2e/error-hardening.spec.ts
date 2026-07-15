import { expect, test } from '@playwright/test'
import { createServer, type Server } from 'http'
import { readFileSync } from 'fs'
import { join } from 'path'
import { closeMorz, launchMorz, type MorzApp } from './app'

test.describe('Runtime error hardening', () => {
  let api: Server
  let apiBaseUrl: string
  let morz: MorzApp
  let registryRequests = 0
  let registryMode: 'complete' | 'cycle' = 'complete'
  const rendererIssues: string[] = []
  const mainIssues: string[] = []
  const originalEnv = {
    MORZ_E2E: process.env.MORZ_E2E,
    MORZ_CATALOG_REGISTRY_URL: process.env.MORZ_CATALOG_REGISTRY_URL,
    MORZ_CATALOG_MODELS_URL: process.env.MORZ_CATALOG_MODELS_URL,
    MORZ_CATALOG_BENCHMARKS_URL: process.env.MORZ_CATALOG_BENCHMARKS_URL,
    MORZ_CATALOG_GITHUB_URL: process.env.MORZ_CATALOG_GITHUB_URL,
    OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY
  }

  const observe = (current: MorzApp): void => {
    current.page.on('console', (message) => {
      if (message.type() === 'error' || message.type() === 'warning') {
        rendererIssues.push(`${message.type()}: ${message.text()}`)
      }
    })
    current.page.on('pageerror', (error) => rendererIssues.push(`pageerror: ${error.message}`))
    current.page.on('requestfailed', (request) => {
      rendererIssues.push(`requestfailed: ${request.method()} ${request.url()} ${request.failure()?.errorText ?? ''}`)
    })
    current.page.on('response', (response) => {
      if (response.status() >= 400) rendererIssues.push(`http ${response.status()}: ${response.url()}`)
    })
    current.app.process().stderr?.on('data', (chunk) => mainIssues.push(chunk.toString()))
  }

  test.beforeAll(async () => {
    api = createServer((request, response) => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1')
      if (url.pathname === '/registry') {
        registryRequests++
        const page = Number(url.searchParams.get('cursor')?.replace('page-', '') ?? '0')
        const nextCursor = registryMode === 'cycle'
          ? page === 199 ? 'page-1' : `page-${page + 1}`
          : page < 205 ? `page-${page + 1}` : undefined
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({
          servers: [{
            server: {
              name: `io.test/error-hardening-${page}`,
              title: `Error Hardening ${page}`,
              description: 'A deterministic paginated registry fixture.'
            },
            _meta: {
              'io.modelcontextprotocol.registry/official': {
                status: 'active',
                isLatest: true,
                updatedAt: new Date(Date.UTC(2026, 6, 14, 12, 0, page % 60)).toISOString()
              }
            }
          }],
          metadata: nextCursor ? { nextCursor } : {}
        }))
        return
      }
      if (url.pathname === '/models') {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({
          data: [{
            id: 'test/error-hardening-model',
            name: 'Error Hardening Model',
            description: 'A deterministic OpenRouter fixture.',
            context_length: 32_000,
            created: 1_783_872_000
          }]
        }))
        return
      }
      response.writeHead(404, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: 'not found' }))
    })
    await new Promise<void>((resolve) => api.listen(0, '127.0.0.1', resolve))
    const address = api.address()
    if (!address || typeof address === 'string') throw new Error('Error-hardening API did not bind')
    apiBaseUrl = `http://127.0.0.1:${address.port}`

    process.env.MORZ_E2E = '1'
    process.env.MORZ_CATALOG_REGISTRY_URL = `${apiBaseUrl}/registry`
    process.env.MORZ_CATALOG_MODELS_URL = `${apiBaseUrl}/models`
    process.env.MORZ_CATALOG_BENCHMARKS_URL = `${apiBaseUrl}/benchmarks`
    process.env.MORZ_CATALOG_GITHUB_URL = `${apiBaseUrl}/github/`
    delete process.env.OPENROUTER_API_KEY

    morz = await launchMorz()
    observe(morz)
  })

  test.afterAll(async () => {
    if (morz) await closeMorz(morz.app)
    await new Promise<void>((resolve, reject) => api.close((error) => error ? reject(error) : resolve()))
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })

  test('boots and tours every view without uncaught errors', async () => {
    await morz.page.reload()
    await morz.page.waitForLoadState('domcontentloaded')

    for (const name of ['Terminals', 'Commit', 'Waves', 'Review', 'Organizer']) {
      await morz.page.getByRole('tab', { name, exact: true }).click()
    }
    await morz.page.getByRole('button', { name: 'Settings', exact: true }).click()
    await morz.page.getByRole('button', { name: 'Workshop', exact: true }).click()

    await expect.poll(() => registryRequests).toBeGreaterThanOrEqual(200)
    await expect.poll(async () => {
      const snapshot = await morz.page.evaluate(() => window.morz.catalog?.query())
      return snapshot?.sources.find((source) => source.source === 'mcp-registry')?.lastSyncAt ?? 0
    }).toBeGreaterThan(0)

    await morz.page.getByRole('tab', { name: 'Terminals', exact: true }).click()
    await morz.page.getByRole('radio', { name: 'Assisted', exact: true }).click()
    await morz.page.getByRole('button', { name: 'Start Claude here', exact: true }).first().click()
    await expect(morz.page.getByRole('region', { name: /Claude lane/ })).toHaveCount(1)
    await morz.page.getByRole('radio', { name: 'Manual', exact: true }).click()
    await expect(morz.page.getByRole('region', { name: /Claude lane/ })).toHaveCount(0)

    const registryNotice = await morz.page.evaluate(async () => {
      const notices = await window.morz.notify?.list()
      return notices?.find((notice) => notice.id === 'catalog:mcp-registry') ?? null
    })
    expect(registryNotice).toBeNull()
    expect(rendererIssues).toEqual([])
    expect(mainIssues).toEqual([])
  })

  test('routes a forced main-process rejection to the Notification Center', async () => {
    const listenerCounts = await morz.app.evaluate(() => ({
      rejection: process.listenerCount('unhandledRejection'),
      exception: process.listenerCount('uncaughtException')
    }))
    expect(listenerCounts.rejection).toBeGreaterThan(0)
    expect(listenerCounts.exception).toBeGreaterThan(0)

    const issueCount = mainIssues.length
    await morz.app.evaluate(() => {
      queueMicrotask(() => {
        void Promise.reject(new Error(
          'forced error-hardening rejection Bearer e2e-super-secret-token ' +
          'Authorization: Basic dXNlcjpwYXNz password="two words" ' +
          'https://user:pass@example.test/path?token=query-secret C:\\Users\\OJ\\secret.txt'
        ))
      })
    })

    await expect.poll(async () => {
      const notices = await morz.page.evaluate(() => window.morz.notify?.list())
      return notices?.find((notice) => notice.id === 'app:unhandled-rejection') ?? null
    }).toMatchObject({
      level: 'error',
      source: 'app',
      title: 'Background task failed',
      detail: 'forced error-hardening rejection Bearer [redacted] ' +
        'Authorization=[redacted] password=[redacted] https://example.test/path [path]'
    })
    expect(mainIssues.slice(issueCount)).toEqual([])
  })

  test('persists an uncaught exception and exits fail closed', async () => {
    const appDataDir = morz.appDataDir
    const child = morz.app.process()
    const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      child.once('exit', (code, signal) => resolve({ code, signal }))
    })
    await morz.app.evaluate(() => {
      queueMicrotask(() => {
        throw new Error('forced uncaught exception Bearer e2e-super-secret-token')
      })
    }).catch(() => undefined)

    const result = await Promise.race([
      exit,
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('Main did not exit after uncaught exception')), 5_000))
    ])
    expect(result.code).not.toBe(0)

    morz = await launchMorz({ appDataDir })
    observe(morz)
    await expect.poll(async () => {
      const notices = await morz.page.evaluate(() => window.morz.notify?.list())
      return notices?.find((notice) => notice.id === 'app:uncaught-exception') ?? null
    }).toMatchObject({
      level: 'error',
      source: 'app',
      title: 'Morz encountered an unexpected error',
      detail: 'forced uncaught exception Bearer [redacted]'
    })
  })

  test('protects the renderer root with an error boundary', () => {
    const mainSource = readFileSync(join(__dirname, '..', 'src', 'renderer', 'src', 'main.tsx'), 'utf8')
    expect(mainSource).toContain("import { ErrorBoundary } from './components/ErrorBoundary'")
    expect(mainSource).toMatch(/<ErrorBoundary>\s*<App\s*\/>\s*<\/ErrorBoundary>/)
  })

  test('stops a Registry cursor cycle that crosses a slice boundary', async () => {
    await closeMorz(morz.app)
    registryMode = 'cycle'
    registryRequests = 0
    rendererIssues.length = 0
    mainIssues.length = 0
    morz = await launchMorz()
    observe(morz)
    await morz.page.getByRole('button', { name: 'Workshop', exact: true }).click()

    await expect.poll(async () => {
      const notices = await morz.page.evaluate(() => window.morz.notify?.list())
      return notices?.find((notice) => notice.id === 'catalog:mcp-registry')?.detail ?? ''
    }).toContain('repeated a cursor')
    expect(registryRequests).toBeLessThanOrEqual(200)
    expect(rendererIssues).toEqual([])
    expect(mainIssues).toEqual([])
  })
})
