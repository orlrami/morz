/*
 * Manual-inert gate (Slice 6) — PERMANENT release gate. This spec gates every
 * future release: Manual mode must be provably inert.
 *
 * Proof layers (belt and braces):
 *  1. Process truth  — after real terminal use, the app's process tree contains
 *     NO process matching /claude/ (adapter spawn is the only way Morz can make
 *     an LLM call, so no claude process ⇒ zero LLM calls from Morz).
 *  2. DOM truth      — no Claude affordance exists in Manual: no "Start Claude
 *     here" button, no lane pane, no palette spawn entry.
 *  3. IPC truth      — the main-process claude:start handler is replaced with a
 *     counting spy; a full dial round-trip (Manual → Assisted → start a lane →
 *     Manual) must strip every lane WITHOUT claude:start ever being invoked
 *     (the lane only starts the adapter on the first prompt, which we never send).
 */
import { test, expect } from '@playwright/test'
import { spawnSync } from 'child_process'
import { closeMorz, launchMorz, PANE_1, PROMPT_RE, runInPane, waitForTerm, type MorzApp } from './app'

interface ProcRow {
  ProcessId: number
  ParentProcessId: number
  Name: string | null
  CommandLine: string | null
}

/** Snapshot every process on the box (PowerShell CIM — includes CommandLine). */
function processTable(): ProcRow[] {
  const out = spawnSync(
    'powershell',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress'
    ],
    { encoding: 'utf8', windowsHide: true, timeout: 60_000, maxBuffer: 64 * 1024 * 1024 }
  )
  if (out.status !== 0 || !out.stdout) {
    throw new Error(`process snapshot failed: ${out.stderr || out.error?.message || 'no output'}`)
  }
  const parsed = JSON.parse(out.stdout) as ProcRow | ProcRow[]
  return Array.isArray(parsed) ? parsed : [parsed]
}

/**
 * Every descendant of `rootPid` whose Name or CommandLine mentions claude.
 * Descendant walk (not a global scan) so a `claude` running elsewhere on the
 * dev box — e.g. the very agent authoring this test — never false-positives.
 */
function claudeDescendants(rootPid: number): ProcRow[] {
  const rows = processTable()
  const byParent = new Map<number, ProcRow[]>()
  for (const r of rows) {
    const list = byParent.get(r.ParentProcessId)
    if (list) list.push(r)
    else byParent.set(r.ParentProcessId, [r])
  }
  const descendants: ProcRow[] = []
  const seen = new Set<number>([rootPid])
  const queue = [rootPid]
  while (queue.length > 0) {
    const pid = queue.shift()!
    for (const child of byParent.get(pid) ?? []) {
      if (seen.has(child.ProcessId)) continue // PID-reuse cycle guard
      seen.add(child.ProcessId)
      descendants.push(child)
      queue.push(child.ProcessId)
    }
  }
  return descendants.filter(
    (r) => /claude/i.test(r.Name ?? '') || /claude/i.test(r.CommandLine ?? '')
  )
}

const START_LANE = '[aria-label="Start Claude here"]'
const LANE_PANE = 'section[aria-label^="Claude lane"]'
/* w15/shell-layout — the orchestrator is dial-owned: Manual mounts NOTHING. */
const ORCH_TOGGLE = '[aria-label="Toggle orchestrator"]'
const ORCH_DOCK = 'aside[aria-label="Orchestrator"]'

