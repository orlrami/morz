import { expect, test, type Page } from '@playwright/test'
import { closeMorz, launchMorz, type MorzApp } from './app'
import type { BusHandoffInput } from '../src/shared/bus-ipc'

const SELECTION_LINE = 2

async function selectLineAndOpenMenu(page: Page, lineCount = 1): Promise<void> {
  const line = page.locator('.cm-line').nth(SELECTION_LINE - 1)
  await expect(line).toBeVisible()
  await line.click()
  // CodeMirror Home is indentation-aware: first press = first non-space,
  // second press = absolute line start. Start there for exact line ranges.
  await page.keyboard.press('Home')
  await page.keyboard.press('Home')
  await page.keyboard.down('Shift')
  if (lineCount === 1) {
    await page.keyboard.press('End')
  } else {
    for (let index = 0; index < lineCount; index += 1) await page.keyboard.press('ArrowDown')
  }
  await page.keyboard.up('Shift')
  await line.click({ button: 'right' })
  await expect(page.getByRole('menu', { name: 'Code selection actions' })).toBeVisible()
}

test.describe.serial('IDE selection send', () => {
  let morz: MorzApp
  let filePath = ''

  test.beforeAll(async () => {
    morz = await launchMorz()
    await morz.app.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('bus:post')
      ipcMain.handle('bus:post', (_event, input: BusHandoffInput) => {
        ;(globalThis as typeof globalThis & { __ideSendPost?: BusHandoffInput }).__ideSendPost = input
        return { taskId: 'e2e-ide-send' }
      })
    })

    const explorerToggle = morz.page.getByRole('button', { name: 'Toggle file explorer' })
    await explorerToggle.click()
    const explorer = morz.page.getByRole('complementary', { name: 'File explorer' })
    const packageJson = explorer.getByRole('button', { name: /package\.json/ })
    await expect(packageJson).toBeVisible({ timeout: 15_000 })
    filePath = (await packageJson.getAttribute('title')) ?? ''
    expect(filePath).toMatch(/package\.json$/)
    await packageJson.click()
    await expect(morz.page.locator('.cm-editor')).toBeVisible()
  })

  test.afterAll(async () => {
    if (morz) await closeMorz(morz.app)
  })

  test('selection menu copies an agent-ready prompt with feedback', async () => {
    const firstLine = morz.page.locator('.cm-line').first()
    await firstLine.click()
    await firstLine.click({ button: 'right' })
    await expect(morz.page.getByRole('menu', { name: 'Code selection actions' })).toHaveCount(0)

    await selectLineAndOpenMenu(morz.page)

    const menu = morz.page.getByRole('menu', { name: 'Code selection actions' })
    const send = menu.getByRole('menuitem', { name: 'Send to agent for review' })
    const copy = menu.getByRole('menuitem', { name: 'Copy as agent prompt' })
    await expect(send).toBeFocused()
    await morz.page.keyboard.press('ArrowDown')
    await expect(copy).toBeFocused()
    await copy.click()
    await expect(morz.page.locator('.cm-editor')).toHaveClass(/cm-focused/)

    const copied = await morz.app.evaluate(({ clipboard }) => clipboard.readText())
    expect(copied).toContain(`Review ${filePath}:${SELECTION_LINE}`)
    expect(copied).toContain('"name": "morz"')
    await expect.poll(async () => {
      const notices = await morz.page.evaluate(() => window.morz.notify?.list())
      return notices?.find((notice) => notice.id === 'app:ide-selection-copied')?.title ?? ''
    }).toMatch(/copied/i)
  })

  test('send falls back to clipboard when no Claude lane is live', async () => {
    await morz.app.evaluate(({ clipboard }) => clipboard.clear())
    await selectLineAndOpenMenu(morz.page)
    await morz.page
      .getByRole('menu', { name: 'Code selection actions' })
      .getByRole('menuitem', { name: 'Send to agent for review' })
      .click()

    await expect.poll(() => morz.app.evaluate(({ clipboard }) => clipboard.readText())).toContain(
      `Review ${filePath}:${SELECTION_LINE}`
    )
    await expect.poll(async () => {
      const notices = await morz.page.evaluate(() => window.morz.notify?.list())
      return notices?.find((notice) => notice.id === 'app:ide-selection-copied')?.detail ?? ''
    }).toMatch(/no live claude lane.*paste into any agent/i)
  })

  test('send posts the file range and code to the live Claude lane', async () => {
    await morz.page.getByRole('radio', { name: 'Assisted' }).dispatchEvent('click')
    await morz.page.locator('[aria-label="Start Claude here"]').first().dispatchEvent('click')
    const lane = morz.page.locator('section[aria-label^="Claude lane"]')
    await expect(lane).toHaveCount(1)
    const laneLabel = (await lane.getAttribute('aria-label')) ?? ''
    const agentId = laneLabel.replace('Claude lane — ', '')
    expect(agentId).toMatch(/^claude-/)

    await selectLineAndOpenMenu(morz.page, 2)
    await morz.page
      .getByRole('menu', { name: 'Code selection actions' })
      .getByRole('menuitem', { name: 'Send to agent for review' })
      .click()

    await expect.poll(() =>
      morz.app.evaluate(
        () =>
          (globalThis as typeof globalThis & { __ideSendPost?: BusHandoffInput }).__ideSendPost ?? null
      )
    ).not.toBeNull()
    const handoff = await morz.app.evaluate(
      () => (globalThis as typeof globalThis & { __ideSendPost?: BusHandoffInput }).__ideSendPost!
    )
    expect(handoff.from).toBe('morz-ide')
    expect(handoff.to).toBe(agentId)
    expect(handoff.title).toContain(`package.json:${SELECTION_LINE}-${SELECTION_LINE + 1}`)
    expect(handoff.text).toContain(`Review ${filePath}:${SELECTION_LINE}-${SELECTION_LINE + 1}`)
    expect(handoff.text).toContain('"name": "morz"')
    expect(handoff.text).toContain('"version":')
  })
})
