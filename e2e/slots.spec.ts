import { expect, test, type Page } from '@playwright/test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { closeMorz, launchMorz, waitForTerm, type MorzApp } from './app'

type SlotChoices = { git: string; review: string; editor: string }
type ExternalOpen = { command: string; args: string[] }

const slotEnv = {
  MORZ_E2E: '1',
  MORZ_E2E_SLOTS_STUB: '1',
  MORZ_E2E_SLOT_BINS: 'lazygit,code'
}

async function openIntegrations(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Settings' }).click()
  await page.getByRole('button', { name: 'Integrations' }).click()
  await expect(page.getByRole('heading', { name: 'Integrations' })).toBeVisible()
}

async function choices(page: Page): Promise<SlotChoices> {
  return page.evaluate(() =>
    (
      window as unknown as {
        morzSlots: { get(): Promise<SlotChoices> }
      }
    ).morzSlots.get()
  )
}

async function externalOpens(page: Page): Promise<ExternalOpen[]> {
  return page.evaluate(() =>
    (
      window as unknown as {
        morzSlotsTest: { externalOpens(): Promise<ExternalOpen[]> }
      }
    ).morzSlotsTest.externalOpens()
  )
}

test.describe.serial('integration slots', () => {
  let stubDir: string

  test.beforeAll(() => {
    stubDir = mkdtempSync(join(tmpdir(), 'morz-slots-'))
    writeFileSync(
      join(stubDir, 'lazygit.cmd'),
      '@echo off\r\necho MORZ_LAZYGIT_STUB\r\n',
      'utf8'
    )
  })

  test.afterAll(() => {
    rmSync(stubDir, { recursive: true, force: true })
  })

  test('lazygit launches in a dedicated pane and removes the Commit surface', async () => {
    const morz = await launchMorz({
      env: { ...slotEnv, PATH: `${stubDir};${process.env.PATH ?? ''}` }
    })
    try {
      await openIntegrations(morz.page)
      await morz.page.getByRole('radio', { name: 'lazygit' }).click()

      await expect(morz.page.getByRole('tab', { name: 'Commit' })).toHaveCount(0)
      await expect(morz.page.getByRole('status')).toContainText(
        'lazygit replaces the Morz Commit module'
      )

      await expect
        .poll(async () => {
          const panes = await morz.page.evaluate(() => window.morz.pty.list())
          return panes.find((paneId) => paneId.startsWith('slot-git-lazygit-')) ?? ''
        })
        .not.toBe('')
      const paneId = await morz.page.evaluate(async () => {
        const panes = await window.morz.pty.list()
        return panes.find((id) => id.startsWith('slot-git-lazygit-')) ?? ''
      })
      await waitForTerm(morz.page, paneId, /MORZ_LAZYGIT_STUB/)
    } finally {
      await closeMorz(morz.app)
    }
  })

  test('VS Code selection routes Explorer file opens through code -g', async () => {
    const morz = await launchMorz({ env: slotEnv })
    try {
      await openIntegrations(morz.page)
      await morz.page.getByRole('radio', { name: 'VS Code' }).click()
      await morz.page.getByRole('button', { name: 'Toggle file explorer' }).click()
      await morz.page.getByRole('button', { name: 'package.json' }).click()

      await expect.poll(() => externalOpens(morz.page)).toHaveLength(1)
      const [opened] = await externalOpens(morz.page)
      expect(opened.command).toBe('code')
      expect(opened.args).toEqual(['-g', expect.stringMatching(/package\.json:1$/)])
      await expect(morz.page.locator('.cm-editor')).not.toBeVisible()
    } finally {
      await closeMorz(morz.app)
    }
  })

  test('CodeRabbit hides Morz Reviewer and persists without storing credentials', async () => {
    let morz: MorzApp | undefined = await launchMorz({ env: slotEnv })
    const appDataDir = morz.appDataDir
    try {
      await openIntegrations(morz.page)
      await morz.page.getByRole('radio', { name: 'CodeRabbit' }).click()

      await expect(morz.page.getByRole('tab', { name: 'Review' })).toHaveCount(0)
      await expect(morz.page.getByRole('link', { name: 'CodeRabbit PR status' })).toBeVisible()
      expect(await choices(morz.page)).toEqual({
        git: 'terminal',
        review: 'coderabbit',
        editor: 'morz'
      })

      await closeMorz(morz.app)
      morz = undefined
      morz = await launchMorz({ appDataDir, env: slotEnv })
      expect(await choices(morz.page)).toEqual({
        git: 'terminal',
        review: 'coderabbit',
        editor: 'morz'
      })
      await expect(morz.page.getByRole('tab', { name: 'Review' })).toHaveCount(0)
    } finally {
      if (morz) await closeMorz(morz.app)
    }
  })

  test('missing binaries render disabled with an install link', async () => {
    const morz = await launchMorz({ env: slotEnv })
    try {
      await openIntegrations(morz.page)
      await expect(morz.page.getByRole('radio', { name: 'GitUI' })).toBeDisabled()
      await expect(morz.page.getByRole('link', { name: 'Install GitUI' })).toBeVisible()
    } finally {
      await closeMorz(morz.app)
    }
  })
})
