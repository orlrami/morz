import { expect, test } from '@playwright/test'
import { closeMorz, launchMorz, type MorzApp } from './app'

test.describe.serial('Settings UX', () => {
  let morz: MorzApp

  test.beforeAll(async () => {
    morz = await launchMorz()
  })

  test.afterAll(async () => {
    if (morz) await closeMorz(morz.app)
  })

  test('centers tab content and scrolls the last control into view', async () => {
    const { page } = morz
    await page.setViewportSize({ width: 1600, height: 720 })
    await page.getByRole('button', { name: 'Settings' }).click()

    const settings = page.getByRole('region', { name: 'Settings' })
    await expect(settings).toBeVisible()

    const scrollArea = settings.locator('.overflow-y-auto').first()
    const content = scrollArea.locator('div').first()
    const [scrollBox, contentBox] = await Promise.all([
      scrollArea.boundingBox(),
      content.boundingBox()
    ])
    expect(scrollBox).not.toBeNull()
    expect(contentBox).not.toBeNull()
    expect(
      Math.abs(
        contentBox!.x - scrollBox!.x - (scrollBox!.x + scrollBox!.width - contentBox!.x - contentBox!.width)
      )
    ).toBeLessThanOrEqual(2)

    await page.getByRole('button', { name: 'Control' }).click()
    const lastControl = page.getByRole('button', { name: 'Check for updates' })
    await lastControl.scrollIntoViewIfNeeded()
    await expect(lastControl).toBeVisible()
    await expect
      .poll(() => scrollArea.evaluate((element) => element.scrollTop))
      .toBeGreaterThan(0)
  })

  test('previews an Appearance theme without leaving Settings', async () => {
    const { page } = morz
    await page.getByRole('button', { name: 'Settings' }).click()
    await page.getByRole('button', { name: 'Appearance' }).click()
    await expect(page.getByRole('heading', { name: 'Appearance' })).toBeVisible()

    const previousPageColor = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--color-page').trim()
    )
    await page.getByRole('button', { name: /Slate/ }).click()

    await expect
      .poll(() =>
        page.evaluate(() =>
          getComputedStyle(document.documentElement).getPropertyValue('--color-page').trim()
        )
      )
      .not.toBe(previousPageColor)
    await expect(page.getByRole('region', { name: 'Settings' })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Appearance' })).toBeVisible()
  })
})
