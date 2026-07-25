import { expect, test } from '@playwright/test'
import { join } from 'path'
import { closeMorz, launchMorz, type MorzApp } from './app'

interface PulseBridge {
  snapshot(): Promise<{
    settings: { nextFire: number | null; spaceRoot: string }
    briefs: { id: string; createdAt: number; spaceRoot: string; markdown: string; trigger: 'scheduled' | 'manual' }[]
    pendingNotices: { source: string; title: string }[]
  }>
  configure(input: {
    enabled: boolean
    time: string
    mode: 'manual' | 'assisted' | 'orchestrated'
    spaceRoot: string
  }): Promise<unknown>
  runNow(input: {
    mode: 'manual' | 'assisted' | 'orchestrated'
    spaceRoot: string
  }): Promise<unknown>
  testNextFire(time: string, now: number): Promise<number>
}

test.describe.serial('Daily Pulse', () => {
  let morz: MorzApp

  test.beforeAll(async () => {
    process.env.MORZ_E2E = '1'
    morz = await launchMorz()
  })

  test.afterAll(async () => {
    delete process.env.MORZ_E2E
    if (morz) await closeMorz(morz.app)
  })

  test('scheduled fire-time math chooses today or tomorrow in local time', async () => {
    const cases = [
      {
        now: new Date(2026, 6, 14, 7, 45, 0, 0),
        time: '08:30',
        expected: new Date(2026, 6, 14, 8, 30, 0, 0)
      },
      {
        now: new Date(2026, 6, 14, 8, 30, 0, 0),
        time: '08:30',
        expected: new Date(2026, 6, 15, 8, 30, 0, 0)
      },
      {
        now: new Date(2026, 10, 1, 23, 59, 59, 999),
        time: '00:00',
        expected: new Date(2026, 10, 2, 0, 0, 0, 0)
      }
    ]

    for (const entry of cases) {
      const actual = await morz.page.evaluate(
        ({ time, now }) =>
          (window as unknown as { morzPulse: PulseBridge }).morzPulse.testNextFire(time, now),
        { time: entry.time, now: entry.now.getTime() }
      )
      expect(actual).toBe(entry.expected.getTime())
    }
  })

  test('disabled and Manual mode both refuse to run', async () => {
    const root = join(__dirname, '..')
    await expect(
      morz.page.evaluate((spaceRoot) =>
        (window as unknown as { morzPulse: PulseBridge }).morzPulse.runNow({
          mode: 'assisted',
          spaceRoot
        }), root)
    ).rejects.toThrow(/disabled/i)

    await morz.page.evaluate((spaceRoot) =>
      (window as unknown as { morzPulse: PulseBridge }).morzPulse.configure({
        enabled: true,
        time: '08:00',
        mode: 'manual',
        spaceRoot
      }), root)
    await expect(
      morz.page.evaluate((spaceRoot) =>
        (window as unknown as { morzPulse: PulseBridge }).morzPulse.runNow({
          mode: 'manual',
          spaceRoot
        }), root)
    ).rejects.toThrow(/Manual mode/i)
    await expect(
      morz.page.evaluate((spaceRoot) =>
        (window as unknown as { morzPulse: PulseBridge }).morzPulse.runNow({
          mode: 'assisted',
          spaceRoot
        }), root)
    ).rejects.toThrow(/Manual mode/i)
    const missingRoot = join(root, 'removed-space')
    await expect(
      morz.page.evaluate((spaceRoot) =>
        (window as unknown as { morzPulse: PulseBridge }).morzPulse.configure({
          enabled: false,
          time: '08:00',
          mode: 'manual',
          spaceRoot
        }), missingRoot)
    ).resolves.toBeTruthy()
    await morz.page.evaluate((spaceRoot) =>
      (window as unknown as { morzPulse: PulseBridge }).morzPulse.configure({
        enabled: false,
        time: '08:00',
        mode: 'manual',
        spaceRoot
      }), root)
  })

  test('Enable then Run now stores and surfaces the fixed E2E brief', async () => {
    const { page } = morz
    await page.getByRole('radio', { name: 'Assisted' }).click()
    await page.getByRole('button', { name: 'Settings' }).click()
    await page.getByRole('button', { name: 'Notifications', exact: true }).click()

    const enable = page.getByRole('checkbox', { name: 'Enable Daily Pulse' })
    await expect(enable).not.toBeChecked()
    await enable.check()
    await page.getByRole('button', { name: 'Run Daily Pulse now' }).click()

    await expect(page.getByText('Daily Pulse ready', { exact: true })).toBeVisible()
    await expect(page.getByTestId('pulse-brief')).toContainText('MORZ_E2E daily pulse brief')
    await expect(page.getByTestId('pulse-brief')).toContainText('Top 3 next actions')

    const configured = await page.evaluate(() =>
      (window as unknown as { morzPulse: PulseBridge }).morzPulse.snapshot()
    )
    for (let index = 0; index < 14; index += 1) {
      await page.evaluate((spaceRoot) =>
        (window as unknown as { morzPulse: PulseBridge }).morzPulse.runNow({
          mode: 'assisted',
          spaceRoot
        }), configured.settings.spaceRoot)
    }

    const firstSnapshot = await page.evaluate(() =>
      (window as unknown as { morzPulse: PulseBridge }).morzPulse.snapshot()
    )
    expect(firstSnapshot.briefs[0]?.markdown).toContain('MORZ_E2E daily pulse brief')
    expect(firstSnapshot.briefs).toHaveLength(14)
    expect(firstSnapshot.settings.nextFire).toBeGreaterThan(Date.now())

    const appDataDir = morz.appDataDir
    await closeMorz(morz.app)
    morz = await launchMorz({ appDataDir })
    const restored = await morz.page.evaluate(() =>
      (window as unknown as { morzPulse: PulseBridge }).morzPulse.snapshot()
    )
    expect(restored.briefs[0]?.markdown).toContain('MORZ_E2E daily pulse brief')
    expect(restored.settings.nextFire).toBeGreaterThan(Date.now())
    const notifyItems = await morz.page.evaluate(async () => {
      const notify = (window as unknown as {
        morz?: { notify?: { list(): Promise<{ source: string; title: string }[]> } }
      }).morz?.notify
      return notify ? notify.list() : []
    })
    expect(
      [...restored.pendingNotices, ...notifyItems].some(
        (notice) => notice.source === 'pulse' && notice.title === 'Daily Pulse ready'
      )
    ).toBe(true)

    const latest = restored.briefs[0]
    await morz.app.evaluate(({ BrowserWindow }, brief) => {
      BrowserWindow.getAllWindows()[0]?.webContents.send('pulse:open', brief)
    }, latest)
    await expect(morz.page.getByLabel('Daily Pulse settings')).toBeVisible()
    await expect(morz.page.getByTestId('pulse-brief')).toContainText('MORZ_E2E daily pulse brief')
  })
})
