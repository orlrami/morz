import { expect, test } from '@playwright/test'
import { execFileSync } from 'child_process'
import { mkdirSync, rmSync, writeFileSync } from 'fs'
import { basename, join } from 'path'
import { closeMorz, launchMorz, type MorzApp } from './app'

test.describe.serial('titlebar space tabs (w10/tabs)', () => {
  let morz: MorzApp | undefined
  const fixtureRoot = join(__dirname, '.tmp', `space-tabs-project-${Date.now()}`)
  const fixtureName = basename(fixtureRoot)
  const otherRoot = join(__dirname, '.tmp', `space-tabs-other-${Date.now()}`)
  const otherName = basename(otherRoot)

  test.beforeAll(() => {
    mkdirSync(fixtureRoot, { recursive: true })
    mkdirSync(otherRoot, { recursive: true })
    writeFileSync(join(fixtureRoot, 'space-tab-fixture.txt'), 'space tab fixture\n', 'utf8')
    execFileSync('git', ['init', '-b', 'space-tabs-fixture'], {
      cwd: fixtureRoot,
      windowsHide: true
    })
    execFileSync('git', ['init', '-b', 'space-tabs-other'], {
      cwd: otherRoot,
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
    rmSync(otherRoot, { recursive: true, force: true })
  })

  test('adds, switches, and removes spaces without phase-0 mock tabs', async () => {
    morz = await launchMorz()
    const { page } = morz
    // Seed-verify-retry (same pattern as commit-ai's openCommitPage): the OLD
    // page's zustand persist can flush one final 'morz.spaces' write AFTER our
    // seed and wipe it during reload — reseed deterministically until the
    // seeded tab actually renders.
    const tablist = page.getByRole('tablist', { name: 'Spaces' })
    let seeded = false
    for (let attempt = 0; attempt < 3 && !seeded; attempt += 1) {
      await page.evaluate(
        ({ id, name, root }) => {
          const spaces = Array.from({ length: 10 }, (_, index) => ({
            id: index === 0 ? id : `space-tabs-overflow-${index}`,
            name: index === 0 ? name : `Overflow space ${index} with a deliberately long name`,
            root,
            agents: []
          }))
          localStorage.setItem(
            'morz.spaces',
            JSON.stringify({
              version: 2,
              state: {
                spaces,
                activeSpaceId: id,
                initialized: true
              }
            })
          )
        },
        { id: 'space-tabs-other', name: otherName, root: otherRoot }
      )
      await page.reload()
      try {
        await expect(tablist.getByRole('tab', { name: otherName })).toBeAttached({ timeout: 5_000 })
        seeded = true
      } catch {
        // persist race wiped the seed — reseed on the fresh page and retry
      }
    }
    expect(seeded, 'seeded spaces survived reload').toBe(true)

    await expect(page.locator('body')).not.toContainText(/morz-core|api-service/)

    await tablist.getByRole('button', { name: 'Add space' }).click()
    const fixtureTab = tablist.getByRole('tab', { name: fixtureName })
    const fixtureSidebar = page.locator(`[data-space-name="${fixtureName}"]`)
    await expect(fixtureTab).toBeVisible()
    await expect(fixtureTab).toHaveAttribute('aria-selected', 'true')
    await expect(fixtureSidebar).toHaveAttribute('data-active', 'true')

    const otherTab = tablist.getByRole('tab', { name: otherName })
    await otherTab.click()
    await expect(otherTab).toHaveAttribute('aria-selected', 'true')
    await expect(page.locator(`[data-space-name="${otherName}"]`)).toHaveAttribute('data-active', 'true')
    await expect(fixtureSidebar).toHaveAttribute('data-active', 'false')
    await expect
      .poll(() =>
        page.evaluate((name) => {
          const tab = Array.from(document.querySelectorAll<HTMLElement>('[data-space-tab]')).find(
            (candidate) => candidate.dataset.spaceTab === name
          )
          const scroller = tab?.parentElement
          if (!tab || !scroller) return false
          const tabRect = tab.getBoundingClientRect()
          const scrollerRect = scroller.getBoundingClientRect()
          return tabRect.left >= scrollerRect.left && tabRect.right <= scrollerRect.right
        }, otherName)
      )
      .toBe(true)

    await expect(otherTab).toHaveAttribute('tabindex', '0')
    await expect(fixtureTab).toHaveAttribute('tabindex', '-1')
    await otherTab.press('End')
    await expect(fixtureTab).toHaveAttribute('aria-selected', 'true')
    await expect(fixtureSidebar).toHaveAttribute('data-active', 'true')
    await otherTab.click()

    await fixtureTab.hover()
    const removeButton = tablist.getByRole('button', { name: `Remove ${fixtureName}` })
    await expect(removeButton).toBeVisible()
    page.once('dialog', async (dialog) => {
      expect(dialog.message()).toBe(
        `Remove ${fixtureName} from Morz? This only removes the space; files on disk will not be changed.`
      )
      await dialog.accept()
    })
    await removeButton.click()
    await expect(fixtureTab).toHaveCount(0)
    await expect(fixtureSidebar).toHaveCount(0)
  })
})
