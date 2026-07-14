import { expect, test } from '@playwright/test'
import { closeMorz, launchMorz } from './app'

test('live Claude planner produces, re-hashes, approves, and dispatches a SpawnPlan', async () => {
  test.skip(process.env.MORZ_LIVE_PLANNER !== '1', 'set MORZ_LIVE_PLANNER=1 for the cheap live CLI proof')
  test.setTimeout(300_000)
  const morz = await launchMorz()
  try {
    const { page } = morz
    await page.getByRole('radio', { name: 'Orchestrated' }).click()
    await page
      .getByRole('textbox', { name: 'Goal' })
      .fill('Propose one agent to document a harmless README typo fix. Planning only; do not modify files.')
    await page.getByRole('button', { name: 'Plan team' }).click()
    await expect(page.getByText('Planning', { exact: true })).toBeVisible()

    const card = page.getByRole('region', { name: 'Spawn plan' })
    await expect(card).toBeVisible({ timeout: 150_000 })
    await expect(card.getByText('PROPOSED', { exact: true })).toBeVisible()
    const hash = card.locator('code').first()
    const originalHash = await hash.textContent()
    expect(originalHash).toMatch(/^[a-f0-9]{8}$/)

    const prompt = card.getByRole('textbox', { name: /^Prompt for/ }).first()
    await prompt.fill(`${await prompt.inputValue()}\nAlso report the verification command.`)
    await prompt.blur()
    await expect(hash).not.toHaveText(originalHash!)

    await card.getByRole('button', { name: 'Approve & Run' }).click()
    await expect(card.getByText('APPROVED', { exact: true })).toBeVisible()
    // Integration wired the REAL dispatcher (was a LoggingDispatchStub): approve
    // now registers the plan in the dispatcher store and spawns a real run, so
    // the run id is a UUID, not the old `stub-` prefix.
    await expect(page.getByText(/^Run [0-9a-f-]{8}/i)).toBeVisible()
  } finally {
    await closeMorz(morz.app)
  }
})
