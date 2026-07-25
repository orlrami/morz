/*
 * w15/shell-layout — premium shell chrome gate.
 *  1. Old chrome is gone: no top view-tab strip, no AgentPillBar under the
 *     titlebar, no spaces sidebar. The 56px icon rail is the only view switcher.
 *  2. The rail renders enabled modules ONLY (modulesStore drives it live).
 *  3. The autonomy dial owns the orchestrator dock: Manual → zero orchestrator
 *     DOM, Assisted → one chip + closed-by-default dock, Orchestrated → auto-open.
 *  4. Statusbar groups: left context, CENTER dial, right meters + bell.
 */
import { test, expect } from '@playwright/test'
import { closeMorz, launchMorz, type MorzApp } from './app'

const ORCH_TOGGLE = '[aria-label="Toggle orchestrator"]'
const ORCH_DOCK = 'aside[aria-label="Orchestrator"]'

test.describe.serial('premium shell chrome (w15/shell-layout)', () => {
  let morz: MorzApp

  test.beforeAll(async () => {
    morz = await launchMorz()
  })

  test.afterAll(async () => {
    if (morz) await closeMorz(morz.app)
  })

  test('old chrome is gone; the icon rail is the only view switcher', async () => {
    const { page } = morz

    // titlebar = brand + space tabs only; the old horizontal view strip is dead
    await expect(page.getByRole('tablist', { name: 'Center view' })).toHaveCount(0)
    // AgentPillBar no longer lives under the titlebar (Manual boots dock-less,
    // so no pill bar may exist anywhere right now)
    await expect(page.getByRole('status').filter({ hasText: 'No active agents.' })).toHaveCount(0)
    // spaces sidebar retired — its jobs moved to titlebar tabs + statusbar
    await expect(page.getByRole('complementary', { name: 'Spaces sidebar' })).toHaveCount(0)

    // the rail: core group + vertical Views tablist
    const rail = page.getByTestId('icon-rail')
    await expect(rail).toBeVisible()
    await expect(rail.getByRole('tablist', { name: 'Views' })).toHaveAttribute(
      'aria-orientation',
      'vertical'
    )
    await expect(rail.getByRole('tab', { name: 'Terminals' })).toHaveAttribute(
      'aria-selected',
      'true'
    )
    await expect(rail.getByRole('button', { name: 'Toggle file explorer' })).toBeVisible()
    await expect(rail.getByRole('button', { name: 'Add modules' })).toBeVisible()
    await expect(rail.getByRole('button', { name: 'Settings' })).toBeVisible()

    // stage header carries the crumb + view title
    await expect(page.getByTestId('stage-header')).toContainText('Terminals')
  })

  test('rail renders enabled modules only; a disabled module loses icon and view', async () => {
    const { page } = morz
    const rail = page.getByTestId('icon-rail')

    // interim default: module views enabled → Commit is on the rail
    await expect(rail.getByRole('tab', { name: 'Commit' })).toBeVisible()

    // switch to the Commit view, then disable the module from the drawer
    await rail.getByRole('tab', { name: 'Commit' }).click()
    await expect(page.getByTestId('stage-header')).toContainText('Commit')

    await rail.getByRole('button', { name: 'Add modules' }).click()
    const drawer = page.getByTestId('module-drawer')
    await expect(drawer).toBeVisible()
    await drawer.getByRole('checkbox', { name: 'Module Commit' }).uncheck()

    // icon gone AND the active view fell back to Terminals
    await expect(rail.getByRole('tab', { name: 'Commit' })).toHaveCount(0)
    await expect(page.getByTestId('stage-header')).toContainText('Terminals')

    // re-enable → icon returns
    await drawer.getByRole('checkbox', { name: 'Module Commit' }).check()
    await expect(rail.getByRole('tab', { name: 'Commit' })).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(drawer).toHaveCount(0)
  })

  test('the dial owns the dock: Manual none, Assisted chip + closed, Orchestrated auto-open', async () => {
    const { page } = morz

    // Manual: zero orchestrator DOM (belt: manual-gate.spec proves this deeper)
    await expect(page.getByRole('radio', { name: 'Manual' })).toHaveAttribute('aria-checked', 'true')
    await expect(page.locator(ORCH_TOGGLE)).toHaveCount(0)
    await expect(page.locator(ORCH_DOCK)).toHaveCount(0)

    // Assisted: exactly one chip, dock closed by default
    await page.getByRole('radio', { name: 'Assisted' }).click()
    await expect(page.locator(ORCH_TOGGLE)).toHaveCount(1)
    await expect(page.locator(ORCH_DOCK)).toHaveCount(0)

    // the chip is the ONE control: open, then close
    await page.locator(ORCH_TOGGLE).click()
    await expect(page.locator(ORCH_DOCK)).toBeVisible()
    // live agents now render as the dock card (pill bar moved off the titlebar)
    await expect(
      page.locator(ORCH_DOCK).getByRole('status').filter({ hasText: 'No active agents.' })
    ).toBeVisible()
    await page.locator(ORCH_TOGGLE).click()
    await expect(page.locator(ORCH_DOCK)).toHaveCount(0)

    // Orchestrated: dock auto-opens
    await page.getByRole('radio', { name: 'Orchestrated' }).click()
    await expect(page.locator(ORCH_DOCK)).toBeVisible()

    // back to Manual: everything orchestrator vanishes
    await page.getByRole('radio', { name: 'Manual' }).click()
    await expect(page.locator(ORCH_TOGGLE)).toHaveCount(0)
    await expect(page.locator(ORCH_DOCK)).toHaveCount(0)
  })

  test('statusbar: left context, centered dial, right meters + bell', async () => {
    const { page } = morz
    const footer = page.locator('footer')

    await expect(footer.getByTestId('fleet-count')).toHaveText(/\d+ panes? · \d+ lanes?/)
    await expect(footer.getByRole('radiogroup', { name: 'Orchestration mode' })).toBeVisible()
    await expect(footer.getByTestId('session-cost-meter')).toBeVisible()
    await expect(footer.getByTestId('active-run-cost-meter')).toBeVisible()
    await expect(footer.getByRole('button', { name: /^Notifications/ })).toBeVisible()
  })
})

