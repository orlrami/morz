import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { closeMorz, launchMorz, type MorzApp } from './app'

async function runPalette(page: Page, query: string): Promise<void> {
  await page.keyboard.press('Control+k')
  const palette = page.getByRole('dialog', { name: 'Command palette' })
  await expect(palette).toBeVisible()
  await palette.getByRole('textbox').fill(query)
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Enter')
  await expect(palette).toHaveCount(0)
}

test.describe.serial('command palette', () => {
  let morz: MorzApp

  test.beforeAll(async () => {
    morz = await launchMorz()
  })

  test.afterAll(async () => {
    if (morz) await closeMorz(morz.app)
  })

  test('runs view and pane commands from the keyboard', async () => {
    const { page } = morz
    const terminals = page.locator('section[data-pane-id^="term-"]')
    await expect(terminals).toHaveCount(2)

    await runPalette(page, 'view: commit')
    await expect(page.getByRole('region', { name: 'Commit' })).toBeVisible()

    await runPalette(page, 'spawn: terminal')
    await expect(terminals).toHaveCount(3)
  })

  // w16/polish-motion — palette = Spotlight: the persistent titlebar search bar
  // is gone; a small icon (and Ctrl+K) open the same centered modal.
  test('opens from the titlebar search icon; no persistent search bar remains', async () => {
    const { page } = morz
    await expect(page.getByText('Search agents, files, actions')).toHaveCount(0)

    await page.getByRole('button', { name: 'Open command palette' }).click()
    const palette = page.getByRole('dialog', { name: 'Command palette' })
    await expect(palette).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(palette).toHaveCount(0)
  })

  test('hides Claude commands in Manual mode', async () => {
    const { page } = morz
    await expect(page.getByRole('radio', { name: 'Manual' })).toHaveAttribute('aria-checked', 'true')

    await page.keyboard.press('Control+k')
    const palette = page.getByRole('dialog', { name: 'Command palette' })
    await expect(palette).toBeVisible()
    await palette.getByRole('textbox').fill('claude')
    await expect(palette.getByRole('button', { name: /claude/i })).toHaveCount(0)
    await page.keyboard.press('Escape')
  })

  test('drives pane, explorer, settings, workshop, and theme actions', async () => {
    const { app, page } = morz
    const terminals = page.locator('section[data-pane-id^="term-"]')

    await runPalette(page, 'view: toggle file explorer')
    await expect(page.getByRole('complementary', { name: 'File explorer' })).toBeVisible()

    await runPalette(page, 'spawn: split focused pane right')
    await expect(terminals).toHaveCount(4)
    await runPalette(page, 'view: close focused pane')
    await expect(terminals).toHaveCount(3)

    await runPalette(page, 'settings: appearance')
    await expect(page.getByRole('region', { name: 'Settings' })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Appearance' })).toBeVisible()

    await runPalette(page, 'settings: open memory settings')
    await expect(page.getByRole('region', { name: 'Learning memory' })).toBeVisible()

    await app.evaluate(({ ipcMain }) => {
      const snapshot = {
        items: [],
        lastSyncAt: Date.now(),
        offline: false,
        syncing: false,
        error: null,
        sources: []
      }
      const state = globalThis as unknown as { __paletteCatalogRefreshes: number }
      state.__paletteCatalogRefreshes = 0
      ipcMain.removeHandler('catalog:query')
      ipcMain.removeHandler('catalog:refresh')
      ipcMain.handle('catalog:query', () => snapshot)
      ipcMain.handle('catalog:refresh', () => {
        state.__paletteCatalogRefreshes += 1
        return snapshot
      })
    })
    await runPalette(page, 'workshop: sync catalog')
    await expect(page.getByRole('region', { name: 'Workshop' })).toBeVisible()
    await expect
      .poll(() =>
        app.evaluate(
          () => (globalThis as unknown as { __paletteCatalogRefreshes: number }).__paletteCatalogRefreshes
        )
      )
      .toBeGreaterThan(0)

    await runPalette(page, 'theme: switch to slate')
    await expect
      .poll(() => page.evaluate(() => document.body.style.backgroundColor))
      .toBe('rgb(31, 33, 36)')
  })

  test('starts a Claude lane only after switching to Assisted', async () => {
    const { page } = morz
    await page.getByRole('radio', { name: 'Assisted' }).click()
    await runPalette(page, 'spawn: Claude lane')
    await expect(page.locator('section[aria-label^="Claude lane"]')).toHaveCount(1)
  })
})
