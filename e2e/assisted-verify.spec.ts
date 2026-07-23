/*
 * w14/assisted-verify — Assisted mode end-to-end release gate.
 *
 * The deterministic suite drives a temporary claude.cmd that speaks the real
 * stream-json/control_request protocol. That keeps the renderer, preload, IPC,
 * and main adapter in the test while avoiding a paid API call in normal CI.
 * MORZ_LIVE=1 adds a cheap drive against the user's logged-in Claude CLI.
 */
import { expect, test } from '@playwright/test'
import { mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { closeMorz, launchMorz, ROOT, type MorzApp } from './app'

const START_LANE = '[aria-label="Start Claude here"]'
const LANE_PANE = 'section[aria-label^="Claude lane"]'

function installClaudeStub(): { dir: string; restorePath(): void } {
  const dir = join(ROOT, 'e2e', '.tmp', `assisted-claude-${process.pid}-${Date.now()}`)
  mkdirSync(dir, { recursive: true })

  const stub = String.raw`
const readline = require('readline')

const emit = (event) => process.stdout.write(JSON.stringify(event) + '\n')
let permission = 0

emit({
  type: 'system',
  subtype: 'init',
  session_id: 'morz-assisted-e2e',
  model: 'claude-e2e-stub',
  capabilities: {}
})

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line)
  if (message.type === 'user') {
    const requestId = permission++ === 0 ? 'permission-allow' : 'permission-deny'
    emit({
      type: 'stream_event',
      event: { type: 'content_block_start', content_block: { type: 'text' } }
    })
    emit({
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        delta: { type: 'text_delta', text: 'ASSISTED_STREAM_OK' }
      }
    })
    emit({
      type: 'control_request',
      request_id: requestId,
      request: {
        subtype: 'can_use_tool',
        tool_name: 'Bash',
        input: { command: requestId === 'permission-allow' ? 'echo allowed' : 'echo denied' }
      }
    })
    return
  }

  if (message.type === 'control_response') {
    const behavior = message.response?.response?.behavior
    emit({
      type: 'assistant',
      message: {
        content: [{ type: 'text', text: 'permission ' + (behavior ?? 'missing') + ' reached CLI' }]
      }
    })
    emit({
      type: 'result',
      is_error: false,
      total_cost_usd: 0,
      duration_ms: 1,
      usage: { input_tokens: 1, output_tokens: 1 }
    })
  }
})
`

  writeFileSync(join(dir, 'fake-claude.cjs'), stub, 'utf8')
  writeFileSync(
    join(dir, 'claude.cmd'),
    `@echo off\r\n"${process.execPath}" "%~dp0fake-claude.cjs" %*\r\n`,
    'utf8'
  )

  const previousPath = process.env.PATH
  process.env.PATH = `${dir};${previousPath ?? ''}`
  return {
    dir,
    restorePath: () => {
      if (previousPath === undefined) delete process.env.PATH
      else process.env.PATH = previousPath
    }
  }
}

async function openStructuredLane(morz: MorzApp): Promise<void> {
  const { page } = morz
  await page.getByRole('radio', { name: 'Assisted', exact: true }).click()
  await expect(page.locator(START_LANE).first()).toBeVisible()
  await page.locator(START_LANE).first().click()
  await expect(page.locator(LANE_PANE)).toHaveCount(1)

  const lane = page.locator(LANE_PANE)
  await expect(lane.getByRole('tab', { name: 'Interactive' })).toHaveAttribute(
    'aria-selected',
    'true'
  )
  await lane.getByRole('tab', { name: 'Structured' }).click()
  await expect(lane.getByRole('tab', { name: 'Structured' })).toHaveAttribute(
    'aria-selected',
    'true'
  )
}

test.describe.serial('Assisted mode end to end', () => {
  let morz: MorzApp
  let stubDir = ''

  test.beforeAll(async () => {
    const stub = installClaudeStub()
    stubDir = stub.dir
    try {
      morz = await launchMorz()
    } finally {
      stub.restorePath()
    }
  })

  test.afterAll(async () => {
    if (morz) await closeMorz(morz.app)
    if (stubDir) rmSync(stubDir, { recursive: true, force: true })
  })

  test('Manual hides the robot; Assisted starts exactly one lane with both modes', async () => {
    const { page } = morz
    await expect(page.getByRole('radio', { name: 'Manual', exact: true })).toHaveAttribute(
      'aria-checked',
      'true'
    )
    await expect(page.locator(START_LANE)).toHaveCount(0)

    await page.getByRole('radio', { name: 'Assisted', exact: true }).click()
    const robotButtons = page.locator(START_LANE)
    expect(await robotButtons.count()).toBeGreaterThan(1)
    // Both handlers run in one renderer turn, before React can disable either
    // button. Only startClaudeLane's synchronous store guard rejects click two.
    await robotButtons.evaluateAll((buttons) => {
      buttons[0]?.click()
      buttons[1]?.click()
    })
    await expect(page.locator(LANE_PANE)).toHaveCount(1)
    for (const button of await robotButtons.all()) await expect(button).toBeDisabled()

    const lane = page.locator(LANE_PANE)
    await expect(lane.getByRole('tab', { name: 'Interactive' })).toHaveAttribute(
      'aria-selected',
      'true'
    )
    await lane.getByRole('tab', { name: 'Structured' }).click()
    await expect(lane.getByRole('tab', { name: 'Structured' })).toHaveAttribute(
      'aria-selected',
      'true'
    )
  })

  test('streaming prompt surfaces each permission and routes allow and deny to the CLI', async () => {
    const { page } = morz
    const lane = page.locator(LANE_PANE)
    const prompt = lane.getByPlaceholder('Prompt Claude…')

    await prompt.fill('exercise allow')
    await lane.getByRole('button', { name: 'Send' }).click()
    await expect(lane.getByText('ASSISTED_STREAM_OK')).toBeVisible()

    const allowDialog = lane.getByRole('alertdialog', { name: 'Tool permission request' })
    await expect(allowDialog).toContainText('wants to use Bash')
    await expect(allowDialog).toContainText('echo allowed')
    await allowDialog.getByRole('button', { name: 'Allow' }).click()
    await expect(lane.getByText('permission allow reached CLI')).toBeVisible()

    await prompt.fill('exercise deny')
    await lane.getByRole('button', { name: 'Send' }).click()
    const denyDialog = lane.getByRole('alertdialog', { name: 'Tool permission request' })
    await expect(denyDialog).toContainText('echo denied')
    await denyDialog.getByRole('button', { name: 'Deny' }).click()
    await expect(lane.getByText('permission deny reached CLI')).toBeVisible()
  })

  test('returning to Manual removes the lane and every robot affordance', async () => {
    const { page } = morz
    await page.getByRole('radio', { name: 'Manual', exact: true }).click()
    await expect(page.locator(LANE_PANE)).toHaveCount(0)
    await expect(page.locator(START_LANE)).toHaveCount(0)
  })
})

test.describe('Assisted mode live drive', () => {
  test.skip(process.env.MORZ_LIVE !== '1', 'set MORZ_LIVE=1 to drive the logged-in Claude CLI')

  test('streams a cheap prompt and approves a real tool request', async () => {
    test.setTimeout(300_000)
    const morz = await launchMorz()
    try {
      await openStructuredLane(morz)
      const lane = morz.page.locator(LANE_PANE)
      await lane.getByPlaceholder('Prompt Claude…').fill(
        'Use the Bash tool exactly once to run: powershell -NoProfile -Command "Write-Output MORZ_ASSISTED_LIVE_ALLOW". Then reply with exactly MORZ_ASSISTED_LIVE_STREAM_OK.'
      )
      await lane.getByRole('button', { name: 'Send' }).click()

      const dialog = lane.getByRole('alertdialog', { name: 'Tool permission request' })
      await expect(dialog).toBeVisible({ timeout: 120_000 })
      await expect(dialog).toContainText('Bash')
      await dialog.getByRole('button', { name: 'Allow' }).click()
      await expect(lane.getByText('MORZ_ASSISTED_LIVE_STREAM_OK', { exact: true })).toBeVisible({
        timeout: 120_000
      })
    } finally {
      await closeMorz(morz.app)
    }
  })
})
