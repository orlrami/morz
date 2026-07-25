/*
 * w16/polish-motion — motion pass contract:
 *  1. prefers-reduced-motion: reduce ⇒ panels mount/unmount in place, no
 *     slide, no transition styles (framer's useReducedMotion drops every
 *     transition to duration 0 — the IdePane pattern, now shell-wide).
 *  2. Animated mounts still settle to identity transforms and exits still
 *     unmount (AnimatePresence completes), so no spec ever races a spring.
 *  3. The Ctrl-K palette is Spotlight geometry: centered, top ~28%, 560px.
 */
import { expect, test } from '@playwright/test'
import { closeMorz, launchMorz, type MorzApp } from './app'

test.describe.serial('motion: reduced motion means no motion', () => {
  let morz: MorzApp

  test.beforeAll(async () => {
    morz = await launchMorz()
    // framer's useReducedMotion snapshots the media query at component mount
    // (it is deliberately not reactive) — emulate first, then reload so every
    // shell component mounts with the preference already active.
    await morz.page.emulateMedia({ reducedMotion: 'reduce' })
    await morz.page.reload()
    await morz.page.waitForLoadState('domcontentloaded')
    await expect(morz.page.getByRole('tab', { name: 'Terminals' })).toBeVisible({ timeout: 15_000 })
  })

  test.afterAll(async () => {
    if (morz) await closeMorz(morz.app)
  })

  test('explorer panel mounts in place — no slide, identity transform', async () => {
    const { page } = morz
    await page.keyboard.press('Control+b')
    const panel = page.getByTestId('explorer-panel')
    await expect(panel).toBeVisible()

    const first = await panel.boundingBox()
    await page.waitForTimeout(150) // a live spring would still be moving here
    expect(await panel.boundingBox()).toEqual(first)
    await expect(panel).toHaveCSS('transform', 'none')

    await page.keyboard.press('Control+b')
    await expect(panel).toHaveCount(0) // exit is instant too
  })

  test('orchestrator dock mounts in place — no slide, instant exit', async () => {
    const { page } = morz
    await page.getByRole('radio', { name: 'Assisted', exact: true }).click()
    await page.getByRole('button', { name: 'Toggle orchestrator' }).click()
    const dock = page.locator('[aria-label="Orchestrator"]')
    await expect(dock).toBeVisible()

    const first = await dock.boundingBox()
    await page.waitForTimeout(150)
    expect(await dock.boundingBox()).toEqual(first)
    await expect(dock).toHaveCSS('transform', 'none')

    await page.getByRole('button', { name: 'Toggle orchestrator' }).click()
    await expect(dock).toHaveCount(0)
    await page.getByRole('radio', { name: 'Manual', exact: true }).click()
  })
})

test.describe.serial('motion: animated mounts settle; Spotlight geometry', () => {
  let morz: MorzApp

  test.beforeAll(async () => {
    morz = await launchMorz()
  })

  test.afterAll(async () => {
    if (morz) await closeMorz(morz.app)
  })

  test('explorer slides to rest and unmounts after its exit', async () => {
    const { page } = morz
    await page.keyboard.press('Control+b')
    const panel = page.getByTestId('explorer-panel')
    await expect(panel).toBeVisible()
    // springs.panel settles well inside the 250ms budget; framer renders an
    // identity transform ('none') once the slide completes.
    await expect(panel).toHaveCSS('transform', 'none', { timeout: 1_500 })

    await page.keyboard.press('Control+b')
    await expect(panel).toHaveCount(0) // AnimatePresence exit completed
  })

  test('orchestrator dock slides in and its exit completes', async () => {
    const { page } = morz
    await page.getByRole('radio', { name: 'Assisted', exact: true }).click()
    await page.getByRole('button', { name: 'Toggle orchestrator' }).click()
    const dock = page.locator('[aria-label="Orchestrator"]')
    await expect(dock).toBeVisible()
    await expect(dock).toHaveCSS('transform', 'none', { timeout: 1_500 })

    await page.getByRole('button', { name: 'Toggle orchestrator' }).click()
    await expect(dock).toHaveCount(0)
  })

  test('center view switch fades the new view in with no layout shift', async () => {
    const { page } = morz
    const center = page.getByTestId('center-view')
    const before = await center.boundingBox()
    await page.getByRole('button', { name: 'Settings' }).click()
    await expect(page.getByRole('region', { name: 'Settings' })).toBeVisible()
    await expect(center).toHaveCSS('opacity', '1', { timeout: 1_000 })
    expect(await center.boundingBox()).toEqual(before) // fade only, same slot
    await page.getByRole('tab', { name: 'Terminals' }).click()
    await expect(page.getByTestId('stage-header')).toContainText('Terminals')
  })

  test('Ctrl-K palette lands at Spotlight geometry: centered, top ~28%, 560px', async () => {
    const { page } = morz
    await page.keyboard.press('Control+k')
    const dialog = page.getByRole('dialog', { name: 'Command palette' })
    await expect(dialog).toBeVisible()
    await page.waitForTimeout(400) // let springs.float settle before measuring

    const viewport = await page.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }))
    const box = await dialog.boundingBox()
    if (!box) throw new Error('palette dialog has no bounding box')
    expect(Math.abs(box.width - 560)).toBeLessThan(2)
    expect(Math.abs(box.x + box.width / 2 - viewport.w / 2)).toBeLessThan(8)
    expect(Math.abs(box.y - viewport.h * 0.28)).toBeLessThan(40)

    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
  })
})
