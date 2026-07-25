/*
 * Module gating (w15/modules-core) — proves gating is REAL, not cosmetic:
 *  1. All modules off → only core surfaces exist (no module tab, button, or
 *     dock) AND the renderer produces ZERO module IPC traffic (asserted via
 *     the MORZ_E2E preload tap on ipcRenderer.invoke/send).
 *  2. Enabling orchestration from the module drawer surfaces the orchestrator
 *     without a restart, and the choice persists across relaunch (persisted
 *     rows beat the MORZ_MODULES seed).
 *  3. Autonomy interlock: disabling orchestration while the dial is
 *     Orchestrated drops the dial to Manual with a visible notice.
 */
import { test, expect } from '@playwright/test'
import { closeMorz, launchMorz, PANE_1, PROMPT_RE, runInPane, waitForTerm, type MorzApp } from './app'

/** Outbound IPC channels owned by modules — none may fire while all are off. */
const MODULE_CHANNEL_PREFIXES = [
  'sessions:', // session history/resume (NOT 'session:' — layout snapshot is core)
  'pulse:',
  'catalog:',
  'run:',
  'planner:',
  'planner-engine:',
  'organizer:',
  'browser:',
  'obsidian:',
  'commit:',
  'review:',
  'bus:',
  'dod:'
]

const MODULE_TABS = ['Commit', 'Review', 'Waves', 'Browser', 'Organizer', 'Sessions']
const ORCH_TOGGLE = '[aria-label="Toggle orchestrator"]'
const ORCH_PANEL = '[aria-label="Orchestrator"]'

function moduleIpcCalls(page: MorzApp['page']): Promise<string[]> {
  return page.evaluate((prefixes) => {
    const tap = (window as unknown as { morzE2eIpc?: { calls(): string[] } }).morzE2eIpc
    if (!tap) throw new Error('morzE2eIpc tap missing — launch with MORZ_E2E=1')
    return tap.calls().filter((channel) => prefixes.some((prefix) => channel.startsWith(prefix)))
  }, MODULE_CHANNEL_PREFIXES)
}

