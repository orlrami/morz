/*
 * Regression coverage for the original terminal-link IDE flow. Wave 15 keeps
 * the editor internals and removes any center-view placement: the same file now
 * opens in the fixed-width slide-over.
 */
import { expect, test } from '@playwright/test'
import { join } from 'path'
import { closeMorz, launchMorz, ROOT, type MorzApp } from './app'
import { openTerminalPath } from './ide-helpers'

test.describe.serial('IDE pane (Slice 3, adapted for Wave 15)', () => {
  let morz: MorzApp

  test.beforeAll(async () => {
    morz = await launchMorz()
  })

  test.afterAll(async () => {
    if (morz) await closeMorz(morz.app)
  })

  test('ctrl-click opens the file in the overlay, never a center view', async () => {
    const page = morz.page
    const target = join(ROOT, 'package.json')
    await openTerminalPath(page, target)

    const overlay = page.getByTestId('ide-overlay')
    await expect(overlay).toBeVisible()
    await expect(overlay).toHaveCSS('width', '660px')
    await expect(page.getByTitle(target).first()).toBeVisible()
    await expect(page.getByRole('tab', { name: /IDE/i })).toHaveCount(0)
  })
})
