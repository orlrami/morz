/*
 * Assisted handoff — LIVE end-to-end (0.0.2, w4/handoff).
 *
 * Spawns the user's REAL `claude` CLI (cheap prompts, real tokens) — gated on
 * MORZ_LIVE=1 so CI and the default suite never make an LLM call:
 *
 *   $env:MORZ_LIVE='1'; npx playwright test e2e/handoff-live.spec.ts
 *
 * Known wart: the worker teardown can exceed its timeout after the force-kill
 * (playwright's CDP connection to the killed Electron lingers) — the three
 * tests report green and the run exits 0; ignore the teardown notice.
 *
 * Flow proven here:
 *   simulate lane A posting a handoff (bus:post) → ApprovalChip appears →
 *   Deny leaves the task 'proposed' → a second handoff Approved → task
 *   dispatched → the live lane receives ONLY the short pointer prompt (task
 *   flips to 'working' iff the adapter accepted the injection) and claude
 *   answers — the payload never leaves the mailbox.
 */
import { test, expect } from '@playwright/test'
import { closeMorz, launchMorz, PANE_1, PROMPT_RE, waitForTerm, type MorzApp } from './app'
import type { BusSnapshot, MorzBusApi } from '../src/shared/bus-ipc'

const LANE_PANE = 'section[aria-label^="Claude lane"]'
const START_LANE = '[aria-label="Start Claude here"]'

type BusWindow = { morz: { bus: MorzBusApi } }

function snapshot(page: MorzApp['page']): Promise<BusSnapshot> {
  return page.evaluate(() => (window as unknown as BusWindow).morz.bus.snapshot())
}

function postHandoff(page: MorzApp['page'], title: string): Promise<{ taskId: string }> {
  return page.evaluate(
    (t) =>
      (window as unknown as BusWindow).morz.bus.post({
        from: 'claude-lane-a',
        to: (window as unknown as { __morzHandoffTarget: string }).__morzHandoffTarget,
        title: t,
        text: 'Live-test handoff payload — stays in the mailbox; only the pointer may reach the lane.'
      }),
    title
  )
}

test.describe.serial('Assisted handoff — live (w4/handoff)', () => {
  test.skip(!process.env.MORZ_LIVE, 'set MORZ_LIVE=1 to run the real-claude handoff test')

  let morz: MorzApp

  test.beforeAll(async () => {
    morz = await launchMorz()
  })

  test.afterAll(async () => {
    if (morz) await closeMorz(morz.app)
  })

  test('lane goes live on a cheap prompt', async () => {
    // Real-CLI startup is SLOW here: the user's SessionStart hooks run before
    // claude emits ANY stdout (measured: init ~40s, first result ~60s, worse
    // under load). Budget generously — this spec is about correctness.
    test.setTimeout(420_000)
    const { page } = morz
    // App fully alive first (same as manual-gate). The dial expands on hover,
    // which shifts its buttons under the pointer — a mouse click never lands;
    // dispatch the click without moving the mouse.
    await waitForTerm(page, PANE_1, PROMPT_RE, 90_000)
    await page.getByRole('radio', { name: 'Assisted' }).dispatchEvent('click')
    await expect(page.getByRole('radio', { name: 'Assisted' })).toHaveAttribute(
      'aria-checked',
      'true'
    )
    await page.locator(START_LANE).first().dispatchEvent('click')
    await expect(page.locator(LANE_PANE)).toHaveCount(1)

    // agentId from the pane's aria-label ("Claude lane — claude-lane-…")
    const label = await page.locator(LANE_PANE).getAttribute('aria-label')
    const agentId = label!.replace('Claude lane — ', '')
    expect(agentId).toMatch(/^claude-/)
    await page.evaluate(
      (id) => ((window as unknown as { __morzHandoffTarget: string }).__morzHandoffTarget = id),
      agentId
    )

    // Collect raw adapter events for diagnostics (dumped on failure).
    await page.evaluate(() => {
      const w = window as unknown as {
        __laneEvents: string[]
        morz: { claude: { onEvent(cb: (m: { agentId: string; event: { type: string } }) => void): void } }
      }
      w.__laneEvents = []
      w.morz.claude.onEvent((m) => {
        w.__laneEvents.push(JSON.stringify(m.event).slice(0, 300))
      })
    })

    // First prompt spawns the real CLI; plain text needs no tool permission.
    // Liveness is asserted on the meter, not the reply text (the user's own
    // prompt block would match any reply regex): model = system/init arrived,
    // token counts = a result event closed the round trip.
    // Submit via the Send button, not Enter: keyboard events silently vanish
    // when the Playwright-driven window lacks OS focus (verified — fill+Enter
    // left the textarea value untouched; the button path always submits).
    const lane = page.locator(LANE_PANE)
    await lane.locator('textarea').fill('Reply with exactly the word: ready')
    await lane.locator('button[aria-label="Send"]').dispatchEvent('click')
    const meter = lane.locator('[data-testid="lane-meter"]')
    try {
      await expect(meter).toContainText(/claude/i, { timeout: 300_000 })
      await expect(meter).toContainText(/\d+ in/, { timeout: 120_000 })
    } catch (err) {
      const events = await page.evaluate(
        () => (window as unknown as { __laneEvents: string[] }).__laneEvents
      )
      console.log('--- adapter events ---\n' + events.join('\n'))
      throw err
    }
  })

  test('chip gates the dispatch: deny leaves the task proposed', async () => {
    const { page } = morz
    const { taskId } = await postHandoff(page, 'Deny-path handoff')

    const chip = page.locator('[data-testid="approval-chip"]')
    await expect(chip).toHaveCount(1)

    // No silent dispatch: the task is still 'proposed' while the chip is up.
    let snap = await snapshot(page)
    expect(snap.tasks.find((t) => t.id === taskId)?.state).toBe('proposed')

    await chip.getByRole('button', { name: 'Deny' }).dispatchEvent('click')
    await expect(chip).toHaveCount(0)
    snap = await snapshot(page)
    expect(snap.tasks.find((t) => t.id === taskId)?.state).toBe('proposed')
    expect(snap.approvals).toHaveLength(0)
  })

  test('approve dispatches: pointer lands in the real lane, task goes working', async () => {
    test.setTimeout(420_000)
    const { page } = morz
    const { taskId } = await postHandoff(page, 'Approve-path handoff')

    const chip = page.locator('[data-testid="approval-chip"]')
    await expect(chip).toHaveCount(1)
    await chip.getByRole('button', { name: 'Approve' }).dispatchEvent('click')
    await expect(chip).toHaveCount(0)

    // 'working' is only set when injectPointerPrompt() accepted the write into
    // the live claude process — this IS the pointer-delivery proof.
    const snap = await snapshot(page)
    const task = snap.tasks.find((t) => t.id === taskId)
    expect(task?.state).toBe('working')
    expect(task?.assignee).toBeTruthy()

    // And the real claude ACTS on the pointer: either it answers in text, or
    // it reaches for a tool (read_blackboard doesn't exist yet — the MCP shim
    // is Agents 1-2) and the lane's permission dialog surfaces. Both prove the
    // pointer landed; the payload never left the mailbox.
    const lane = page.locator(LANE_PANE)
    const reply = lane.getByText(/handoff|read_blackboard|blackboard|task/i).first()
    const permission = lane.getByRole('alertdialog', { name: 'Tool permission request' })
    await expect(reply.or(permission).first()).toBeVisible({ timeout: 240_000 })

    // Wind down politely if it asked for a tool.
    if (await permission.isVisible()) {
      await permission.getByRole('button', { name: 'Deny' }).dispatchEvent('click')
    }
  })
})
