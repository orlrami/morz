/*
 * Slice-1 torture: real shell spawns in a pane, bytes flow both ways, and the
 * real-PATH gate holds (npm resolves like it does in Windows Terminal).
 *
 * Output markers are built with subexpressions ("MORZ_E2E_$(1+1)" → MORZ_E2E_2)
 * so the assertion can only match shell OUTPUT, never the echo of our own
 * keystrokes.
 */
import { test, expect } from '@playwright/test'
import {
  closeMorz,
  launchMorz,
  PANE_1,
  PROMPT_RE,
  runInPane,
  waitForTerm,
  type MorzApp
} from './app'

test.describe.serial('terminal (Slice 1)', () => {
  let morz: MorzApp

  test.beforeAll(async () => {
    morz = await launchMorz()
  })

  test.afterAll(async () => {
    if (morz) await closeMorz(morz.app)
  })

  test('pane spawns a shell and a prompt appears', async () => {
    // First prompt covers ConPTY spawn + the login-shell PATH capture at host start.
    const buf = await waitForTerm(morz.page, PANE_1, PROMPT_RE, 90_000)
    expect(buf).toMatch(PROMPT_RE)

    // The pane actually mounted an xterm (WebGL canvas — content asserted via PTY bytes).
    const xterm = morz.page.locator('section[aria-label^="Terminal"] .xterm').first()
    await expect(xterm).toBeVisible()
  })

  test('echo round-trips through renderer → main → PTY-host → shell', async () => {
    // Literal echo per spec: the typed text renders back.
    await runInPane(morz.page, PANE_1, 'echo MORZ_E2E')
    await waitForTerm(morz.page, PANE_1, /MORZ_E2E/)

    // Stronger: computed marker only exists if the shell truly EVALUATED input.
    await runInPane(morz.page, PANE_1, '"MORZ_E2E_$(1+1)"')
    const buf = await waitForTerm(morz.page, PANE_1, /MORZ_E2E_2/)
    expect(buf).toContain('MORZ_E2E_2')
  })

  test('real-PATH gate: `where npm` resolves to an on-disk path', async () => {
    // where.exe output is an absolute path (C:\...npm.cmd) — the typed command
    // itself never contains a drive-letter path, so the regex only matches output.
    await runInPane(morz.page, PANE_1, 'where.exe npm')
    const buf = await waitForTerm(morz.page, PANE_1, /[A-Za-z]:\\[^\r\n]*npm[^\r\n]*/)
    expect(buf).toMatch(/[A-Za-z]:\\[^\r\n]*npm/)
  })
})
