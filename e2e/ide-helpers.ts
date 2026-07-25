import { expect, type Page } from '@playwright/test'
import { PANE_1, PROMPT_RE, runInPane, waitForTerm } from './app'

/**
 * Exercise the real xterm link provider by printing an existing absolute path
 * and ctrl-clicking its painted canvas cells.
 */
export async function openTerminalPath(
  page: Page,
  target: string,
  paneId = PANE_1
): Promise<void> {
  await waitForTerm(page, paneId, PROMPT_RE, 90_000)

  const strayPanes = page.locator(
    `section[aria-label^="Terminal"]:not([aria-label$="${paneId}"]):not([aria-label$="term-2"])`
  )
  while ((await strayPanes.count()) > 0) {
    await strayPanes
      .first()
      .locator('button[aria-label="Close pane"]')
      .click({ force: true })
    await page.waitForTimeout(500)
  }

  let cols = 0
  let rows = 0
  for (let attempt = 0; attempt < 10 && cols <= 40; attempt++) {
    await page.waitForTimeout(1_000)
    await runInPane(
      page,
      paneId,
      `"MORZ_SZ${attempt}_$($Host.UI.RawUI.WindowSize.Width)x$($Host.UI.RawUI.WindowSize.Height)_END"`
    )
    const sizePattern = new RegExp(`MORZ_SZ${attempt}_(\\d+)x(\\d+)_END`)
    const buffer = await waitForTerm(page, paneId, sizePattern)
    const match = sizePattern.exec(buffer)!
    cols = Number(match[1])
    rows = Number(match[2])
  }
  expect(cols).toBeGreaterThan(40)
  expect(rows).toBeGreaterThan(5)
  expect(target.length).toBeLessThan(cols)

  await runInPane(page, paneId, 'clear')
  await page.waitForTimeout(1_000)
  const powerShellPath = `'${target.replace(/'/g, "''")}'`
  await runInPane(page, paneId, `echo ${powerShellPath}`)
  const fileName = target.split(/[\\/]/).pop()!.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  await waitForTerm(page, paneId, new RegExp(fileName))
  await page.waitForTimeout(1_500)

  const terminal = page.locator(`section[aria-label$="${paneId}"]`)
  const screen = terminal.locator('.xterm-screen')
  const box = (await screen.boundingBox())!
  expect(box).toBeTruthy()
  const cellWidth = box.width / cols
  const cellHeight = box.height / rows
  const x = box.x + cellWidth * (target.length / 2)
  const editor = page.locator('.cm-editor')

  for (let row = 0; row < 8 && !(await editor.isVisible()); row++) {
    const y = box.y + cellHeight * (row + 0.5)
    await page.mouse.move(x, y)
    await page.waitForTimeout(600)
    await page.keyboard.down('Control')
    await page.mouse.move(x + 1, y)
    await page.waitForTimeout(200)
    await page.mouse.click(x, y)
    await page.keyboard.up('Control')
    await page.waitForTimeout(800)
  }

  await expect(editor).toBeVisible({ timeout: 10_000 })
}
