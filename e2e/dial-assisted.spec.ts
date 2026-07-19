import { expect, test, type Locator, type Page } from '@playwright/test'
import { closeMorz, launchMorz, type MorzApp } from './app'

type Mode = 'Manual' | 'Assisted' | 'Orchestrated'

const MODES: Mode[] = ['Manual', 'Assisted', 'Orchestrated']
const MODE_ID: Record<Mode, Lowercase<Mode>> = {
  Manual: 'manual',
  Assisted: 'assisted',
  Orchestrated: 'orchestrated'
}

async function clickRenderedSegment(page: Page, segment: Locator): Promise<void> {
  await expect(segment).toBeVisible()
  const beforeHover = await segment.boundingBox()
  expect(beforeHover, 'mode segment must have a rendered hit box').not.toBeNull()
  expect(beforeHover!.width, 'mode segment hit target width').toBeGreaterThanOrEqual(36)
  expect(beforeHover!.height, 'mode segment hit target height').toBeGreaterThanOrEqual(22)

  const x = beforeHover!.x + beforeHover!.width / 2
  const y = beforeHover!.y + beforeHover!.height / 2
  await page.mouse.move(x, y)
  await page.waitForTimeout(250)

  const afterHover = await segment.boundingBox()
  expect(afterHover, 'mode segment must stay rendered while hovered').not.toBeNull()
  expect(afterHover!.x).toBeCloseTo(beforeHover!.x, 1)
  expect(afterHover!.y).toBeCloseTo(beforeHover!.y, 1)
  expect(afterHover!.width).toBeCloseTo(beforeHover!.width, 1)
  expect(afterHover!.height).toBeCloseTo(beforeHover!.height, 1)

  await page.mouse.click(x, y)
}

async function expectSelected(page: Page, selected: Mode): Promise<void> {
  for (const mode of MODES) {
    await expect(page.getByRole('radio', { name: mode, exact: true })).toHaveAttribute(
      'aria-checked',
      String(mode === selected)
    )
  }
}

async function expectPersisted(page: Page, selected: Mode): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate(() => {
        const raw = localStorage.getItem('morz.mode')
        if (!raw) return null
        return (JSON.parse(raw) as { state?: { mode?: string } }).state?.mode ?? null
      })
    )
    .toBe(MODE_ID[selected])
}

test.describe.serial('Mode dial real-pointer selection', () => {
  let morz: MorzApp

  test.beforeAll(async () => {
    morz = await launchMorz()
  })

  test.afterAll(async () => {
    if (morz) await closeMorz(morz.app)
  })

  test('reaches Assisted from every neighboring state with coordinate clicks', async () => {
    await morz.app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.setSize(940, 600)
    })
    await expectSelected(morz.page, 'Manual')
    const sequence: Mode[] = ['Manual', 'Assisted', 'Orchestrated', 'Assisted', 'Manual']

    for (const mode of sequence) {
      await test.step(`select ${mode}`, async () => {
        const segment = morz.page.getByRole('radio', { name: mode, exact: true })
        await clickRenderedSegment(morz.page, segment)
        await expectSelected(morz.page, mode)
        await expectPersisted(morz.page, mode)
      })
    }

    await test.step('persist Assisted across a full relaunch', async () => {
      await clickRenderedSegment(
        morz.page,
        morz.page.getByRole('radio', { name: 'Assisted', exact: true })
      )
      await expectSelected(morz.page, 'Assisted')
      await expectPersisted(morz.page, 'Assisted')

      const { appDataDir } = morz
      await closeMorz(morz.app)
      morz = await launchMorz({ appDataDir })
      await expectSelected(morz.page, 'Assisted')
      await expectPersisted(morz.page, 'Assisted')
    })
  })
})
