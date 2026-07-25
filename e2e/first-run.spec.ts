import { expect, test } from '@playwright/test'
import { closeMorz, launchMorz, passStartScreen, type MorzApp } from './app'

test.describe.serial('first-run onboarding', () => {
  test('fresh boot shows configuration and the preview reacts before save', async () => {
    const morz = await launchMorz({ skipOnboarding: false, env: { MORZ_MODULES: 'defaults' } })
    try {
      const { page } = morz
      await expect(page.getByRole('heading', { name: 'Make Morz yours' })).toBeVisible()
      await expect(page.getByTestId('onboarding-cli-row')).toHaveCount(9)
      await expect(page.getByLabel(/^Default model for /)).toHaveCount(9)

      const preview = page.getByRole('region', { name: 'Live preview' })
      await expect(preview.getByRole('tab', { name: 'Waves' })).toHaveCount(0)
      await expect(page.getByRole('radio', { name: 'Orchestrated' })).toBeDisabled()

      await page.getByRole('checkbox', { name: 'Enable Orchestration' }).click()
      await expect(preview.getByRole('tab', { name: 'Waves' })).toBeVisible()
      await expect(page.getByRole('radio', { name: 'Orchestrated' })).toBeEnabled()

      await page.getByLabel('Default model for Claude Code').selectOption('sonnet')
      await expect(preview.getByText('claude --model sonnet', { exact: true })).toBeVisible()

      await page.getByLabel('Code review').selectOption('coderabbit')
      await expect(preview.getByText('Code review: CodeRabbit', { exact: true })).toBeVisible()

      // w16 — frameless window: the setup surface must carry a drag strip so
      // the window can be moved (interactivity above is proof clicks still land).
      const dragRegion = await page
        .getByTestId('onboarding-drag-strip')
        .evaluate((el) => getComputedStyle(el).getPropertyValue('-webkit-app-region'))
      expect(dragRegion.trim()).toBe('drag')
    } finally {
      await closeMorz(morz.app)
    }
  })

  test('saved choices persist and match the rendered shell', async () => {
    let morz: MorzApp = await launchMorz({ skipOnboarding: false, env: { MORZ_MODULES: 'defaults' } })
    const appDataDir = morz.appDataDir
    try {
      await morz.page.getByRole('checkbox', { name: 'Enable Commit' }).click()
      await morz.page.getByRole('checkbox', { name: 'Enable Orchestration' }).click()
      await morz.page.getByRole('button', { name: 'Open Morz' }).click()
      await passStartScreen(morz.page)

      await expect(morz.page.getByRole('tab', { name: 'Commit', exact: true })).toBeVisible()
      await expect(morz.page.getByRole('tab', { name: 'Waves', exact: true })).toBeVisible()

      await closeMorz(morz.app)
      morz = await launchMorz({ appDataDir, skipOnboarding: false, env: { MORZ_MODULES: 'defaults' } })
      await passStartScreen(morz.page)
      await expect(morz.page.getByRole('heading', { name: 'Make Morz yours' })).toHaveCount(0)
      await expect(morz.page.getByRole('tab', { name: 'Commit', exact: true })).toBeVisible()
      await expect(morz.page.getByRole('tab', { name: 'Waves', exact: true })).toBeVisible()
    } finally {
      await closeMorz(morz.app)
    }
  })

  test('Skip saves the minimal shell and Settings can run setup again', async () => {
    let morz: MorzApp = await launchMorz({ skipOnboarding: false, env: { MORZ_MODULES: 'defaults' } })
    const appDataDir = morz.appDataDir
    try {
      await morz.page.getByRole('button', { name: /Skip.+start minimal/i }).click()
      await passStartScreen(morz.page)
      await expect(morz.page.getByRole('tab', { name: 'Terminals', exact: true })).toBeVisible()
      await expect(morz.page.getByRole('tab', { name: 'Sessions', exact: true })).toBeVisible()
      await expect(morz.page.getByRole('tab', { name: 'Commit', exact: true })).toHaveCount(0)
      await expect(morz.page.getByRole('tab', { name: 'Waves', exact: true })).toHaveCount(0)
      await expect(morz.page.getByRole('button', { name: 'Toggle orchestrator' })).toHaveCount(0)

      await closeMorz(morz.app)
      morz = await launchMorz({ appDataDir, skipOnboarding: false, env: { MORZ_MODULES: 'defaults' } })
      await passStartScreen(morz.page)
      await expect(morz.page.getByRole('heading', { name: 'Make Morz yours' })).toHaveCount(0)

      await morz.page.getByRole('button', { name: 'Settings', exact: true }).click()
      await morz.page.getByRole('region', { name: 'Settings' }).getByRole('button', { name: 'Modules', exact: true }).click()
      await morz.page.getByRole('button', { name: 'Run setup again' }).click()
      await expect(morz.page.getByRole('heading', { name: 'Make Morz yours' })).toBeVisible()
    } finally {
      await closeMorz(morz.app)
    }
  })
})




