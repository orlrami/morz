import { expect, test } from '@playwright/test'
import { existsSync, mkdirSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from 'fs'
import { join } from 'path'
import { closeMorz, launchMorz, ROOT, type MorzApp } from './app'
import { openTerminalPath } from './ide-helpers'

const FIXTURE_NAME = 'ide-overlay-round-trip.txt'
const FIXTURE_PATH = join(ROOT, FIXTURE_NAME)
const DIRECTORY_NAME = 'ide-overlay-untracked'
const DIRECTORY_PATH = join(ROOT, DIRECTORY_NAME)
const NESTED_FIXTURE_PATH = join(DIRECTORY_PATH, 'deferred.txt')
const INITIAL_CONTENT = 'overlay save fixture\n'
const SAVED_CONTENT = 'saved through the Morz overlay\n'

test.describe.serial('IDE slide-over and Explorer panel', () => {
  let morz: MorzApp

  test.beforeAll(async () => {
    writeFileSync(FIXTURE_PATH, INITIAL_CONTENT, 'utf8')
    mkdirSync(DIRECTORY_PATH, { recursive: true })
    writeFileSync(NESTED_FIXTURE_PATH, 'deferred overlay fixture\n', 'utf8')
    morz = await launchMorz()
  })

  test.afterAll(async () => {
    if (morz) await closeMorz(morz.app)
    if (existsSync(FIXTURE_PATH)) unlinkSync(FIXTURE_PATH)
    if (existsSync(NESTED_FIXTURE_PATH)) unlinkSync(NESTED_FIXTURE_PATH)
    if (existsSync(DIRECTORY_PATH)) rmdirSync(DIRECTORY_PATH)
  })

  test('terminal link opens above the dock and Escape closes it', async () => {
    const page = morz.page
    await page.getByRole('radio', { name: 'Assisted' }).click()
    const dock = page.getByRole('complementary', { name: 'Orchestrator' })
    if (!(await dock.isVisible())) {
      await page.getByRole('button', { name: /orchestrator/i }).first().click()
    }
    await expect(dock).toBeVisible()

    const target = join(ROOT, 'package.json')
    await openTerminalPath(page, target)

    const overlay = page.getByTestId('ide-overlay')
    await expect(overlay).toBeVisible()
    await expect(overlay).toHaveCSS('width', '660px')
    await expect(page.getByTitle(target).first()).toBeVisible()

    const stacking = await page.evaluate(() => {
      const overlayElement = document.querySelector<HTMLElement>('[data-testid="ide-overlay"]')!
      const dockElement = document.querySelector<HTMLElement>('aside[aria-label="Orchestrator"]')!
      const pointElement = document.elementFromPoint(window.innerWidth - 12, 92)
      const z = (element: HTMLElement): number => {
        const value = Number.parseInt(getComputedStyle(element).zIndex, 10)
        return Number.isFinite(value) ? value : 0
      }
      return {
        overlay: z(overlayElement),
        dock: z(dockElement),
        overlayOwnsRightEdge: !!pointElement?.closest('[data-testid="ide-overlay"]')
      }
    })
    expect(stacking.overlay).toBeGreaterThan(stacking.dock)
    expect(stacking.overlayOwnsRightEdge).toBe(true)

    await page.keyboard.press('Escape')
    await expect(overlay).toHaveAttribute('aria-hidden', 'true')
    await expect(overlay).toHaveAttribute('inert', '')
    await expect
      .poll(async () => {
        const [box, viewport] = await Promise.all([
          overlay.boundingBox(),
          page.evaluate(() => ({ width: window.innerWidth }))
        ])
        return box ? box.x >= viewport.width : true
      })
      .toBe(true)
  })

  test('Explorer file opens in the overlay and saves back to disk', async () => {
    const page = morz.page
    await morz.app.evaluate(({ dialog }, root) => {
      Object.defineProperty(dialog, 'showOpenDialog', {
        configurable: true,
        value: async () => ({ canceled: false, filePaths: [root], bookmarks: [] })
      })
    }, ROOT)
    await page.getByRole('button', { name: 'Add space' }).click()
    // The added space appears as a titlebar space tab; the Explorer header
    // carries the same name once the panel is open.
    const spaceName = ROOT.replace(/[\\/]+$/, '').split(/[\\/]/).pop() as string
    await expect(page.getByRole('tab', { name: new RegExp(spaceName) }).first()).toBeVisible()

    await page.getByRole('button', { name: 'Toggle file explorer' }).click()
    await expect(page.getByRole('heading', { name: spaceName })).toBeVisible()

    const explorer = page.getByRole('complementary', { name: 'File explorer' })
    await expect(explorer).toBeVisible()
    await expect(explorer).toHaveCSS('width', '224px')

    const fixtureRow = explorer.getByTitle(FIXTURE_PATH)
    await expect(fixtureRow).toBeVisible()
    await expect(fixtureRow.getByTestId('explorer-git-badge')).toHaveText('?')
    const directoryRow = explorer.getByTitle(DIRECTORY_PATH)
    await expect(directoryRow.getByTestId('explorer-git-badge')).toHaveText('?')
    await fixtureRow.click()

    const overlay = page.getByTestId('ide-overlay')
    await expect(overlay).toBeVisible()
    await expect(page.getByTitle(FIXTURE_PATH).first()).toBeVisible()

    const editor = overlay.locator('.cm-content')
    await editor.click()
    await page.keyboard.press('Control+A')
    await page.keyboard.type(SAVED_CONTENT)

    await page.keyboard.press('Escape')
    await expect(overlay).toHaveAttribute('aria-hidden', 'true')
    await fixtureRow.click()
    await expect(editor).toHaveText(SAVED_CONTENT.trim())
    await page.keyboard.press('Control+S')

    await expect.poll(() => readFileSync(FIXTURE_PATH, 'utf8')).toBe(SAVED_CONTENT)
  })
})
