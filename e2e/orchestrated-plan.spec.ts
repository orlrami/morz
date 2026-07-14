import { expect, test } from '@playwright/test'
import { closeMorz, launchMorz, type MorzApp } from './app'

test.describe('Orchestrated plan approval', () => {
  let morz: MorzApp

  test.beforeEach(async () => {
    morz = await launchMorz()
    await morz.app.evaluate(({ ipcMain }) => {
      const plan = {
        version: '1.0',
        id: 'plan-e2e',
        goal: 'Ship a safe plan',
        agents: [
          {
            agentId: 'builder',
            cli: 'claude',
            role: 'Builder',
            branch: 'run/e2e/builder',
            worktree: null,
            cwd: '',
            promptSeed: 'Implement the feature.',
            dependsOn: [],
            port: null
          }
        ],
        spaceRoot: 'C:\\Projects\\morz-planner',
        caps: { maxUsd: null, maxTokens: null },
        createdAt: '2026-07-14T12:00:00.000Z',
        planHash: 'a'.repeat(64)
      }
      ipcMain.removeHandler('planner:plan')
      ipcMain.removeHandler('planner:update')
      ipcMain.removeHandler('planner:approve-and-run')
      ipcMain.removeHandler('planner:request-amendment')
      ipcMain.removeHandler('planner:approve-amendment')
      ipcMain.handle('planner:plan', () => ({ plan, state: 'PROPOSED' }))
      ipcMain.handle('planner:update', (_event, input: { plan: typeof plan }) => ({
        plan: { ...input.plan, planHash: 'b'.repeat(64) },
        state: 'PROPOSED'
      }))
      ipcMain.handle('planner:approve-and-run', () => ({
        record: { plan: { ...plan, planHash: 'b'.repeat(64) }, state: 'APPROVED' },
        runId: 'stub-run-e2e'
      }))
      ipcMain.handle('planner:request-amendment', () => ({
        state: 'PROPOSED',
        amendment: {
          version: '1.0',
          id: 'amendment-e2e',
          planId: plan.id,
          action: {
            kind: 'add',
            agent: {
              ...plan.agents[0],
              agentId: 'reviewer',
              role: 'Reviewer',
              branch: 'run/e2e/reviewer',
              promptSeed: 'Review the implementation.'
            }
          },
          createdAt: '2026-07-14T12:05:00.000Z',
          amendmentHash: 'c'.repeat(64)
        }
      }))
      ipcMain.handle('planner:approve-amendment', (_event, amendmentHash: string) => ({
        state: 'APPROVED',
        amendmentHash
      }))
    })
  })

  test.afterEach(async () => {
    await closeMorz(morz.app)
  })

  test('keeps dispatch locked until the edited plan hash is approved', async () => {
    const { page } = morz
    const orchestrated = page.getByRole('radio', { name: 'Orchestrated' })
    await expect(orchestrated).toHaveAttribute('aria-disabled', 'false')
    await orchestrated.click()

    await page.getByRole('textbox', { name: 'Goal' }).fill('Ship a safe plan')
    await page.getByRole('button', { name: 'Plan team' }).click()
    await expect(page.getByText('Builder', { exact: true })).toBeVisible()
    await expect(page.getByText(/aaaaaaaa/)).toBeVisible()

    const prompt = page.getByRole('textbox', { name: 'Prompt for Builder' })
    await prompt.fill('Implement and test the feature.')
    await expect(page.getByRole('button', { name: 'Approve & Run' })).toBeDisabled()
    await prompt.blur()
    await expect(page.getByText(/bbbbbbbb/)).toBeVisible()

    await page.getByRole('button', { name: 'Approve & Run' }).click()
    await expect(page.getByText(/stub-run-e2e/)).toBeVisible()
    await expect(page.getByRole('button', { name: 'Approve & Run' })).toHaveCount(0)

    await page.getByRole('textbox', { name: 'Amendment request' }).fill('Add one reviewer')
    await page.getByRole('button', { name: 'Request' }).click()
    await expect(page.getByRole('region', { name: 'Plan amendment' })).toContainText('Add Reviewer')
    await page.getByRole('button', { name: 'Approve amendment' }).click()
    await expect(page.getByText('Amendment approved', { exact: true })).toBeVisible()
    await expect(page.getByRole('region', { name: 'Plan amendment' })).toHaveCount(0)
  })
})
