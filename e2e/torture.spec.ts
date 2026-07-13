/*
 * Crash-resilience torture (Slice-1 limit tests + crash recovery state machine):
 *   1. 20-pane spawn storm — all live in list(), first/last still evaluate input
 *   2. resize storm — 50 rapid resizes don't corrupt the ConPTY round-trip
 *   3. PTY-host hard-kill — renderer survives (no white screen), every pane gets
 *      a tagged exit, the watchdog respawns the host, and a NEW pane works
 *
 * Ordering matters and the suite is serial: the host-kill test reaps every
 * pane the earlier tests created, so it runs last.
 */
import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { spawnSync } from 'child_process'
import {
  closeMorz,
  launchMorz,
  listPanes,
  PANE_1,
  PROMPT_RE,
  runInPane,
  waitForTerm,
  type MorzApp
} from './app'

/** Spawn a pane straight through the preload bridge (bypasses the UI). */
function spawnPane(page: Page, paneId: string): Promise<{ ok: boolean; error?: string }> {
  return page.evaluate(
    (id) =>
      (
        window as unknown as {
          morz: {
            pty: {
              spawn(o: {
                paneId: string
                shell: string
                cols: number
                rows: number
              }): Promise<{ ok: boolean; error?: string }>
            }
          }
        }
      ).morz.pty.spawn({ paneId: id, shell: 'pwsh', cols: 80, rows: 24 }),
    paneId
  )
}

/** Current PTY-host utilityProcess pid (exposed by main for exactly this spec). */
function hostPid(app: ElectronApplication): Promise<number | undefined> {
  return app.evaluate(
    () => (globalThis as Record<string, unknown>).__MORZ_PTY_HOST_PID as number | undefined
  )
}

test.describe.serial('torture (crash resilience)', () => {
  let morz: MorzApp

  test.beforeAll(async () => {
    morz = await launchMorz()
    // first prompt = ConPTY + login-shell PATH capture done; everything after is fast
    await waitForTerm(morz.page, PANE_1, PROMPT_RE, 90_000)
  })

  test.afterAll(async () => {
    if (morz) await closeMorz(morz.app)
  })

  test('20-pane spawn storm: all listed, first and last evaluate input', async () => {
    test.setTimeout(300_000)
    const ids = Array.from({ length: 20 }, (_, i) => `torture-${i + 1}`)
    const results = await Promise.all(ids.map((id) => spawnPane(morz.page, id)))
    for (const [i, r] of results.entries()) {
      expect(r.ok, `spawn ${ids[i]} failed: ${r.error ?? ''}`).toBe(true)
    }

    const live = await listPanes(morz.page)
    for (const id of ids) expect(live).toContain(id)

    // computed markers only appear if the shells truly EVALUATED input
    await waitForTerm(morz.page, ids[0], PROMPT_RE, 120_000)
    await runInPane(morz.page, ids[0], '"MORZ_STORM_$(1+1)"')
    await waitForTerm(morz.page, ids[0], /MORZ_STORM_2/, 120_000)

    await waitForTerm(morz.page, ids[19], PROMPT_RE, 120_000)
    await runInPane(morz.page, ids[19], '"MORZ_STORM_$(2+2)"')
    await waitForTerm(morz.page, ids[19], /MORZ_STORM_4/, 120_000)
  })

  test('resize storm: 50 rapid resizes, echo still round-trips', async () => {
    await morz.page.evaluate((id) => {
      const w = window as unknown as {
        morz: { pty: { resize(p: string, c: number, r: number): void } }
      }
      for (let i = 0; i < 50; i++) w.morz.pty.resize(id, 60 + (i % 60), 16 + (i % 24))
      w.morz.pty.resize(id, 100, 30) // land on a sane size
    }, PANE_1)

    await runInPane(morz.page, PANE_1, '"MORZ_RESIZE_$(3+3)"')
    const buf = await waitForTerm(morz.page, PANE_1, /MORZ_RESIZE_6/)
    expect(buf).toContain('MORZ_RESIZE_6')
  })

  test('PTY-host hard-kill: no white screen, panes get exit, watchdog respawns, new pane works', async () => {
    test.setTimeout(300_000)
    const { app, page } = morz

    // dedicated victim pane, proven alive RIGHT before the kill — under suite
    // load earlier panes' shells can legitimately die (and get pruned from the
    // journal), so the dead-pane assertion pins this one, not PANE_1
    const victim = 'torture-victim'
    expect((await spawnPane(page, victim)).ok).toBe(true)
    await waitForTerm(page, victim, PROMPT_RE, 120_000)

    // collect tagged exit messages the watchdog broadcasts for dead panes
    await page.evaluate(() => {
      const w = window as unknown as {
        __morzExits?: string[]
        morz: { pty: { onData(cb: (m: { type?: string; paneId: string }) => void): void } }
      }
      w.__morzExits = []
      w.morz.pty.onData((m) => {
        if (m.type === 'exit') w.__morzExits!.push(m.paneId)
      })
    })

    const pid = await hostPid(app)
    expect(pid).toBeGreaterThan(0)

    // simulate a host crash — /T on purpose omitted: the orphan sweep must reap
    // the children, not the test
    spawnSync('taskkill', ['/pid', String(pid), '/F'], { windowsHide: true, timeout: 15_000 })

    // watchdog respawned → the exposed pid changes. The evaluate context gets
    // destroyed transiently the instant the utilityProcess dies — swallow that
    // and keep polling (returning the OLD pid keeps the poll unsatisfied).
    await expect
      .poll(
        async () => {
          try {
            return (await hostPid(app)) ?? pid
          } catch {
            return pid
          }
        },
        { timeout: 120_000 }
      )
      .not.toBe(pid)

    // renderer never crashed: DOM intact and the shell chrome still there
    expect(await page.evaluate(() => document.body.children.length)).toBeGreaterThan(0)
    await expect(page.locator('section[aria-label^="Terminal"]').first()).toBeVisible()

    // the victim pane was reported dead to the renderer
    await expect
      .poll(
        () =>
          page.evaluate(
            () => (window as unknown as { __morzExits?: string[] }).__morzExits ?? []
          ),
        { timeout: 60_000 }
      )
      .toContain(victim)

    // fresh host is fully functional: NEW pane spawns and evaluates input
    const r = await spawnPane(page, 'torture-reborn')
    expect(r.ok, r.error ?? '').toBe(true)
    await waitForTerm(page, 'torture-reborn', PROMPT_RE, 120_000)
    await runInPane(page, 'torture-reborn', '"MORZ_REBORN_$(4+4)"')
    const buf = await waitForTerm(page, 'torture-reborn', /MORZ_REBORN_8/, 120_000)
    expect(buf).toContain('MORZ_REBORN_8')
  })
})
