import { expect, test } from '@playwright/test'
import { existsSync } from 'fs'
import { join } from 'path'
import { closeMorz, launchMorz, ROOT, type MorzApp } from './app'

test.describe('Morz app identity', () => {
  let morz: MorzApp

  test.beforeAll(async () => {
    morz = await launchMorz()
  })

  test.afterAll(async () => {
    if (morz) await closeMorz(morz.app)
  })

  test('boots with the branded window icon resource and no default menu', async () => {
    expect(existsSync(join(ROOT, 'resources', 'icon.png'))).toBe(true)
    await expect
      .poll(() => morz.app.evaluate(({ Menu }) => Menu.getApplicationMenu()))
      .toBeNull()
  })

  test('keeps app-level Ctrl+K and Ctrl+B shortcuts without the menu', async () => {
    const { page } = morz

    await page.keyboard.press('Control+k')
    await expect(page.getByRole('dialog', { name: 'Command palette' })).toBeVisible()
    await page.keyboard.press('Escape')

    await page.keyboard.press('Control+b')
    await expect(page.getByRole('complementary', { name: 'File explorer' })).toBeVisible()
  })

  test('uses the Morz Signal for the orchestrator toggle and panel header', async () => {
    const { page } = morz
    const toggle = page.getByRole('button', { name: 'Toggle orchestrator' })
    const panel = page.getByRole('complementary', { name: 'Orchestrator' })

    await expect(toggle.getByTestId('morz-signal')).toBeVisible()
    await expect(panel.getByTestId('morz-signal')).toBeVisible()
    await expect(panel.getByText('Orchestrator', { exact: true })).toHaveCSS(
      'font-family',
      /Hanken Grotesk/
    )
  })
})
