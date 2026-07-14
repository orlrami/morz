/*
 * Interactive Claude — LIVE (w5/bugfix, wave-5 agent 1).
 *
 * Gated on MORZ_LIVE=1 (spawns the user's real `claude` CLI; the TUI itself
 * makes no API calls until prompted, so these tests cost ~nothing):
 *
 *   $env:MORZ_LIVE='1'; npx playwright test e2e/claude-interactive.spec.ts
 *
 * Covers the two user-reported bugs:
 *   A) "Text from the Claude window doesn't appear on the terminal" — the
 *      real claude TUI must render its output in a Morz pane.
 *   B) "Typing commands like /config shows nothing" — /config must show its
 *      real settings UI (headless -p stream-json answers slash commands with
 *      "isn't available in this environment", verified live — only the
 *      interactive TUI can run them).
 */
import { test, expect } from '@playwright/test'
import {
  closeMorz,
  launchMorz,
  PANE_1,
  PROMPT_RE,
  runInPane,
  termText,
  waitForTerm,
  writePane,
  type MorzApp
} from './app'

test.skip(process.env.MORZ_LIVE !== '1', 'set MORZ_LIVE=1 to run the live interactive-claude tests')

const LANE_PANE = 'section[aria-label^="Claude lane"]'
const START_LANE = '[aria-label="Start Claude here"]'
/** Claude Code welcome banner / retitle — proves TUI output reached the pane. */
const CLAUDE_TUI_RE = /Claude Code/
/** The /config settings panel (search box is unique to it). */
const CONFIG_UI_RE = /Search settings/

test.describe.serial('interactive claude — live', () => {
  let morz: MorzApp

  test.beforeAll(async () => {
    morz = await launchMorz()
  })
  test.afterAll(async () => {
    if (morz) await closeMorz(morz.app)
  })

  test('claude TUI inside a hooked pwsh pane renders text and /config', async () => {
    test.setTimeout(300_000)
    const { page } = morz
    // OSC-133 hook active in this pane (spawned with MORZ_BLOCK_NONCE).
    await waitForTerm(page, PANE_1, PROMPT_RE, 90_000)
    await runInPane(page, PANE_1, 'claude')
    await waitForTerm(page, PANE_1, CLAUDE_TUI_RE, 120_000) // bug A: text arrives
    await waitForTerm(page, PANE_1, /❯/, 120_000) // input prompt ready
    await page.waitForTimeout(5_000)
    await writePane(page, PANE_1, '/config')
    await page.waitForTimeout(2_000) // slash-command palette debounce
    await writePane(page, PANE_1, '\r')
    await waitForTerm(page, PANE_1, CONFIG_UI_RE, 120_000) // bug B: /config UI shows
    // esc out + exit; the hooked pwsh prompt must come back clean (OSC marks
    // did not corrupt the TUI, and the hook resumes after it). Only the bytes
    // AFTER the exit keystrokes count — the pre-launch prompt already matches.
    await writePane(page, PANE_1, '\x1b')
    await page.waitForTimeout(1_000)
    const offset = (await termText(page, PANE_1)).length
    await writePane(page, PANE_1, '\x03')
    await page.waitForTimeout(500)
    await writePane(page, PANE_1, '\x03')
    await page.waitForFunction(
      (o) => {
        const buf =
          (window as unknown as { __morzBuf?: Record<string, string> }).__morzBuf?.['term-1'] ?? ''
        // signed prompt-start mark followed by a fresh pwsh prompt
        return /\]133;A;nonce=[^\x07]*\x07PS [^\r\n]*>/.test(buf.slice(o))
      },
      offset,
      { timeout: 60_000, polling: 250 }
    )
  })

  test('interactive lane launches real claude; /config shows its UI', async () => {
    test.setTimeout(300_000)
    const { page } = morz
    await page.getByRole('radio', { name: 'Assisted' }).dispatchEvent('click')
    await expect(page.getByRole('radio', { name: 'Assisted' })).toHaveAttribute(
      'aria-checked',
      'true'
    )
    await page.locator(START_LANE).first().dispatchEvent('click')
    const lane = page.locator(LANE_PANE)
    await expect(lane).toHaveCount(1)

    // Interactive is the default; nothing spawns until the explicit launch.
    const label = await lane.getAttribute('aria-label')
    const agentId = label!.replace('Claude lane — ', '')
    const ttyPane = `tty-${agentId}`
    await lane.locator('[aria-label="Launch interactive claude"]').dispatchEvent('click')
    await waitForTerm(page, ttyPane, CLAUDE_TUI_RE, 120_000) // bug A in the lane
    // wait for the input prompt (startup hooks can stream for a long while)
    await waitForTerm(page, ttyPane, /❯/, 120_000)
    await page.waitForTimeout(5_000)
    await writePane(page, ttyPane, '/config')
    await page.waitForTimeout(2_000)
    await writePane(page, ttyPane, '\r')
    try {
      await waitForTerm(page, ttyPane, CONFIG_UI_RE, 120_000) // bug B in the lane
    } catch (err) {
      console.log('--- tty tail ---\n' + JSON.stringify((await termText(page, ttyPane)).slice(-3000)))
      throw err
    }

    // Structured variant is still one click away (adapter path unchanged).
    // (plain `textarea` is ambiguous here — xterm keeps a helper textarea)
    await lane.getByRole('tab', { name: 'Structured' }).dispatchEvent('click')
    await expect(lane.getByPlaceholder(/Prompt Claude/)).toBeVisible()
  })
})
