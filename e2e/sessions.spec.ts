import { expect, test } from '@playwright/test'
import { execFileSync } from 'child_process'
import { mkdirSync, rmSync, writeFileSync } from 'fs'
import { basename, join } from 'path'
import { closeMorz, launchMorz, type MorzApp, ROOT } from './app'

function createFixture(root: string, branch: string): void {
  mkdirSync(root, { recursive: true })
  writeFileSync(join(root, 'README.md'), `# ${basename(root)}\n`, 'utf8')
  execFileSync('git', ['init', '-b', branch], { cwd: root, windowsHide: true })
}

test.describe.serial('per-project session history (w11/sessions)', () => {
  let morz: MorzApp | undefined
  const fixtureParent = join(ROOT, 'e2e', '.tmp', `sessions-${Date.now()}`)
  const firstRoot = join(fixtureParent, 'alpha-space')
  const secondRoot = join(fixtureParent, 'beta-space')
  const firstName = basename(firstRoot)
  const secondName = basename(secondRoot)

  test.beforeAll(() => {
    createFixture(firstRoot, 'alpha-work')
    createFixture(secondRoot, 'beta-work')
    process.env.MORZ_E2E = '1'
  })

  test.afterAll(async () => {
    if (morz) await closeMorz(morz.app)
    delete process.env.MORZ_E2E
    delete process.env.MORZ_E2E_PICK_FOLDER
    rmSync(fixtureParent, { recursive: true, force: true })
  })

  test('keeps a newest-first live history scoped to the active space', async () => {
    process.env.MORZ_E2E_PICK_FOLDER = firstRoot
    morz = await launchMorz()
    let { page, appDataDir } = morz

    await page.getByRole('button', { name: 'Add space' }).click()
    const firstSpace = page.locator(`[data-space-name="${firstName}"]`)
    await expect(firstSpace).toHaveAttribute('data-active', 'true')

    await page.getByRole('tab', { name: 'Sessions' }).click()
    const firstPanel = page.getByRole('region', { name: 'Session history' })
    const firstLive = firstPanel.locator('[data-session-live="true"]')
    await expect(firstLive).toHaveCount(1)
    await expect(firstLive).toContainText('alpha-work')
    await expect(firstLive).toContainText('Live')

    await closeMorz(morz.app)
    morz = undefined

    process.env.MORZ_E2E_PICK_FOLDER = secondRoot
    morz = await launchMorz({ appDataDir })
    page = morz.page
    await page.getByRole('button', { name: 'Add space' }).click()
    const secondSpace = page.locator(`[data-space-name="${secondName}"]`)
    await expect(secondSpace).toHaveAttribute('data-active', 'true')

    await page.getByRole('tab', { name: 'Sessions' }).click()
    const secondPanel = page.getByRole('region', { name: 'Session history' })
    const secondLive = secondPanel.locator('[data-session-live="true"]')
    await expect(secondLive).toHaveCount(1)
    await expect(secondLive).toContainText('beta-work')
    await expect(secondPanel).not.toContainText('alpha-work')

    const firstSpaceAgain = page.locator(`[data-space-name="${firstName}"]`)
    await firstSpaceAgain.getByRole('button', { name: `Activate ${firstName}` }).click()
    await expect(firstSpaceAgain).toHaveAttribute('data-active', 'true')
    const firstPanelAgain = page.getByRole('region', { name: 'Session history' })
    const resumedFirstLive = firstPanelAgain.locator('[data-session-live="true"]')
    await expect(resumedFirstLive).toHaveCount(1)
    await expect(resumedFirstLive).toContainText('alpha-work')
    const firstRecords = firstPanelAgain.locator('[data-session-record]')
    await expect(firstRecords).toHaveCount(3)
    await expect(firstRecords.first()).toHaveAttribute('data-session-live', 'true')
    await expect(firstRecords.nth(1)).toHaveAttribute('data-session-live', 'false')
    await expect(firstPanelAgain).not.toContainText('beta-work')
  })
})
