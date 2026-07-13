/*
 * Slice-3 (best-effort): ctrl-click a file path printed in the terminal →
 * the IDE pane (CodeMirror overlay) opens on that file.
 *
 * The xterm WebGL renderer paints to a canvas, so there is no DOM node for the
 * link to click. Instead: ask the SHELL for its cols×rows, measure the
 * .xterm-screen box, derive the pixel cell grid, and ctrl-click the printed
 * path (scanning the first few rows — where the output lands depends on how
 * the prompt + typed command wrapped at pane width).
 *
 * STATUS: fixme. Harness verified end-to-end EXCEPT link activation:
 *   - mousemove/click events reach the .xterm element (listener probe),
 *   - window.morz.file.read() resolves for the target (the tier-2 stat gate),
 *   - yet hovering any cell of the printed path with Ctrl held never fires the
 *     provider's hover callback (it would set an inline text-decoration), and
 *     ctrl-click never opens the IDE pane.
 * So the file-link provider isn't surfacing links under the WebGL renderer —
 * an app-side Slice-3 issue (suspect: xterm v6 registerLinkProvider buffer-row
 * semantics), not a test-side one. Un-fixme once terminal-links is fixed.
 */
import { test, expect } from '@playwright/test'
import { join } from 'path'
import {
  closeMorz,
  launchMorz,
  PANE_1,
  PROMPT_RE,
  ROOT,
  runInPane,
  waitForTerm,
  type MorzApp
} from './app'

test.describe.serial('IDE pane (Slice 3, best-effort)', () => {
  let morz: MorzApp

  test.beforeAll(async () => {
    morz = await launchMorz()
  })

  test.afterAll(async () => {
    if (morz) await closeMorz(morz.app)
  })

  test.fixme('ctrl-click a printed path opens the IDE pane', async () => {
    const page = morz.page
    await waitForTerm(page, PANE_1, PROMPT_RE, 90_000)

    // Shell-reported grid — authoritative for the pixel→cell mapping.
    await runInPane(
      page,
      PANE_1,
      '"MORZ_SZ_$($Host.UI.RawUI.WindowSize.Width)x$($Host.UI.RawUI.WindowSize.Height)_END"'
    )
    const buf = await waitForTerm(page, PANE_1, /MORZ_SZ_\d+x\d+_END/)
    const m = /MORZ_SZ_(\d+)x(\d+)_END/.exec(buf)!
    const cols = Number(m[1])
    const rows = Number(m[2])
    expect(cols).toBeGreaterThan(20)
    expect(rows).toBeGreaterThan(5)

    // Print an EXISTING file (the tier-2 link provider stat-verifies through
    // FileService before linking); `clear` first keeps it in the top rows.
    const target = join(ROOT, 'package.json')
    expect(target.length).toBeLessThan(cols) // the output line must not wrap
    await runInPane(page, PANE_1, 'clear')
    await page.waitForTimeout(1_000)
    await runInPane(page, PANE_1, `echo ${target}`)
    // ConPTY repaints with cursor-move sequences, not literal newlines — wait
    // for the path text to flow, then let the repaint settle before clicking.
    await waitForTerm(page, PANE_1, /package\.json/)
    await page.waitForTimeout(1_500)

    const screen = page.locator('section[aria-label^="Terminal"] .xterm-screen').first()
    const box = (await screen.boundingBox())!
    expect(box).toBeTruthy()
    const cellW = box.width / cols
    const cellH = box.height / rows

    // Scan the first rows: hover (link provider runs + async stat check),
    // then ctrl-click mid-path (activation is Ctrl/Shift-gated).
    const x = box.x + cellW * (target.length / 2)
    const editor = page.locator('.cm-editor')
    for (let row = 0; row < 8 && !(await editor.isVisible()); row++) {
      const y = box.y + cellH * (row + 0.5)
      await page.mouse.move(x, y)
      await page.waitForTimeout(600)
      await page.keyboard.down('Control')
      await page.mouse.move(x + 1, y) // re-hover with the modifier held
      await page.waitForTimeout(200)
      await page.mouse.click(x, y)
      await page.keyboard.up('Control')
      await page.waitForTimeout(800)
    }

    // IDE pane = CodeMirror overlay with the file's full path on its header span.
    await expect(editor).toBeVisible({ timeout: 10_000 })
    await expect(page.locator(`span[title="${target}"]`)).toBeVisible()
  })
})
