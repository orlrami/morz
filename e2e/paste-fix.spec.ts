import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import {
  closeMorz,
  launchMorz,
  PANE_1,
  PROMPT_RE,
  runInPane,
  waitForTerm,
  type MorzApp
} from './app'

async function setClipboard(app: ElectronApplication, text: string): Promise<void> {
  await app.evaluate(({ clipboard }, value) => clipboard.writeText(value), text)
}

async function resetTermText(page: Page): Promise<void> {
  await page.evaluate((paneId) => {
    const state = window as unknown as { __morzBuf?: Record<string, string> }
    if (state.__morzBuf) state.__morzBuf[paneId] = ''
  }, PANE_1)
}

async function expectSinglePaste(
  app: ElectronApplication,
  page: Page,
  action: () => Promise<void>
): Promise<void> {
  await resetTermText(page)
  await runInPane(page, PANE_1, '$global:MorzPasteCount = 0')
  await waitForTerm(page, PANE_1, PROMPT_RE)
  await setClipboard(app, '$global:MorzPasteCount++;')
  await resetTermText(page)
  await action()

  const textarea = page.locator(`[data-pane-id="${PANE_1}"] .xterm-helper-textarea`)
  await textarea.focus()
  await page.keyboard.press('Enter')
  await waitForTerm(page, PANE_1, PROMPT_RE)

  await resetTermText(page)
  await runInPane(
    page,
    PANE_1,
    'Write-Output ("MORZ_PASTE_" + "COUNT" + "=$global:MorzPasteCount")'
  )
  const buffer = await waitForTerm(page, PANE_1, /MORZ_PASTE_COUNT=\d+/)
  expect(buffer).toContain('MORZ_PASTE_COUNT=1')
}

async function expectBracketedPaste(
  app: ElectronApplication,
  page: Page,
  text: string,
  action: () => Promise<void>
): Promise<void> {
  await resetTermText(page)
  await runInPane(
    page,
    PANE_1,
    `node -e "process.stdout.write('\\x1b[?2004h');process.stdin.setRawMode(true);process.stdin.once('data',b=>{console.log(('MORZ_'+'RAW=')+b.toString('hex'));process.exit()})"`
  )
  await waitForTerm(page, PANE_1, /\x1b\[\?2004h/)
  await setClipboard(app, text)
  await resetTermText(page)
  await action()

  const buffer = await waitForTerm(page, PANE_1, /MORZ_RAW=[0-9a-f]+/)
  const received = /MORZ_RAW=([0-9a-f]+)/.exec(buffer)?.[1]
  expect(received).toBe(Buffer.from(`\x1b[200~${text}\x1b[201~`).toString('hex'))
  await waitForTerm(page, PANE_1, PROMPT_RE)
}

test.describe.serial('terminal paste', () => {
  let morz: MorzApp

  test.beforeAll(async () => {
    morz = await launchMorz()
    await waitForTerm(morz.page, PANE_1, PROMPT_RE, 90_000)
  })

  test.afterAll(async () => {
    if (morz) await closeMorz(morz.app)
  })

  for (const shortcut of ['Control+V', 'Control+Shift+V', 'Shift+Insert'] as const) {
    test(`${shortcut} pastes exactly once`, async () => {
      const terminal = morz.page.locator(`[data-pane-id="${PANE_1}"] .xterm`)
      await terminal.click()
      await expect(terminal.locator('.xterm-helper-textarea')).toBeFocused()

      await expectSinglePaste(morz.app, morz.page, () => morz.page.keyboard.press(shortcut))
    })
  }

  test('context-menu paste inserts exactly once', async () => {
    const terminal = morz.page.locator(`[data-pane-id="${PANE_1}"] .xterm`)

    await expectSinglePaste(morz.app, morz.page, async () => {
      await terminal.click({ button: 'right' })
      await morz.page.getByRole('button', { name: 'Paste', exact: true }).click()
    })
  })

  test('keyboard paste preserves bracketed-paste framing', async () => {
    const terminal = morz.page.locator(`[data-pane-id="${PANE_1}"] .xterm`)

    await expectBracketedPaste(morz.app, morz.page, 'MORZ_NATIVE_BRACKETED', async () => {
      await terminal.click()
      await morz.page.keyboard.press('Control+V')
    })
  })

  test('context-menu paste preserves bracketed-paste framing', async () => {
    const terminal = morz.page.locator(`[data-pane-id="${PANE_1}"] .xterm`)

    await expectBracketedPaste(morz.app, morz.page, 'MORZ_MENU_BRACKETED', async () => {
      await terminal.click({ button: 'right' })
      await morz.page.getByRole('button', { name: 'Paste', exact: true }).click()
    })
  })
})
