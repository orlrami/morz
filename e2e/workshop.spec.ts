import { expect, test } from '@playwright/test'
import { closeMorz, launchMorz, type MorzApp } from './app'

const cachedItem = {
  id: 'mcp:io.test/search-server',
  kind: 'mcp',
  name: 'Search Server',
  description: 'Searches the real world from a cached registry row.',
  source: 'test-owner/search-server',
  sourceUrl: 'https://github.com/test-owner/search-server',
  stars: 4242,
  official: true,
  recommended: true,
  installSpec: {
    command: 'npx',
    args: ['-y', '@test/search-server@1.0.0'],
    env: {}
  },
  updatedAt: '2026-07-12T12:00:00.000Z'
}

test.describe.serial('Workshop catalog', () => {
  let morz: MorzApp

  test.beforeAll(async () => {
    morz = await launchMorz()
    await morz.app.evaluate(({ ipcMain }) => {
      const snapshot = {
        items: [
          {
            id: 'mcp:io.test/search-server',
            kind: 'mcp',
            name: 'Search Server',
            description: 'Searches the real world from a cached registry row.',
            source: 'test-owner/search-server',
            sourceUrl: 'https://github.com/test-owner/search-server',
            stars: 4242,
            official: true,
            recommended: true,
            installSpec: {
              command: 'npx',
              args: ['-y', '@test/search-server@1.0.0'],
              env: {}
            },
            updatedAt: '2026-07-12T12:00:00.000Z'
          }
        ],
        lastSyncAt: 1783872000000,
        offline: true,
        syncing: false,
        error: 'offline test'
      }
      const g = globalThis as unknown as { __catalogRefreshes: number }
      g.__catalogRefreshes = 0
      ipcMain.removeHandler('catalog:query')
      ipcMain.removeHandler('catalog:refresh')
      ipcMain.handle('catalog:query', (_event, query?: { search?: string }) => {
        const term = query?.search?.trim().toLowerCase() ?? ''
        if (!term) return snapshot
        return {
          ...snapshot,
          items: snapshot.items.filter((item) =>
            `${item.name} ${item.description} ${item.source}`.toLowerCase().includes(term)
          )
        }
      })
      ipcMain.handle('catalog:refresh', () => {
        g.__catalogRefreshes += 1
        return snapshot
      })
    })
  })

  test.afterAll(async () => {
    if (morz) await closeMorz(morz.app)
  })

  test('renders cached rows with stars and offline status', async () => {
    await morz.page.getByRole('tab', { name: 'Workshop' }).evaluate((button: HTMLButtonElement) => button.click())
    await expect(morz.page.getByRole('region', { name: 'Workshop' })).toBeAttached()
    await expect(morz.page.getByRole('heading', { name: 'Search Server' })).toBeVisible()
    await expect(morz.page.getByText('4.2k')).toBeVisible()
    await expect(morz.page.getByText('offline', { exact: true })).toBeVisible()
    // config writer merged (w4/config) → the feature-detected Add button is live
    await expect(morz.page.getByRole('button', { name: 'Add Search Server' })).toBeEnabled()
  })

  test('filters catalog rows and refreshes through IPC', async () => {
    const search = morz.page.getByRole('searchbox', { name: 'Search catalog' })
    await search.fill('no match')
    await expect(morz.page.getByRole('heading', { name: cachedItem.name })).toHaveCount(0)
    await search.fill('real world')
    await expect(morz.page.getByRole('heading', { name: cachedItem.name })).toBeVisible()

    const before = await morz.app.evaluate(
      () => (globalThis as unknown as { __catalogRefreshes: number }).__catalogRefreshes
    )
    await morz.page
      .getByRole('button', { name: 'Refresh catalog' })
      .evaluate((button: HTMLButtonElement) => button.click())
    await expect
      .poll(() =>
        morz.app.evaluate(
          () => (globalThis as unknown as { __catalogRefreshes: number }).__catalogRefreshes
        )
      )
      .toBeGreaterThan(before)
  })
})
