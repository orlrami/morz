import { expect, test } from '@playwright/test'
import { closeMorz, launchMorz, type MorzApp } from './app'

test.describe('Orchestrator goal composer', () => {
  let morz: MorzApp

  test.beforeEach(async () => {
    morz = await launchMorz()
    await morz.app.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('planner:plan')
      ipcMain.handle(
        'planner:plan',
        (_event, input: { goal?: unknown; spaceRoot?: unknown }) => {
          const goal = String(input.goal ?? '')
          const testState = globalThis as typeof globalThis & {
            __morzOrchestratorGoal?: string
          }
          testState.__morzOrchestratorGoal = goal

          return {
            state: 'PROPOSED',
            plan: {
              version: '1.0',
              id: 'orch-input-e2e',
              goal,
              agents: [
                {
                  agentId: 'composer-builder',
                  cli: 'claude',
                  role: 'Composer Builder',
                  branch: 'run/e2e/composer-builder',
                  worktree: null,
                  cwd: '',
                  promptSeed: goal,
                  dependsOn: [],
                  port: null
                }
              ],
              spaceRoot: String(input.spaceRoot ?? ''),
              caps: { maxUsd: null, maxTokens: null },
              createdAt: '2026-07-16T12:00:00.000Z',
              planHash: 'd'.repeat(64)
            }
          }
        }
      )
    })
  })

  test.afterEach(async () => {
    await closeMorz(morz.app)
  })

  test('grows, caps long goals, and uses Enter to plan while Shift+Enter adds a line', async () => {
    const { page } = morz
    await page.getByRole('radio', { name: 'Orchestrated' }).click()

    const composer = page.getByRole('textbox', { name: 'Goal' })
    await expect(composer).toHaveAttribute('placeholder', 'What should the team finish?')
    await expect(composer).toHaveJSProperty('tagName', 'TEXTAREA')

    const initialHeight = await composer.evaluate((element) => element.clientHeight)
    const lines = Array.from(
      { length: 10 },
      (_, index) => `${String(index + 1).padStart(2, '0')} ${'x'.repeat(36)}`
    )
    const longGoal = `${lines.join('\n')}!`
    expect(longGoal).toHaveLength(400)

    await composer.fill(lines.slice(0, 4).join('\n'))
    await expect
      .poll(() => composer.evaluate((element) => element.clientHeight))
      .toBeGreaterThan(initialHeight)

    await composer.fill(longGoal)
    await expect(composer).toHaveValue(longGoal)
    const cappedMetrics = await composer.evaluate((element) => {
      const style = window.getComputedStyle(element)
      return {
        clientHeight: element.clientHeight,
        scrollHeight: element.scrollHeight,
        overflowY: style.overflowY
      }
    })
    expect(cappedMetrics.scrollHeight).toBeGreaterThan(cappedMetrics.clientHeight)
    expect(cappedMetrics.overflowY).toMatch(/auto|scroll/)

    await composer.press('Shift+Enter')
    await expect(composer).toHaveValue(`${longGoal}\n`)

    await composer.press('Enter')
    await expect
      .poll(() =>
        morz.app.evaluate(() => {
          const testState = globalThis as typeof globalThis & {
            __morzOrchestratorGoal?: string
          }
          return testState.__morzOrchestratorGoal
        })
      )
      .toBe(longGoal)
    await expect(composer).toHaveValue(`${longGoal}\n`)
  })
})
