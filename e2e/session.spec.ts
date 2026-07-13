/*
 * Slice-2 torture: PTY survival. Closing the window must NOT kill the shell
 * (tray-resident PTY-host); reopening reattaches and replays scrollback, and
 * the shell keeps its state (cwd survives because it is the SAME process).
 *
 * Full app-relaunch snapshot restore (SQLite layout+scrollback after a hard
 * kill) is scaffolded in main (store/db.ts + SessionApi) but the renderer does
 * not call session.save/load yet — that case is test.fixme below.
 */
import { test, expect } from '@playwright/test'
import { tmpdir } from 'os'
import {
  attachPane,
  closeMorz,
  closeWindow,
  launchMorz,
  listPanes,
  PANE_1,
  PROMPT_RE,
  reopenWindow,
  runInPane,
  waitForTerm,
  type MorzApp
} from './app'

test.describe.serial('session survival (Slice 2)', () => {
  let morz: MorzApp

  test.beforeAll(async () => {
    morz = await launchMorz()
  })

  test.afterAll(async () => {
    if (morz) await closeMorz(morz.app)
  })

  test('close window → PTY lives → reopen reattaches with scrollback + cwd', async () => {
    let page = morz.page
    await waitForTerm(page, PANE_1, PROMPT_RE, 90_000)

    // Move the shell somewhere identifiable and drop computed markers.
    // The marker PREFIX is split across string concats: PSReadLine echoes every
    // keystroke (with redraws), so the typed line must never contain the
    // contiguous marker — only evaluated OUTPUT may match the assertion regex.
    const target = tmpdir()
    await runInPane(page, PANE_1, `Set-Location '${target}'`)
    await runInPane(page, PANE_1, '"MORZ_PW" + "D1_$((Get-Location).Path)_E" + "ND"')
    const before = await waitForTerm(page, PANE_1, /MORZ_PWD1_[^\r\n]*_END/)
    const cwdBefore = /MORZ_PWD1_(.*?)_END/.exec(before)![1]
    expect(cwdBefore.toLowerCase()).toBe(target.toLowerCase())
    await runInPane(page, PANE_1, '"MORZ_MARK_$(40+2)"')
    await waitForTerm(page, PANE_1, /MORZ_MARK_42/)

    // Close the window — app stays in the tray, PTYs keep running.
    await closeWindow(morz.app)

    // Reopen (tray "Open Morz" path = app 'activate').
    page = await reopenWindow(morz.app)
    morz.page = page

    // The pane is still live in the host…
    expect(await listPanes(page)).toContain(PANE_1)

    // …and an explicit reattach replays the scrollback containing our marker.
    // (did-finish-load already triggers a replay, but it can race the fresh
    // collector — attaching again is idempotent and deterministic.)
    await attachPane(page, PANE_1)
    await waitForTerm(page, PANE_1, /MORZ_MARK_42/)

    // Same process, same state: the shell still answers and kept its cwd.
    await runInPane(page, PANE_1, '"MORZ_PW" + "D2_$((Get-Location).Path)_E" + "ND"')
    const after = await waitForTerm(page, PANE_1, /MORZ_PWD2_[^\r\n]*_END/)
    const cwdAfter = /MORZ_PWD2_(.*?)_END/.exec(after)![1]
    expect(cwdAfter.toLowerCase()).toBe(cwdBefore.toLowerCase())
  })

  test.fixme(
    'hard-kill app → relaunch restores layout + scrollback from SQLite',
    async () => {
      // Blocked on renderer wiring: nothing calls window.morz.session.save/load
      // yet (main-side SessionApi + snapshot table exist). When wired:
      //   1. launchMorz() → mark pane → closeMorz() (full quit)
      //   2. launchMorz({ appDataDir: same }) → assert scrollback/layout restored.
    }
  )
})
