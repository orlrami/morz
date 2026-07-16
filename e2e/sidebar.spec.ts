import { expect, test } from '@playwright/test'
import { execFileSync } from 'child_process'
import { mkdirSync, rmSync } from 'fs'
import { basename, join } from 'path'
import { closeMorz, launchMorz, type MorzApp } from './app'

test.describe.serial('spaces sidebar live state (w10/sidebar)', () => {
  let morz: MorzApp | undefined
  const fixtureRoot = join(__dirname, '.tmp', `sidebar-project-${Date.now()}`)
  const fixtureName = basename(fixtureRoot)

  test.beforeAll(() => {
    mkdirSync(fixtureRoot, { recursive: true })
    execFileSync('git', ['init', '-b', 'sidebar-real-branch'], {
      cwd: fixtureRoot,
      windowsHide: true
    })
    process.env.MORZ_E2E = '1'
    process.env.MORZ_E2E_PICK_FOLDER = fixtureRoot
  })

  test.afterAll(async () => {
    if (morz) await closeMorz(morz.app)
    delete process.env.MORZ_E2E
    delete process.env.MORZ_E2E_PICK_FOLDER
    rmSync(fixtureRoot, { recursive: true, force: true })
  })

  test('shows the active fixture branch and an honest no-agents state', async () => {
    morz = await launchMorz()
    const sidebar = morz.page.getByRole('complementary', { name: 'Spaces sidebar' })

    await sidebar.getByRole('button', { name: 'Open folder' }).click()
    await expect(sidebar.locator(`[data-space-name="${fixtureName}"]`)).toHaveAttribute(
      'data-active',
      'true'
    )

    await expect(sidebar.getByTestId('active-space-branch')).toContainText(
      'sidebar-real-branch'
    )
    await expect(sidebar).toContainText('No agents running here yet')
    await expect(sidebar).not.toContainText(
      /morz-core|api-service|builder-1|builder-2|Decomposing phase 5|wt\/builder/i
    )
  })
})