test.describe.serial('modules: all off = core only, enable = live', () => {
  let morz: MorzApp

  test.beforeAll(async () => {
    morz = await launchMorz({ env: { MORZ_MODULES: 'none', MORZ_E2E: '1' } })
  })

  test.afterAll(async () => {
    if (morz) await closeMorz(morz.app)
  })

  test('all-off leaves core surfaces only', async () => {
    const { page } = morz
    await expect(page.getByRole('tab', { name: 'Terminals' })).toBeVisible()
    for (const tab of MODULE_TABS) {
      await expect(page.getByRole('tab', { name: tab })).toHaveCount(0)
    }
    // Workshop button, orchestrator toggle, and dock all gone from the DOM.
    await expect(page.locator('[aria-label="Workshop"]')).toHaveCount(0)
    await expect(page.locator(ORCH_TOGGLE)).toHaveCount(0)
    await expect(page.locator(ORCH_PANEL)).toHaveCount(0)
    // Core stays: explorer toggle, settings, the module drawer affordance.
    await expect(page.locator('[aria-label="Toggle file explorer"]')).toBeVisible()
    await expect(page.locator('[aria-label="Settings"]')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Add modules' })).toBeVisible()
    // Orchestrated dial position requires the orchestration module.
    await expect(page.getByRole('radio', { name: 'Orchestrated' })).toHaveAttribute('aria-disabled', 'true')
  })

  test('all-off produces zero module IPC traffic', async () => {
    const { page } = morz
    // Real activity first — the app is alive, not idling.
    await waitForTerm(page, PANE_1, PROMPT_RE, 90_000)
    await runInPane(page, PANE_1, '"MORZ_MODULES_$(6*7)"')
    await waitForTerm(page, PANE_1, /MORZ_MODULES_42/)
    // Soak: give any lazily-registered sync time to (wrongly) fire.
    await page.waitForTimeout(8_000)
    expect(
      await moduleIpcCalls(page),
      'a disabled module generated IPC traffic — its sync registration is not gated'
    ).toEqual([])
  })

  test('enabling orchestration from the drawer surfaces it without restart', async () => {
    const { page } = morz
    await page.getByRole('button', { name: 'Add modules' }).click()
    const drawer = page.getByTestId('module-drawer')
    await expect(drawer).toBeVisible()

    // w16 regression: the drawer used to mount inside the 56px rail and render
    // as a clipped toggle column. It must be the full 320px sheet, flush with
    // the window's right edge, overlaying the stage — not confined to the rail.
    const drawerBox = await drawer.boundingBox()
    const viewport = page.viewportSize()
    expect(drawerBox, 'drawer has no bounding box').not.toBeNull()
    expect(drawerBox!.width, 'drawer clipped — narrower than 300px').toBeGreaterThanOrEqual(300)
    if (viewport) {
      expect(drawerBox!.x + drawerBox!.width).toBeGreaterThan(viewport.width - 4)
      expect(drawerBox!.x, 'drawer sits inside the 56px rail').toBeGreaterThan(56)
      expect(drawerBox!.height).toBeGreaterThanOrEqual(viewport.height - 4)
    }

    await page.getByTestId('module-toggle-orchestration').click()
    await expect(page.getByTestId('module-toggle-orchestration')).toHaveAttribute('aria-checked', 'true')
    await page.locator('[aria-label="Close module drawer"]').click()
    await expect(drawer).toHaveCount(0)

    // Live, no restart: the module's view and its dial position unlock.
    await expect(page.getByRole('tab', { name: 'Waves' })).toBeVisible()
    await expect(page.getByRole('radio', { name: 'Orchestrated' })).toHaveAttribute('aria-disabled', 'false')

    // w15/shell-layout — the orchestrator is DIAL-owned on top of the module
    // gate: enabling the module alone must not surface it while in Manual.
    await expect(page.locator(ORCH_TOGGLE)).toHaveCount(0)
    await expect(page.locator(ORCH_PANEL)).toHaveCount(0)
    await page.getByRole('radio', { name: 'Assisted', exact: true }).click()
    await expect(page.locator(ORCH_TOGGLE)).toBeVisible()
    await page.getByRole('radio', { name: 'Orchestrated' }).click()
    await expect(page.locator(ORCH_PANEL).first()).toBeVisible()
  })

  test('the choice persists across relaunch (seed never overrides saved rows)', async () => {
    await closeMorz(morz.app)
    morz = await launchMorz({
      appDataDir: morz.appDataDir,
      env: { MORZ_MODULES: 'none', MORZ_E2E: '1' }
    })
    const { page } = morz
    await expect(page.getByRole('tab', { name: 'Waves' })).toBeVisible()
    await expect(page.getByRole('tab', { name: 'Commit' })).toHaveCount(0)
  })
})

test.describe.serial('modules: Orchestrated-dial interlock', () => {
  let morz: MorzApp

  test.beforeAll(async () => {
    morz = await launchMorz({ env: { MORZ_MODULES: 'all' } })
  })

  test.afterAll(async () => {
    if (morz) await closeMorz(morz.app)
  })

  test('disabling orchestration while Orchestrated drops the dial to Manual with a notice', async () => {
    const { page } = morz
    const orchestrated = page.getByRole('radio', { name: 'Orchestrated' })
    await expect(orchestrated).toHaveAttribute('aria-disabled', 'false')
    await orchestrated.click()
    await expect(orchestrated).toHaveAttribute('aria-checked', 'true')

    await page.getByRole('button', { name: 'Add modules' }).click()
    await page.getByTestId('module-toggle-orchestration').click()
    await page.locator('[aria-label="Close module drawer"]').click()

    // Dial dropped to Manual; Orchestrated is now locked again.
    await expect(page.getByRole('radio', { name: 'Manual' })).toHaveAttribute('aria-checked', 'true')
    await expect(orchestrated).toHaveAttribute('aria-disabled', 'true')

    // Visible notice in the Notification Center.
    await page.locator('button[aria-label^="Notifications"]').click()
    const center = page.getByRole('dialog', { name: 'Notification center' })
    await expect(center).toBeVisible()
    await expect(center.locator('[data-notice-id="modules:orchestration-interlock"]')).toBeVisible()
    await expect(center.getByText('Autonomy dial dropped to Manual')).toBeVisible()
  })
})

/*
 * w16/polish-motion — the Voice module was removed from the registry. An old
 * profile still carries a persisted modules_enabled row with id 'voice';
 * hydration must ignore unknown ids (the isModuleId filter in ModulesStore.get)
 * instead of crashing or resurrecting the module.
 */
test.describe.serial('modules: stale persisted ids survive module removal', () => {
  let morz: MorzApp

  test.afterAll(async () => {
    if (morz) await closeMorz(morz.app)
  })

  test('a persisted voice row neither breaks hydration nor renders a toggle', async () => {
    morz = await launchMorz()
    await morz.app.evaluate(({ app }) => {
      const getBuiltinModule = (process as typeof process & {
        getBuiltinModule(id: string): unknown
      }).getBuiltinModule
      const { join } = getBuiltinModule('node:path') as typeof import('node:path')
      const { createRequire } = getBuiltinModule('node:module') as typeof import('node:module')
      const requireFromApp = createRequire(join(process.cwd(), 'package.json'))
      const Database = requireFromApp('better-sqlite3') as typeof import('better-sqlite3')
      const db = new Database(join(app.getPath('appData'), 'Morz', 'morz.db'))
      db.prepare(
        `INSERT INTO modules_enabled (id, enabled, updated_at) VALUES ('voice', 1, CURRENT_TIMESTAMP)
         ON CONFLICT(id) DO UPDATE SET enabled = 1`
      ).run()
      db.close()
    })
    const appDataDir = morz.appDataDir
    await closeMorz(morz.app)

    morz = await launchMorz({ appDataDir })
    const { page } = morz
    // Shell hydrates normally with the stale row present…
    await expect(page.getByRole('tab', { name: 'Terminals' })).toBeVisible()
    // …and the drawer lists only known modules — no Voice toggle, no crash.
    await page.getByRole('button', { name: 'Add modules' }).click()
    await expect(page.getByTestId('module-drawer')).toBeVisible()
    await expect(page.getByTestId('module-toggle-sessions')).toBeVisible()
    await expect(page.getByTestId('module-toggle-voice')).toHaveCount(0)
  })
})

