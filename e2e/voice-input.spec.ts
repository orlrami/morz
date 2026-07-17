import { expect, test } from '@playwright/test'
import { closeMorz, launchMorz, type MorzApp } from './app'

test.describe('external keyboard and dictation input', () => {
  let morz: MorzApp

  test.beforeEach(async () => {
    morz = await launchMorz()
    await morz.page.getByRole('radio', { name: 'Assisted' }).click()
  })

  test.afterEach(async () => {
    if (morz) await closeMorz(morz.app)
  })

  test('lands injected keystrokes in every Morz text field', async () => {
    const { page } = morz
    const goal = page.getByRole('textbox', { name: 'Goal' })

    await goal.focus()
    await page.keyboard.type('Dictated goal')
    await page.keyboard.type('!')
    await expect(goal).toHaveValue('Dictated goal!')

    await page.getByRole('button', { name: 'Start Claude here' }).first().click()
    await page.getByRole('tab', { name: 'Structured' }).click()
    const lanePrompt = page.getByPlaceholder('Prompt Claude…')
    await lanePrompt.focus()
    await page.keyboard.type('Dictated lane prompt')
    await expect(lanePrompt).toHaveValue('Dictated lane prompt')

    await page.getByRole('tab', { name: 'Commit' }).click()
    const commitMessage = page.getByRole('textbox', { name: 'Commit message' })
    await commitMessage.focus()
    await page.keyboard.type('feat: dictated commit')
    await expect(commitMessage).toHaveValue('feat: dictated commit')

    await page.keyboard.press('Control+k')
    const palette = page.getByRole('dialog', { name: 'Command palette' })
    const paletteSearch = palette.getByRole('textbox')
    await expect(palette).toBeVisible()
    await page.keyboard.type('view commit')
    await expect(paletteSearch).toHaveValue('view commit')
    await page.keyboard.press('Escape')
  })

  test('reserves only exact app shortcuts and leaves IME composition alone', async () => {
    const { app, page } = morz

    await page.keyboard.press('Control+k')
    const palette = page.getByRole('dialog', { name: 'Command palette' })
    const paletteSearch = palette.getByRole('textbox')
    await expect(palette).toBeVisible()
    await page.keyboard.type('view commit')

    const paletteCompositionPrevented = await paletteSearch.evaluate((element) => {
      const event = new KeyboardEvent('keydown', {
        key: 'Enter',
        bubbles: true,
        cancelable: true,
        isComposing: true
      })
      element.dispatchEvent(event)
      return event.defaultPrevented
    })
    expect(paletteCompositionPrevented).toBe(false)
    await expect(palette).toBeVisible()
    await page.keyboard.press('Escape')

    await page.getByRole('button', { name: 'Start Claude here' }).first().click()
    await page.getByRole('tab', { name: 'Structured' }).click()
    const lanePrompt = page.getByPlaceholder('Prompt Claude…')
    await lanePrompt.fill('Composing lane prompt')
    await app.evaluate(({ ipcMain }) => {
      const state = globalThis as unknown as { __voiceInputStarts: number; __voiceInputSends: number }
      state.__voiceInputStarts = 0
      state.__voiceInputSends = 0
      ipcMain.removeHandler('claude:start')
      ipcMain.removeAllListeners('claude:send')
      ipcMain.handle('claude:start', (_event, opts: { agentId: string }) => {
        state.__voiceInputStarts += 1
        return { agentId: opts.agentId }
      })
      ipcMain.on('claude:send', () => {
        state.__voiceInputSends += 1
      })
    })
    const laneCompositionPrevented = await lanePrompt.evaluate((element) => {
      const event = new KeyboardEvent('keydown', {
        key: 'Enter',
        bubbles: true,
        cancelable: true,
        isComposing: true
      })
      element.dispatchEvent(event)
      return event.defaultPrevented
    })
    expect(laneCompositionPrevented).toBe(false)
    await expect(lanePrompt).toHaveValue('Composing lane prompt')
    await expect
      .poll(() =>
        app.evaluate(() => {
          const state = globalThis as unknown as { __voiceInputStarts: number; __voiceInputSends: number }
          return [state.__voiceInputStarts, state.__voiceInputSends]
        })
      )
      .toEqual([0, 0])

    await page.getByRole('tab', { name: 'Commit' }).click()
    const commitMessage = page.getByRole('textbox', { name: 'Commit message' })
    await commitMessage.focus()
    await page.keyboard.press('Control+Shift+k')
    await expect(page.getByRole('dialog', { name: 'Command palette' })).toHaveCount(0)
    await page.keyboard.press('Control+Shift+b')
    await expect(page.getByRole('complementary', { name: 'File explorer' })).toHaveCount(0)

    const contenteditable = page.locator('[data-testid="voice-contenteditable"]')
    await page.evaluate(() => {
      const element = document.createElement('div')
      element.contentEditable = 'true'
      element.dataset.testid = 'voice-contenteditable'
      element.setAttribute('aria-label', 'Dictation contenteditable')
      document.body.appendChild(element)
    })
    await contenteditable.focus()
    await page.keyboard.type('Dictated content')
    await expect(contenteditable).toHaveText('Dictated content')
    await page.keyboard.press('Control+Shift+k')
    await page.keyboard.press('Control+Shift+b')
    await expect(page.getByRole('dialog', { name: 'Command palette' })).toHaveCount(0)
    await expect(page.getByRole('complementary', { name: 'File explorer' })).toHaveCount(0)

    await page.keyboard.press('Control+b')
    await expect(page.getByRole('complementary', { name: 'File explorer' })).toBeVisible()

    await page.keyboard.press('Control+k')
    await expect(page.getByRole('dialog', { name: 'Command palette' })).toBeVisible()
  })
})
