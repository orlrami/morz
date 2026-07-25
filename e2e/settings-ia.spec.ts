import { expect, test } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { closeMorz, launchMorz, ROOT, type MorzApp } from './app'

const SECTION_LABELS = [
  'Modules',
  'Connections & Models',
  'Integrations',
  'Autonomy & Permissions',
  'Planner',
  'Memory',
  'Routing',
  'Limits & Usage',
  'Sessions & History',
  'Notifications',
  'Appearance',
  'About'
] as const

test.describe.serial('Settings information architecture', () => {
  let morz: MorzApp

  test.beforeAll(async () => {
    morz = await launchMorz()
  })

  test.afterAll(async () => {
    if (morz) await closeMorz(morz.app)
  })

  test('renders the grouped settings nav and reaches every section', async () => {
    const { page } = morz
    await page.getByRole('button', { name: 'Settings', exact: true }).click()

    const settings = page.getByRole('region', { name: 'Settings' })
    await expect(settings).toBeVisible()
    await expect(settings.getByText('Workspace', { exact: true })).toBeVisible()
    await expect(settings.getByText('Agents', { exact: true })).toBeVisible()
    await expect(settings.getByText('App', { exact: true })).toBeVisible()

    for (const label of SECTION_LABELS) {
      await settings.getByRole('button', { name: label, exact: true }).click()
      await expect(settings.getByText(`Settings / ${label}`, { exact: true })).toBeVisible()
      // w15 integration — the placeholders were replaced by the real slices.
      if (label === 'Modules') {
        await expect(settings.getByTestId('module-toggle-orchestration')).toBeVisible()
        await expect(settings.getByRole('button', { name: 'Run setup again' })).toBeVisible()
      }
      if (label === 'Connections & Models') {
        await expect(settings.getByTestId('model-card-claude')).toBeVisible()
      }
      if (label === 'Integrations') {
        await expect(settings.getByTestId('settings-mount-integrations')).toBeVisible()
      }
    }
  })

  test('keeps every legacy settings panel reachable in the new nav', async () => {
    const { page } = morz
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    const settings = page.getByRole('region', { name: 'Settings' })

    await settings.getByRole('button', { name: 'Limits & Usage', exact: true }).click()
    await expect(settings.getByText('No CLI usage data is available')).toBeVisible()

    await settings.getByRole('button', { name: 'Sessions & History', exact: true }).click()
    await expect(settings.getByLabel('Run history policy setting')).toBeVisible()

    await settings.getByRole('button', { name: 'Autonomy & Permissions', exact: true }).click()
    await expect(settings.getByText('Default mode for new spaces')).toBeVisible()
    await expect(settings.getByText('Auto-answer known CLI prompts (watchdog)')).toBeVisible()

    await settings.getByRole('button', { name: 'Planner', exact: true }).click()
    await expect(settings.getByRole('region', { name: 'Report AI settings' })).toBeVisible()
    await expect(settings.getByRole('region', { name: 'Assistant settings' })).toBeVisible()

    await settings.getByRole('button', { name: 'Memory', exact: true }).click()
    await expect(settings.getByRole('region', { name: 'Learning memory' })).toBeVisible()

    await settings.getByRole('button', { name: 'Routing', exact: true }).click()
    await expect(settings.getByRole('region', { name: 'Routing settings' })).toBeVisible()

    await settings.getByRole('button', { name: 'Notifications', exact: true }).click()
    await expect(settings.getByLabel('Daily Pulse settings')).toBeVisible()

    await settings.getByRole('button', { name: 'Appearance', exact: true }).click()
    await expect(settings.getByRole('heading', { name: 'Appearance' })).toBeVisible()
    await expect(settings.getByRole('button', { name: /Import theme file/ })).toBeVisible()

    await settings.getByRole('button', { name: 'About', exact: true }).click()
    await expect(settings.getByRole('region', { name: 'Update settings' })).toBeVisible()
    await expect(settings.getByRole('heading', { name: 'About Morz' })).toBeVisible()
  })

  test('keeps settings deep links landing on the migrated section', async () => {
    const { page } = morz
    await page.keyboard.press('Control+K')
    await page.getByPlaceholder(/Type a command/).fill('settings: appearance')
    await page.getByRole('button', { name: 'settings: appearance' }).click()
    await expect(page.getByText('Settings / Appearance', { exact: true })).toBeVisible()

    await page.keyboard.press('Control+K')
    await page.getByPlaceholder(/Type a command/).fill('settings: open memory settings')
    await page.getByRole('button', { name: 'settings: open memory settings' }).click()
    await expect(page.getByText('Settings / Memory', { exact: true })).toBeVisible()
    await expect(page.getByRole('region', { name: 'Learning memory' })).toBeVisible()
  })

  test('imports each legacy settings panel exactly once from SettingsPanel', () => {
    const source = readFileSync(
      join(ROOT, 'src', 'renderer', 'src', 'components', 'SettingsPanel.tsx'),
      'utf8'
    )
    for (const component of [
      'ConnectionsSettings',
      'ReportSettings',
      'AssistantSettings',
      'PulseSettings',
      'MemorySettings',
      'RoutingSettings',
      'ObsidianSettings',
      'VoiceSettings',
      'UpdateSettings'
    ]) {
      expect(source.split(`import { ${component} }`).length - 1).toBe(1)
    }
  })
})
