import { expect, test } from '@playwright/test'
import { closeMorz, launchMorz, type MorzApp } from './app'

interface CostTestBridge {
  testTrack(input: {
    runId: string
    agentId: string
    usage: { usd?: number; tokens?: number }
    caps?: { maxUsd: number | null; maxTokens: number | null }
  }): Promise<void>
}

test.describe.serial('cost/token kill-switch', () => {
  let morz: MorzApp

  test.beforeAll(async () => {
    process.env.MORZ_E2E = '1'
    morz = await launchMorz()
  })

  test.afterAll(async () => {
    if (morz) await closeMorz(morz.app)
    delete process.env.MORZ_E2E
  })

  test('warns at 80% and pauses the run after the token cap is breached', async () => {
    const { app, page } = morz
    await page.waitForFunction(
      () => typeof (window as unknown as { morzCost?: CostTestBridge }).morzCost?.testTrack === 'function'
    )

    await expect(page.getByTestId('session-cost-meter')).toHaveText('Session —')
    await expect(page.getByTestId('active-run-cost-meter')).toHaveText('Run —')
    await app.evaluate(({ ipcMain }) => {
      const state = globalThis as unknown as { __morzCostInterrupts: string[] }
      state.__morzCostInterrupts = []
      ipcMain.removeAllListeners('claude:interrupt')
      ipcMain.on('claude:interrupt', (_event, message: { agentId: string }) => {
        state.__morzCostInterrupts.push(message.agentId)
      })
    })

    await page.evaluate(async () => {
      const cost = (window as unknown as { morzCost: CostTestBridge }).morzCost
      await cost.testTrack({
        runId: 'e2e-cost-run',
        agentId: 'agent-cost-1',
        caps: { maxUsd: null, maxTokens: 1_000 },
        usage: { tokens: 800 }
      })
    })

    const meter = page.getByRole('meter', { name: 'Active run token cap' })
    await expect(meter).toHaveAttribute('aria-valuenow', '80')
    await expect(page.getByTestId('active-run-cost-meter')).toContainText('800 tok')
    await expect(page.getByText('Run paused: cost cap reached')).toHaveCount(0)
    expect(
      await app.evaluate(
        () => (globalThis as unknown as { __morzCostInterrupts: string[] }).__morzCostInterrupts
      )
    ).toEqual([])
    await expect
      .poll(() => meter.locator('span').evaluate((el) => getComputedStyle(el).backgroundColor))
      .toBe('rgb(203, 162, 90)')

    // A zero-valued first sample still registers the second run lane without
    // changing the aggregate, so the breach must pause both lanes.
    await page.evaluate(async () => {
      const cost = (window as unknown as { morzCost: CostTestBridge }).morzCost
      await cost.testTrack({
        runId: 'e2e-cost-run',
        agentId: 'agent-cost-2',
        usage: { tokens: 0 }
      })
    })

    await page.evaluate(async () => {
      const cost = (window as unknown as { morzCost: CostTestBridge }).morzCost
      await cost.testTrack({
        runId: 'e2e-cost-run',
        agentId: 'agent-cost-1',
        usage: { tokens: 300 }
      })
    })

    await expect(meter).toHaveAttribute('aria-valuenow', '100')
    await expect(page.getByTestId('active-run-cost-meter')).toContainText('1.1k tok')
    await expect(page.getByText('Run paused: cost cap reached')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Resume (raises cap 25%)' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Stop' })).toBeVisible()
    expect(
      await app.evaluate(
        () => (globalThis as unknown as { __morzCostInterrupts: string[] }).__morzCostInterrupts
      )
    ).toEqual(['agent-cost-1', 'agent-cost-2'])
    await expect
      .poll(() => meter.locator('span').evaluate((el) => getComputedStyle(el).backgroundColor))
      .toBe('rgb(217, 124, 106)')

    await page.getByRole('button', { name: 'Resume (raises cap 25%)' }).click()
    await expect(page.getByText('Run paused: cost cap reached')).toHaveCount(0)
    await expect(meter).toHaveAttribute('aria-valuenow', '88')
    await expect
      .poll(() => meter.locator('span').evaluate((el) => getComputedStyle(el).backgroundColor))
      .toBe('rgb(203, 162, 90)')

    await page.evaluate(async () => {
      const cost = (window as unknown as { morzCost: CostTestBridge }).morzCost
      await cost.testTrack({
        runId: 'e2e-cost-run',
        agentId: 'agent-cost-1',
        usage: { tokens: 200 }
      })
    })
    await expect(page.getByText('Run paused: cost cap reached')).toBeVisible()
    await page.getByRole('button', { name: 'Stop' }).click()
    await expect(page.getByText('Run paused: cost cap reached')).toHaveCount(0)
    await expect(page.getByTestId('active-run-cost-meter')).toHaveText('Run —')
  })
})