test.describe.serial('Manual-inert gate (Slice 6)', () => {
  let morz: MorzApp

  test.beforeAll(async () => {
    morz = await launchMorz()
  })

  test.afterAll(async () => {
    if (morz) await closeMorz(morz.app)
  })

  test('boots in Manual: dial checked, Orchestrated selectable but approval-gated', async () => {
    const { page } = morz
    await expect(page.getByRole('radio', { name: 'Manual' })).toHaveAttribute('aria-checked', 'true')
    await expect(page.getByRole('radio', { name: 'Assisted' })).toHaveAttribute('aria-checked', 'false')
    await expect(page.getByRole('radio', { name: 'Orchestrated' })).toHaveAttribute('aria-disabled', 'false')
    await expect(page.getByRole('button', { name: 'Approve & Run' })).toHaveCount(0)

    // Store truth behind the dial: mode is 'manual' (persisted key may not
    // exist yet on a fresh profile — that also means the default, 'manual').
    const persisted = await page.evaluate(() => localStorage.getItem('morz.mode'))
    if (persisted !== null) {
      expect((JSON.parse(persisted) as { state: { mode: string } }).state.mode).toBe('manual')
    }
  })

  test('real terminal use spawns no claude process anywhere in the app tree', async () => {
    const { page, app } = morz
    // Prove the app is genuinely alive and doing PTY work, not idling.
    await waitForTerm(page, PANE_1, PROMPT_RE, 90_000)
    await runInPane(page, PANE_1, '"MORZ_GATE_$(6*7)"')
    await waitForTerm(page, PANE_1, /MORZ_GATE_42/)

    // Soak: give any lazily-started background process time to appear.
    await page.waitForTimeout(10_000)

    const pid = app.process().pid
    expect(pid).toBeTruthy()
    const offenders = claudeDescendants(pid!)
    expect(
      offenders.map((o) => `${o.ProcessId} ${o.Name} :: ${o.CommandLine ?? ''}`),
      'Manual mode spawned a claude process — the adapter gate is broken'
    ).toEqual([])
  })

  test('no Claude affordance in the DOM in Manual', async () => {
    const { page } = morz
    // (a) No "Start Claude here" button on any terminal pane header.
    await expect(page.locator(START_LANE)).toHaveCount(0)
    // (b) No lane pane mounted (session hydrate strips kind:'claude' in Manual).
    await expect(page.locator(LANE_PANE)).toHaveCount(0)

    // (b2) w15/shell-layout — zero orchestrator affordances in Manual: no dock,
    // no toggle chip, nothing labelled Orchestrator anywhere in the DOM.
    await expect(page.locator(ORCH_TOGGLE)).toHaveCount(0)
    await expect(page.locator(ORCH_DOCK)).toHaveCount(0)
    await expect(page.getByText('Orchestrator', { exact: true })).toHaveCount(0)

    // (c) Command palette has no spawn entry.
    await page.keyboard.press('Control+k')
    const palette = page.getByRole('dialog', { name: 'Command palette' })
    await expect(palette).toBeVisible()
    await expect(palette.getByText('spawn: Claude lane')).toHaveCount(0)
    await page.keyboard.press('Escape')
    await expect(palette).toHaveCount(0)
  })

  test('dial round-trip strips lanes and never invokes claude:start', async () => {
    const { page, app } = morz

    // Spy: replace the real claude:start handler with a counter that spawns
    // nothing. Proves the renderer never reaches the adapter, and guarantees
    // this test can't leak a real claude process even if the gate regresses.
    await app.evaluate(({ ipcMain }) => {
      const g = globalThis as unknown as { __morzClaudeStarts: number }
      g.__morzClaudeStarts = 0
      ipcMain.removeHandler('claude:start')
      ipcMain.handle('claude:start', (_e, opts: { agentId?: string }) => {
        g.__morzClaudeStarts += 1
        return { agentId: opts?.agentId ?? 'spy' }
      })
    })

    // Manual → Assisted: the affordances must appear (the dial is live).
    await page.getByRole('radio', { name: 'Assisted' }).click()
    await expect(page.getByRole('radio', { name: 'Assisted' })).toHaveAttribute('aria-checked', 'true')
    await expect(page.locator(START_LANE).first()).toBeVisible()

    // w15/shell-layout — Assisted shows exactly ONE orchestrator control (the
    // stage-header chip) and the dock stays closed until it is clicked.
    await expect(page.locator(ORCH_TOGGLE)).toHaveCount(1)
    await expect(page.locator(ORCH_DOCK)).toHaveCount(0)

    // Start a lane (pane mounts; the adapter starts only on the first prompt,
    // which we never send — so even in Assisted the spy must stay at 0 here).
    await page.locator(START_LANE).first().click()
    await expect(page.locator(LANE_PANE)).toHaveCount(1)

    // Assisted → Manual: every lane is stripped and every affordance vanishes.
    await page.getByRole('radio', { name: 'Manual' }).click()
    await expect(page.getByRole('radio', { name: 'Manual' })).toHaveAttribute('aria-checked', 'true')
    await expect(page.locator(LANE_PANE)).toHaveCount(0)
    await expect(page.locator(START_LANE)).toHaveCount(0)
    // w15/shell-layout — orchestrator chip and dock die with the dial too.
    await expect(page.locator(ORCH_TOGGLE)).toHaveCount(0)
    await expect(page.locator(ORCH_DOCK)).toHaveCount(0)

    // Mode persisted as manual after the round-trip.
    const persisted = await page.evaluate(() => localStorage.getItem('morz.mode'))
    expect(persisted).not.toBeNull()
    expect((JSON.parse(persisted!) as { state: { mode: string } }).state.mode).toBe('manual')

    // IPC truth: claude:start was never invoked — not in Manual, and not by
    // merely creating a lane in Assisted.
    const starts = await app.evaluate(
      () => (globalThis as unknown as { __morzClaudeStarts: number }).__morzClaudeStarts
    )
    expect(starts).toBe(0)

    // Final process truth after the whole dance.
    const pid = app.process().pid
    expect(claudeDescendants(pid!)).toEqual([])
  })
})
