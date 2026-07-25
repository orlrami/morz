import { expect, test } from '@playwright/test'
import type { MorzConnectionsApi } from '../src/shared/connections'
import { closeMorz, launchMorz, type MorzApp } from './app'

test.describe.serial('Orchestrator planner engine', () => {
  let morz: MorzApp

  test.beforeAll(async () => {
    process.env.MORZ_E2E = '1'
    morz = await launchMorz()
    await morz.page.getByRole('radio', { name: 'Orchestrated' }).click()
  })

  test.afterAll(async () => {
    if (morz) await closeMorz(morz.app)
    delete process.env.MORZ_E2E
  })

  test('engine options mirror the detected connections roster', async () => {
    const connections = await morz.page.evaluate(() =>
      (window as unknown as { morzConnections: MorzConnectionsApi }).morzConnections.list()
    )
    const installed = new Map(connections.map((connection) => [connection.id, connection.installed]))
    const selector = morz.page.getByRole('combobox', { name: 'Planner engine' })
    const expected: Array<[string, boolean]> = [
      ['fast', installed.get('claude') === true || installed.get('codex') === true],
      ['claude', installed.get('claude') === true],
      ['codex', installed.get('codex') === true],
      ['opencode', installed.get('opencode') === true],
      ['local', installed.get('agy') === true]
    ]

    for (const [value, detected] of expected) {
      const option = selector.locator(`option[value="${value}"]`)
      await expect(option).toHaveCount(1)
      if (detected) {
        await expect(option).toBeEnabled()
      } else {
        await expect(option).toBeDisabled()
        await expect(option).toHaveAttribute('title', 'not detected on PATH')
      }
    }
  })

  test('selecting Codex routes planning to the Codex adapter stub and persists', async () => {
    const selector = morz.page.getByRole('combobox', { name: 'Planner engine' })
    // w15/planner-fast-default — fresh installs default to the fast race.
    await expect(selector).toHaveValue('fast')
    await expect(morz.page.getByRole('combobox', { name: 'Planner Claude model' })).toHaveValue('sonnet')
    await selector.selectOption('codex')

    await morz.page.getByRole('textbox', { name: 'Goal' }).fill('MORZ_E2E codex route')
    await morz.page.getByRole('button', { name: 'Plan team' }).click()

    const card = morz.page.getByRole('region', { name: 'Spawn plan' })
    await expect(card).toContainText('MORZ_E2E Codex planner')

    const appDataDir = morz.appDataDir
    await closeMorz(morz.app)
    morz = await launchMorz({ appDataDir })
    await morz.page.getByRole('radio', { name: 'Orchestrated' }).click()
    await expect(morz.page.getByRole('combobox', { name: 'Planner engine' })).toHaveValue('codex')
    await morz.page.getByRole('region', { name: 'Spawn plan' }).getByRole('button', { name: 'Discard' }).click()
    await expect(morz.page.getByRole('region', { name: 'Spawn plan' })).toHaveCount(0)
  })

  test('Claude schema failure retries once then falls back to Codex with notice', async () => {
    const selector = morz.page.getByRole('combobox', { name: 'Planner engine' })
    await selector.selectOption('claude')
    await morz.page.getByRole('textbox', { name: 'Goal' }).fill('MORZ_E2E claude-fails fallback')
    await morz.page.getByRole('button', { name: 'Plan team' }).click()

    const card = morz.page.getByRole('region', { name: 'Spawn plan' })
    await expect(card).toContainText('MORZ_E2E Codex planner')
    await expect(
      morz.page.getByText(
        'Claude could not produce a valid plan after retry; used Codex instead.',
        { exact: true }
      )
    ).toBeVisible()
  })
})

test('live Claude, Codex, OpenCode, and local planners each produce a valid SpawnPlan', async () => {
  test.skip(process.env.MORZ_LIVE_PLANNER !== '1', 'Set MORZ_LIVE_PLANNER=1 for the live CLI gate.')
  test.setTimeout(900_000)
  delete process.env.MORZ_E2E
  const morz = await launchMorz()
  try {
    await morz.page.getByRole('radio', { name: 'Orchestrated' }).click()
    const requested = process.env.MORZ_LIVE_PLANNER_ENGINE
    const engines =
      requested === 'claude' ||
      requested === 'codex' ||
      requested === 'opencode' ||
      requested === 'local'
      ? [requested]
      : ['claude', 'codex', 'opencode', 'local'] as const
    for (const engine of engines) {
      await morz.page.getByRole('combobox', { name: 'Planner engine' }).selectOption(engine)
      await morz.page
        .getByRole('textbox', { name: 'Goal' })
        .fill(`Plan one documentation-only agent for a harmless README wording check using ${engine}. Do not modify files.`)
      await morz.page.getByRole('button', { name: 'Plan team' }).click()
      const card = morz.page.getByRole('region', { name: 'Spawn plan' })
      const alert = morz.page.getByRole('alert')
      await expect(card.or(alert)).toBeVisible({ timeout: engine === 'local' ? 360_000 : 180_000 })
      if (await alert.isVisible()) throw new Error(await alert.textContent() ?? 'Planner failed')
      await expect(card.getByText('PROPOSED', { exact: true })).toBeVisible()
      await card.getByRole('button', { name: 'Discard' }).click()
      await expect(card).toHaveCount(0)
    }
  } finally {
    await closeMorz(morz.app)
  }
})
