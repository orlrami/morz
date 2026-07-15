import { expect, test } from '@playwright/test'
import { closeMorz, launchMorz, type MorzApp } from './app'

test.describe('Morz brand shell', () => {
  let morz: MorzApp

  test.beforeAll(async () => {
    morz = await launchMorz()
  })

  test.afterAll(async () => {
    if (morz) await closeMorz(morz.app)
  })

  test('uses bundled brand fonts for UI and wordmark', async () => {
    const { page } = morz
    await page.evaluate(() => document.fonts.ready)

    const fontState = await page.evaluate(() => {
      const wordmark = document.querySelector<HTMLElement>('[data-testid="morz-wordmark"]')
      const displayControl = document.querySelector<HTMLElement>('header nav button')
      return {
        body: getComputedStyle(document.body).fontFamily,
        display: displayControl ? getComputedStyle(displayControl).fontFamily : null,
        wordmark: wordmark ? getComputedStyle(wordmark).fontFamily : null,
        loadedFamilies: [
          ...new Set(
            [...document.fonts]
              .filter((face) => face.status === 'loaded')
              .map((face) => face.family.replace(/["']/g, ''))
          )
        ]
      }
    })

    expect(fontState.body).toContain('Hanken Grotesk')
    expect(fontState.display).toContain('Hanken Grotesk')
    expect(fontState.wordmark).toContain('Quicksand')
    expect(fontState.loadedFamilies).toEqual(
      expect.arrayContaining(['Hanken Grotesk', 'Quicksand', 'JetBrains Mono'])
    )
  })

  test('renders the canonical Morz Signal geometry in the titlebar', async () => {
    const titlebar = morz.page.locator('header').first()
    const signal = titlebar.getByTestId('morz-signal')
    await expect(signal).toBeVisible()
    await expect(signal).toHaveAttribute('viewBox', '0 0 104 76')
    await expect(signal.locator('path')).toHaveAttribute(
      'd',
      'M15 37 C31 37 30 57 47 57 C64 57 66 33 90 30'
    )
    await expect(signal.locator('path')).toHaveAttribute('stroke', 'currentColor')
    await expect(signal.locator('path')).toHaveAttribute('stroke-width', '13')
    await expect(signal.locator('path')).toHaveAttribute('stroke-linecap', 'round')
    await expect(signal.locator('circle')).toHaveAttribute(
      'fill',
      'var(--morz-gold, var(--color-bronze-hot))'
    )
    await expect(titlebar.getByTestId('morz-wordmark')).toHaveText('Morz')
  })
})
