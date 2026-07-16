import { expect, test } from '@playwright/test'
import { execFileSync } from 'child_process'
import { mkdirSync, rmSync, writeFileSync } from 'fs'
import { basename, join } from 'path'
import {
  closeMorz,
  launchMorz,
  PANE_1,
  PANE_2,
  PROMPT_RE,
  runInPane,
  termText,
  waitForTerm,
  type MorzApp
} from './app'

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

test.describe.serial('real space management (w9/spaces)', () => {
  let morz: MorzApp | undefined
  const fixtureRoot = join(__dirname, '.tmp', `spaces-project-${Date.now()}`)
  const fixtureName = basename(fixtureRoot)
  const migrationRoot = join(__dirname, '.tmp', `spaces-migration-${Date.now()}`)

  test.beforeAll(() => {
    mkdirSync(fixtureRoot, { recursive: true })
    mkdirSync(migrationRoot, { recursive: true })
    writeFileSync(join(fixtureRoot, 'fixture-space-file.txt'), 'space fixture\n', 'utf8')
    execFileSync('git', ['init', '-b', 'spaces-fixture'], { cwd: fixtureRoot, windowsHide: true })
    process.env.MORZ_E2E = '1'
    process.env.MORZ_E2E_PICK_FOLDER = fixtureRoot
  })

  test.afterAll(async () => {
    if (morz) await closeMorz(morz.app)
    delete process.env.MORZ_E2E
    delete process.env.MORZ_E2E_PICK_FOLDER
    rmSync(fixtureRoot, { recursive: true, force: true })
    rmSync(migrationRoot, { recursive: true, force: true })
  })

  test('open, use, remove, and persist a real project folder', async () => {
    morz = await launchMorz()
    const { page, appDataDir } = morz

    await page.getByRole('button', { name: 'Open folder' }).click()
    const space = page.locator(`[data-space-name="${fixtureName}"]`)
    await expect(space).toBeVisible()

    await space.getByRole('button', { name: `Activate ${fixtureName}` }).click()
    await expect(space).toHaveAttribute('data-active', 'true')
    await expect(space).toContainText('spaces-fixture')

    await page.getByRole('button', { name: 'Toggle file explorer' }).click()
    const explorer = page.getByRole('complementary', { name: 'File explorer' })
    await expect(explorer).toContainText('fixture-space-file.txt')

    const originalPane = page.locator('section[aria-label^="Terminal"] .xterm').first()
    await originalPane.click({ button: 'right' })
    await page.getByRole('button', { name: 'Split right' }).click()

    const panes = page.locator('section[aria-label^="Terminal"]')
    await expect(panes).toHaveCount(3)
    const paneIds = await panes.evaluateAll((elements) =>
      elements.map((element) => element.getAttribute('data-pane-id'))
    )
    const paneId = paneIds.find((id) => id !== PANE_1 && id !== PANE_2)
    expect(paneId).toBeTruthy()
    await waitForTerm(page, paneId!, PROMPT_RE, 90_000)
    await runInPane(page, paneId!, '"MORZ_SPACE_CWD=$((Get-Location).Path)"')
    await expect
      .poll(() => termText(page, paneId!), { timeout: 60_000 })
      .toMatch(new RegExp(`MORZ_SPACE_CWD=[A-Za-z]:\\\\[^\\r\\n]*${escapeRegExp(fixtureName)}`, 'i'))

    await page.getByRole('radio', { name: 'Assisted' }).click()
    await page
      .locator(`section[data-pane-id="${PANE_1}"]`)
      .getByRole('button', { name: 'Start Claude here' })
      .click()
    const lane = page.locator('section[aria-label^="Claude lane"]')
    await expect(lane).toContainText(fixtureRoot)
    await explorer.getByRole('button', { name: 'Close explorer' }).click()

    const seedSpace = page.locator('[data-space-name="morz"]')
    if (await seedSpace.count()) {
      await seedSpace.getByRole('button', { name: 'Activate morz' }).click()
      const seedLaneButton = page
        .locator(`section[data-pane-id="${PANE_1}"]`)
        .getByRole('button', { name: 'Start Claude here' })
      await expect(seedLaneButton).toBeEnabled()
      await seedLaneButton.click()
      await expect(page.locator('section[aria-label^="Claude lane"]')).toHaveCount(2)
      await expect(
        page
          .locator('section[aria-label^="Claude lane"]')
          .filter({ hasText: /C:\\Projects\\morz(?![-\\])/i })
      ).toBeVisible()
    }
    const closeLaneButtons = page.getByRole('button', { name: 'Close lane' })
    while (await closeLaneButtons.count()) await closeLaneButtons.first().click()

    await space.getByRole('button', { name: `Activate ${fixtureName}` }).click()

    await space.click({ button: 'right' })
    await page.getByRole('menuitem', { name: `Rename ${fixtureName}` }).click()
    const renameDialog = page.getByRole('dialog', { name: 'Rename space' })
    await renameDialog.getByRole('textbox', { name: 'Space name' }).fill(`${fixtureName}-renamed`)
    await renameDialog.getByRole('button', { name: 'Save' }).click()
    const renamedSpace = page.locator(`[data-space-name="${fixtureName}-renamed"]`)
    await expect(renamedSpace).toBeVisible()

    await closeMorz(morz.app)
    morz = undefined
    morz = await launchMorz({ appDataDir })
    await expect(
      morz.page.locator(`[data-space-name="${fixtureName}-renamed"]`)
    ).toHaveAttribute('data-active', 'true')

    await closeMorz(morz.app)
    morz = undefined
    rmSync(fixtureRoot, { recursive: true, force: true })
    morz = await launchMorz({ appDataDir })
    const unavailableSpace = morz.page.locator(`[data-space-name="${fixtureName}-renamed"]`)
    await expect(unavailableSpace).toHaveAttribute('title', `${fixtureRoot} is unavailable`)
    await expect(
      unavailableSpace.getByRole('button', { name: `Activate ${fixtureName}-renamed` })
    ).toBeDisabled()

    await unavailableSpace.click({ button: 'right' })
    morz.page.once('dialog', (dialog) => dialog.accept())
    await morz.page.getByRole('menuitem', { name: `Remove ${fixtureName}-renamed` }).click()
    await expect(unavailableSpace).toHaveCount(0)

    await closeMorz(morz.app)
    morz = undefined
    morz = await launchMorz({ appDataDir })
    await expect(morz.page.locator(`[data-space-name="${fixtureName}-renamed"]`)).toHaveCount(0)

    await morz.page.evaluate(
      ({ validRoot, missingRoot }) => {
        localStorage.setItem(
          'morz.spaces',
          JSON.stringify({
            version: 1,
            state: {
              spaces: [
                {
                  id: 'legacy-custom',
                  name: 'Legacy custom space',
                  root: validRoot,
                  agents: [
                    { id: 'valid-agent', name: 'valid-agent', cli: 'codex', root: validRoot },
                    { id: 'stale-agent', name: 'stale-agent', cli: 'claude', root: missingRoot }
                  ]
                }
              ]
            }
          })
        )
      },
      { validRoot: migrationRoot, missingRoot: join(migrationRoot, 'missing-agent-worktree') }
    )
    await morz.page.reload()
    const migrated = morz.page.locator('[data-space-name="Legacy custom space"]')
    await expect(migrated).toHaveAttribute('data-active', 'true')
    await expect(migrated).not.toContainText('valid-agent')
    await expect(migrated).not.toContainText('stale-agent')
    await expect(
      morz.page.getByRole('complementary', { name: 'Spaces sidebar' })
    ).toContainText('No agents running here yet')
  })
})
