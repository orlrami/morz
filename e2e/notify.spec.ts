import { expect, test } from '@playwright/test'
import { createServer, type Server } from 'http'
import { closeMorz, launchMorz, type MorzApp } from './app'

test.describe.serial('Notification center and catalog reliability', () => {
  let api: Server
  let morz: MorzApp
  let apiBaseUrl: string

  test.beforeAll(async () => {
    api = createServer((request, response) => {
      if (request.url === '/models') {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({
          data: [{
            id: 'test/reliable-model',
            name: 'Reliable Model',
            description: 'A model returned by the E2E catalog source.',
            context_length: 128_000,
            created: 1_783_872_000
          }]
        }))
        return
      }
      if (request.url === '/benchmarks') {
        response.writeHead(401, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ error: 'unauthorized' }))
        return
      }
      if (request.url?.startsWith('/registry')) {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({
          servers: [{
            server: {
              name: 'io.test/search-server',
              title: 'Search Server',
              description: 'E2E registry entry.',
              repository: { url: 'https://github.com/test-owner/search-server' }
            },
            _meta: {
              'io.modelcontextprotocol.registry/official': {
                status: 'active',
                isLatest: true,
                updatedAt: '2026-07-12T12:00:00.000Z'
              }
            }
          }],
          metadata: {}
        }))
        return
      }
      if (request.url === '/github/repos/test-owner/search-server') {
        response.writeHead(403, {
          'content-type': 'application/json',
          'x-ratelimit-reset': String(Math.floor(Date.now() / 1_000) + 3_600)
        })
        response.end(JSON.stringify({ message: 'rate limit exceeded' }))
        return
      }
      response.writeHead(404).end()
    })
    await new Promise<void>((resolve) => api.listen(0, '127.0.0.1', resolve))
    const address = api.address()
    if (!address || typeof address === 'string') throw new Error('E2E API did not bind a TCP port')
    apiBaseUrl = `http://127.0.0.1:${address.port}`

    const unavailable = createServer()
    await new Promise<void>((resolve) => unavailable.listen(0, '127.0.0.1', resolve))
    const unavailableAddress = unavailable.address()
    if (!unavailableAddress || typeof unavailableAddress === 'string') throw new Error('E2E offline fixture did not bind')
    await new Promise<void>((resolve, reject) => unavailable.close((error) => error ? reject(error) : resolve()))

    process.env.MORZ_E2E = '1'
    process.env.MORZ_CATALOG_REGISTRY_URL = `http://127.0.0.1:${unavailableAddress.port}/v0/servers`
    process.env.MORZ_CATALOG_MODELS_URL = `${apiBaseUrl}/models`
    process.env.MORZ_CATALOG_BENCHMARKS_URL = `${apiBaseUrl}/benchmarks`
    process.env.OPENROUTER_API_KEY = 'e2e-invalid-key'
    morz = await launchMorz()
  })

  test.afterAll(async () => {
    if (morz) await closeMorz(morz.app)
    await new Promise<void>((resolve, reject) => api.close((error) => error ? reject(error) : resolve()))
    delete process.env.MORZ_E2E
    delete process.env.MORZ_CATALOG_REGISTRY_URL
    delete process.env.MORZ_CATALOG_MODELS_URL
    delete process.env.MORZ_CATALOG_BENCHMARKS_URL
    delete process.env.MORZ_CATALOG_GITHUB_URL
    delete process.env.OPENROUTER_API_KEY
  })

  test('surfaces offline syncs while treating benchmark 401 as needs-key', async () => {
    await morz.page.getByRole('button', { name: 'Workshop' }).click()

    await expect(morz.page.getByTestId('catalog-source-mcp-registry')).toContainText('offline')
    await expect(morz.page.getByTestId('catalog-source-openrouter-benchmarks')).toContainText('needs key')

    const bell = morz.page.getByRole('button', { name: /Notifications/ })
    await expect(bell.getByTestId('notification-unread-count')).toHaveText(/[1-9]\d*/)
    await bell.click()

    const center = morz.page.getByRole('dialog', { name: 'Notification center' })
    await expect(center).toBeVisible()
    await expect(center.getByRole('button', { name: 'Close notification center' })).toBeFocused()
    await expect(center.getByText('MCP registry unavailable')).toBeVisible()
    await expect(center.getByRole('button', { name: 'Retry now' })).toBeVisible()

    const benchmarkNotice = await morz.page.evaluate(async () => {
      const notices = await window.morz.notify?.list()
      return notices?.find((notice) => notice.id === 'catalog:openrouter-benchmarks') ?? null
    })
    expect(benchmarkNotice).not.toBeNull()
    expect(benchmarkNotice?.level).not.toBe('error')
    await expect.poll(async () => {
      const notices = await morz.page.evaluate(() => window.morz.notify?.list())
      return notices?.every((notice) => notice.read) ?? false
    }).toBe(true)

    const beforeRetry = await morz.page.evaluate(async () => {
      const snapshot = await window.morz.catalog?.query()
      return snapshot?.sources.find((source) => source.source === 'mcp-registry')?.nextRetry ?? 0
    })
    await center.getByRole('button', { name: 'Retry now' }).click()
    await expect.poll(async () => {
      const snapshot = await morz.page.evaluate(() => window.morz.catalog?.query())
      return snapshot?.sources.find((source) => source.source === 'mcp-registry')?.nextRetry ?? 0
    }).toBeGreaterThan(beforeRetry)
  })

  test('upserts by id and dismisses without duplicate rows', async () => {
    await morz.page.evaluate(() => window.morz.notify?.emit({
      id: 'app:e2e-upsert',
      level: 'warning',
      source: 'app',
      title: 'First title'
    }))
    await expect.poll(async () => {
      const notices = await morz.page.evaluate(() => window.morz.notify?.list())
      return notices?.find((notice) => notice.id === 'app:e2e-upsert')?.ts ?? 0
    }).toBeGreaterThan(0)
    await morz.page.evaluate(() => window.morz.notify?.markRead('app:e2e-upsert'))
    const unchanged = await morz.page.evaluate(async () => {
      const notices = await window.morz.notify?.list()
      return notices?.find((notice) => notice.id === 'app:e2e-upsert') ?? null
    })
    await morz.page.evaluate(() => window.morz.notify?.emit({
      id: 'app:e2e-upsert',
      level: 'warning',
      source: 'app',
      title: 'First title'
    }))
    await expect.poll(async () => {
      const notices = await morz.page.evaluate(() => window.morz.notify?.list())
      return notices?.find((notice) => notice.id === 'app:e2e-upsert')
    }).toEqual(unchanged)

    await morz.page.evaluate(() => {
      window.morz.notify?.emit({
        id: 'app:e2e-upsert',
        level: 'error',
        source: 'app',
        title: 'Updated title',
        detail: 'The stable id updates the existing row.'
      })
    })

    const center = morz.page.getByRole('dialog', { name: 'Notification center' })
    await expect(center.getByText('Updated title')).toBeVisible()
    await expect(center.getByText('First title')).toHaveCount(0)
    await expect.poll(async () => {
      const notices = await morz.page.evaluate(() => window.morz.notify?.list())
      return notices?.filter((notice) => notice.id === 'app:e2e-upsert').length
    }).toBe(1)

    await center.getByRole('button', { name: 'Dismiss Updated title' }).click()
    await expect.poll(async () => {
      const notices = await morz.page.evaluate(() => window.morz.notify?.list())
      return notices?.some((notice) => notice.id === 'app:e2e-upsert') ?? true
    }).toBe(false)
  })

  test('strips renderer-supplied Main actions', async () => {
    await morz.page.evaluate(() => window.morz.notify?.emit({
      id: 'app:e2e-untrusted-action',
      level: 'warning',
      source: 'app',
      title: 'Untrusted action',
      actions: [{ id: 'retry-sync', label: 'Retry now' }]
    }))
    await expect.poll(async () => {
      const notices = await morz.page.evaluate(() => window.morz.notify?.list())
      return notices?.find((notice) => notice.id === 'app:e2e-untrusted-action')?.actions ?? null
    }).toBeNull()
  })

  test('keeps same-id pushes strictly ordered', async () => {
    const center = morz.page.getByRole('dialog', { name: 'Notification center' })
    if (!(await center.isVisible())) await morz.page.getByRole('button', { name: /Notifications/ }).click()
    await morz.app.evaluate(() => {
      const state = globalThis as unknown as { __notifyRealDateNow?: () => number }
      state.__notifyRealDateNow = Date.now
      Date.now = () => 2_000_000_000_000
    })
    await morz.page.evaluate(() => {
      for (let index = 0; index < 100; index++) {
        window.morz.notify?.emit({
          id: 'app:e2e-ordered',
          level: 'info',
          source: 'app',
          title: `Ordered notice ${index}`
        })
      }
    })
    try {
      await expect(center.getByText('Ordered notice 99', { exact: true })).toBeVisible()
      await expect(center.getByText('Ordered notice 0', { exact: true })).toHaveCount(0)
    } finally {
      await morz.app.evaluate(() => {
        const state = globalThis as unknown as { __notifyRealDateNow?: () => number }
        if (state.__notifyRealDateNow) Date.now = state.__notifyRealDateNow
        delete state.__notifyRealDateNow
      })
    }
  })

  test('reloads notices from the same SQLite app data', async () => {
    await morz.page.evaluate(() => window.morz.notify?.emit({
      id: 'app:e2e-persisted',
      level: 'info',
      source: 'app',
      title: 'Persisted notice'
    }))
    const appDataDir = morz.appDataDir
    await closeMorz(morz.app)
    morz = await launchMorz({ appDataDir })

    await expect.poll(async () => {
      const notices = await morz.page.evaluate(() => window.morz.notify?.list())
      return notices?.some((notice) => notice.id === 'app:e2e-persisted') ?? false
    }).toBe(true)
  })

  test('classifies GitHub 403 as rate-limited warning', async () => {
    await closeMorz(morz.app)
    process.env.MORZ_CATALOG_REGISTRY_URL = `${apiBaseUrl}/registry`
    process.env.MORZ_CATALOG_GITHUB_URL = `${apiBaseUrl}/github/`
    morz = await launchMorz()
    await morz.page.getByRole('button', { name: 'Workshop' }).click()

    await expect(morz.page.getByTestId('catalog-source-github')).toContainText('rate-limited')
    const githubNotice = await morz.page.evaluate(async () => {
      const notices = await window.morz.notify?.list()
      return notices?.find((notice) => notice.id === 'catalog:github') ?? null
    })
    expect(githubNotice?.level).toBe('warning')
    expect(githubNotice?.detail).toContain('Cached stars are unchanged')
  })
})
