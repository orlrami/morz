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
 * STATUS: PASSING. The earlier "link provider never fires" evidence was
 * environmental, not a terminal-links bug: the layout store restores panes
 * from the REAL user DB (app.getPath('appData') resolves via the Windows
 * shell, ignoring the harness's APPDATA env override), so stray split panes
 * from earlier suite runs squeezed term-1 to ~19 cols and the pixel→cell
 * math clicked the wrong cells. With the panes cleaned up, the provider
 * surfaces links fine under the WebGL renderer. Two real app bugs were fixed
 * in IdePane.tsx along the way: (1) the pane rendered null until open, so the
 * first-ever 'open-file' ran mountDoc before the editor host div existed and
 * silently dropped the editor; (2) the module's self-mount side effect plus
 * Shell's <IdePane /> produced two stacked pane instances.
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

  test('ctrl-click a printed path opens the IDE pane', async () => {
    const page = morz.page
    await waitForTerm(page, PANE_1, PROMPT_RE, 90_000)

    // The layout store may hold stray split panes from earlier suite runs
    // (APPDATA isolation is not airtight on Windows — app.getPath('appData')
    // resolves via the shell, not the env var). Close everything except the
    // default panes so term-1 is wide enough to print the path unwrapped.
    const strayPanes = page.locator(
      `section[aria-label^="Terminal"]:not([aria-label$="${PANE_1}"]):not([aria-label$="term-2"])`
    )
    while ((await strayPanes.count()) > 0) {
      await strayPanes
        .first()
        .locator('button[aria-label="Close pane"]')
        .click({ force: true })
      await page.waitForTimeout(500)
    }

    // Shell-reported grid — authoritative for the pixel→cell mapping. The fit
    // addon resizes the PTY shortly after launch, so poll until the size is
    // stable and wide enough for the target path to print unwrapped.
    let cols = 0
    let rows = 0
    for (let attempt = 0; attempt < 10 && cols <= 40; attempt++) {
      await page.waitForTimeout(1_000)
      await runInPane(
        page,
        PANE_1,
        `"MORZ_SZ${attempt}_$($Host.UI.RawUI.WindowSize.Width)x$($Host.UI.RawUI.WindowSize.Height)_END"`
      )
      const re = new RegExp(`MORZ_SZ${attempt}_(\\d+)x(\\d+)_END`)
      const buf = await waitForTerm(page, PANE_1, re)
      const m = re.exec(buf)!
      cols = Number(m[1])
      rows = Number(m[2])
    }
    expect(cols).toBeGreaterThan(40)
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
    // getByTitle, not a CSS attribute selector — backslashes in the Windows
    // path would be consumed as CSS escapes. Header span + tab both carry the
    // full path as title.
    await expect(page.getByTitle(target).first()).toBeVisible()
  })
})
