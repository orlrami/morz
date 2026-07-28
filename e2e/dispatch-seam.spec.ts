/*
 * w17/adapter-seam e2e — a dispatched pane stops being a black box.
 *
 * Nothing is stubbed at the seam: the plan is dispatched for real, the pane is a
 * real ConPTY running a real script, and the state the run card shows is parsed
 * out of the same bytes the renderer rendered. The fake CLI stands in for the
 * agent so the suite spends no tokens — it emits the OSC title sequences a real
 * agent CLI emits, and the run card has no way to tell the difference.
 *
 * The second half is the honest-coverage half: an agent whose CLI paints no
 * recognizable title must produce NO activity, because a guess would be worse
 * than silence. See docs/in-progress/SEAM-DESIGN.md.
 */
import { expect, test, type Page } from '@playwright/test'
import { execFileSync } from 'child_process'
import { mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { closeMorz, installCollector, launchMorz, waitForTerm, ROOT } from './app'

interface AgentDetail {
  paneId: string
  worktree: string | null
  activity?: 'working' | 'waiting' | 'idle' | null
}
interface RunStatus {
  runId: string
  state: string
  agents: Record<string, string>
  agentsDetail?: Record<string, AgentDetail>
  usage: { usd: number | null; tokens: number | null }
}
interface MorzRunWindow {
  morz: {
    run: {
      approvePlan(plan: unknown): Promise<{ planHash: string }>
      dispatch(plan: unknown): Promise<{ runId: string }>
      runStatus(runId: string): Promise<RunStatus | null>
      stopRun(runId: string): Promise<RunStatus>
      cleanup(runId: string): Promise<RunStatus>
    }
  }
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim()
}

function makeSpaceFixture(fixtureParent: string): string {
  const spaceRoot = join(fixtureParent, 'space')
  mkdirSync(spaceRoot, { recursive: true })
  writeFileSync(join(spaceRoot, 'README.md'), '# seam fixture\n', 'utf8')
  git(spaceRoot, 'init', '-b', 'main')
  git(spaceRoot, 'config', 'user.name', 'Morz Seam Test')
  git(spaceRoot, 'config', 'user.email', 'seam-test@morz.invalid')
  git(spaceRoot, 'add', '-A')
  git(spaceRoot, 'commit', '-m', 'test: seam fixture')
  return spaceRoot
}

function makePlan(
  spaceRoot: string,
  id: string,
  agents: { agentId: string; cli: 'claude' | 'codex'; promptSeed: string }[]
): unknown {
  return {
    version: '1.0',
    id,
    goal: 'observe dispatched agents',
    agents: agents.map((agent) => ({
      agentId: agent.agentId,
      cli: agent.cli,
      role: `builder: ${agent.agentId}`,
      branch: `run/e2e-seam/${agent.agentId}`,
      worktree: null,
      cwd: '',
      promptSeed: agent.promptSeed,
      dependsOn: [],
      port: null
    })),
    spaceRoot,
    caps: { maxUsd: null, maxTokens: null },
    createdAt: new Date().toISOString(),
    planHash: ''
  }
}

/*
 * The stand-in agent CLI. It reads its kickoff prompt (the dispatcher types
 * `& '<fake>' "$(Get-Content -Raw <seed>)"`) and, when that prompt asks for it,
 * writes the same OSC title sequences an agent CLI writes: a braille spinner
 * while working, an "action required" title while blocked on the owner, and the
 * ✳ prefix at rest. Without the marker it stays title-silent, like a CLI that
 * never announces itself.
 */
function writeFakeCli(path: string): void {
  writeFileSync(
    path,
    [
      'param([Parameter(ValueFromRemainingArguments=$true)][string[]]$Rest)',
      // Windows PowerShell defaults to the OEM code page and would emit the
      // agent glyphs as "?". The real (node-based) CLIs declare UTF-8 for the
      // same reason — without this the fixture would not be writing what a real
      // agent writes.
      '[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false',
      '$prompt = ($Rest -join " ")',
      '$esc = [char]27',
      '$bel = [char]7',
      'function Set-AgentTitle($text) {',
      '  [Console]::Out.Write("$esc]2;$text$bel")',
      '  [Console]::Out.Flush()',
      '}',
      // each step waits for the spec to release it, so no assertion races a sleep
      'function Wait-Gate($name) {',
      '  for ($i = 0; $i -lt 300 -and -not (Test-Path $name); $i++) {',
      '    Start-Sleep -Milliseconds 200',
      '  }',
      '}',
      'Write-Host "MORZ_FAKE_CLI_READY"',
      'if ($prompt -match "EMIT_TITLES") {',
      // the FIRST title is gated too, so the spec can mount the run card while
      // this agent has no observed activity at all
      '  Wait-Gate "go-working.txt"',
      '  Set-AgentTitle "$([char]0x280B) Claude Code"',
      '  Write-Host "MORZ_FAKE_WORKING"',
      '  Wait-Gate "go-waiting.txt"',
      '  Set-AgentTitle "Claude - action required"',
      '  Write-Host "MORZ_FAKE_WAITING"',
      '  Wait-Gate "go-idle.txt"',
      '  Set-AgentTitle "$([char]0x2733) Claude Code"',
      '  Write-Host "MORZ_FAKE_IDLE"',
      '} else {',
      '  Write-Host "MORZ_FAKE_SILENT"',
      '}',
      'Start-Sleep -Seconds 45',
      ''
    ].join('\r\n'),
    'utf8'
  )
}

/*
 * A transcript in the shape Claude Code writes. Both fields the reader uses to
 * attribute a record are present and load-bearing: `cwd` is what proves the
 * record belongs to THIS agent's worktree (the directory name is a lossy slug
 * that two different worktrees can share), and `message.id` is what stops a
 * forked session's copied history from being counted twice.
 */
function seedTranscript(claudeHome: string, worktree: string, turns: number[][]): void {
  const slug = worktree.replace(/[^a-zA-Z0-9]/g, '-')
  const dir = join(claudeHome, '.claude', 'projects', slug)
  mkdirSync(dir, { recursive: true })
  const lines = turns.map(([input, output], index) =>
    JSON.stringify({
      type: 'assistant',
      cwd: worktree,
      message: {
        id: `msg-e2e-${index}`,
        usage: { input_tokens: input, output_tokens: output }
      }
    })
  )
  writeFileSync(join(dir, 'session-e2e.jsonl'), lines.join('\n') + '\n', 'utf8')
}

/*
 * w14/orch-scoped — the Runs tab shows only the ACTIVE space's runs, so the
 * fixture space has to be active BEFORE dispatching. Seed-verify-retry follows
 * the space-tabs pattern: a persist flush can wipe the seed during the reload.
 */
async function seedFixtureSpace(page: Page, spaceRoot: string): Promise<void> {
  let seeded = false
  for (let attempt = 0; attempt < 3 && !seeded; attempt += 1) {
    await page.evaluate((root) => {
      localStorage.setItem(
        'morz.spaces',
        JSON.stringify({
          version: 2,
          state: {
            spaces: [{ id: 'seam-space', name: 'seam-space', root, agents: [] }],
            activeSpaceId: 'seam-space',
            initialized: true
          }
        })
      )
    }, spaceRoot)
    await page.reload({ waitUntil: 'domcontentloaded' })
    try {
      await expect(
        page.getByRole('tablist', { name: 'Spaces' }).getByRole('tab', { name: 'seam-space' })
      ).toHaveAttribute('aria-selected', 'true', { timeout: 5_000 })
      seeded = true
    } catch {
      // persist race wiped the seed — reseed on the fresh page and retry
    }
  }
  expect(seeded, 'seeded fixture space survived reload').toBe(true)
}

test('dispatched panes report real activity and real usage; a silent CLI reports neither', async () => {
  const fixtureParent = join(ROOT, 'e2e', '.tmp', `dispatch-seam-${Date.now()}`)
  const spaceRoot = makeSpaceFixture(fixtureParent)
  const claudeHome = join(fixtureParent, 'home')
  const fakeCli = join(fixtureParent, 'fake-agent.ps1')
  writeFakeCli(fakeCli)

  // Must be set before launchMorz copies process.env into the app env.
  // MORZ_DISPATCH_STUB is cleared explicitly: runs.spec.ts and lanes-runs.spec.ts
  // set it at MODULE level, and Playwright imports every test file into the
  // worker before running any of them — so whichever files share this worker
  // have already turned the stub on. With the stub set the dispatcher never
  // types the launch command, the stand-in CLI never runs, and this spec's
  // whole premise disappears.
  delete process.env.MORZ_DISPATCH_STUB
  process.env.MORZ_DISPATCH_FAKE_CLI = fakeCli
  process.env.MORZ_E2E = '1'
  process.env.MORZ_E2E_CLAUDE_HOME = claudeHome
  const { app, page } = await launchMorz()
  delete process.env.MORZ_DISPATCH_FAKE_CLI
  delete process.env.MORZ_E2E
  delete process.env.MORZ_E2E_CLAUDE_HOME

  try {
    await seedFixtureSpace(page, spaceRoot)
    // the reload discarded the page's PTY collector — waitForTerm needs it back
    await installCollector(page)

    const plan = makePlan(spaceRoot, `plan-seam-${Date.now()}`, [
      { agentId: 'talker', cli: 'claude', promptSeed: 'You are talker. EMIT_TITLES please.' },
      { agentId: 'quiet', cli: 'codex', promptSeed: 'You are quiet. Say nothing structured.' }
    ])
    const { planHash } = await page.evaluate(
      (p) => (window as unknown as MorzRunWindow).morz.run.approvePlan(p),
      plan
    )
    const { runId } = await page.evaluate(
      (p) => (window as unknown as MorzRunWindow).morz.run.dispatch(p),
      { ...(plan as Record<string, unknown>), planHash }
    )
    const readStatus = (): Promise<RunStatus | null> =>
      page.evaluate((id) => (window as unknown as MorzRunWindow).morz.run.runStatus(id), runId)

    const dispatched = (await readStatus())!
    expect(dispatched.state).toBe('running')
    const talker = dispatched.agentsDetail!.talker
    const quiet = dispatched.agentsDetail!.quiet

    // the transcript is attributed to the talker's worktree, which only exists
    // once the run is dispatched — seed it now, before the first turn ends
    seedTranscript(claudeHome, talker.worktree!, [
      [1000, 250],
      [800, 150]
    ])

    // both fake CLIs actually ran in their real panes
    await waitForTerm(page, talker.paneId, /MORZ_FAKE_CLI_READY/)
    await waitForTerm(page, quiet.paneId, /MORZ_FAKE_SILENT/)

    // ── the seam: the titles the CLI wrote became observed agent state ──
    const release = (gate: string): void =>
      writeFileSync(join(talker.worktree!, gate), 'go\n', 'utf8')

    // The run card is mounted BEFORE the agent has written a single title, so
    // the store's one hydrate-on-subscribe fetch cannot be what fills the chip
    // in. From here the run is known to the store and the only remaining update
    // path is a `run:changed` push.
    await page.getByRole('radio', { name: 'Orchestrated' }).click()
    await page.getByRole('tab', { name: 'Runs' }).click()
    await expect(page.getByTestId('run-agent')).toHaveCount(2)
    await expect(page.locator('[data-testid="agent-activity"]')).toHaveCount(0)

    // `working` moves NO ledger row — the agent is already `running` — so a
    // push that only fires on a ledger change leaves this chip frozen forever.
    release('go-working.txt')
    await expect
      .poll(async () => (await readStatus())?.agentsDetail?.talker.activity, { timeout: 30_000 })
      .toBe('working')
    expect((await readStatus())!.agents.talker).toBe('running')
    await expect(
      page.locator('[data-testid="agent-activity"][data-activity="working"]').first()
    ).toBeVisible({ timeout: 20_000 })

    release('go-waiting.txt')
    await expect
      .poll(async () => (await readStatus())?.agentsDetail?.talker.activity, { timeout: 30_000 })
      .toBe('waiting')

    // `waiting` is not cosmetic: it moved the agent's lifecycle state, which is
    // exactly what the audit said Morz could not do for a dispatched pane
    await expect
      .poll(async () => (await readStatus())?.agents.talker, { timeout: 30_000 })
      .toBe('blocked')

    // and the card follows it live, in the words the owner reads
    const activityChip = page.locator('[data-testid="agent-activity"][data-activity="waiting"]')
    await expect(activityChip.first()).toBeVisible({ timeout: 20_000 })
    await expect(activityChip.first()).toContainText('waiting for you')

    // the title settles to idle; the turn ending is what triggers the meter read
    release('go-idle.txt')
    await expect
      .poll(async () => (await readStatus())?.agentsDetail?.talker.activity, { timeout: 30_000 })
      .toBe('idle')

    // ── metering: the run stops reporting {usd:null,tokens:null} ──
    await expect
      .poll(async () => (await readStatus())?.usage.tokens, { timeout: 30_000 })
      .toBe(2200)
    await expect(page.getByTestId('run-usage-tokens')).toHaveText('2,200', { timeout: 20_000 })
    // transcripts carry tokens, not dollars, and Morz ships no price table
    expect((await readStatus())!.usage.usd).toBeNull()

    // ── honest coverage: the silent CLI is reported as unknown, never guessed ──
    const finalStatus = (await readStatus())!
    expect(finalStatus.agentsDetail!.quiet.activity ?? null).toBeNull()
    expect(finalStatus.agents.quiet).toBe('running')
    expect(
      await page.locator('[data-testid="agent-activity"]').count(),
      'only the agent that announced itself gets an activity chip'
    ).toBe(1)

    // ── a final turn's tokens must survive Stop ──
    // The agent writes one more turn and is killed before any idle transition
    // could trigger a read. Teardown has to take a last reading itself, and the
    // two turns already counted must NOT be counted a second time.
    seedTranscript(claudeHome, talker.worktree!, [
      [1000, 250],
      [800, 150],
      [300, 100]
    ])

    // stop + cleanup still behave exactly as before the seam existed
    const stopped = await page.evaluate(
      (id) => (window as unknown as MorzRunWindow).morz.run.stopRun(id),
      runId
    )
    expect(stopped.state).toBe('aborted')
    expect(stopped.usage.tokens, 'the last turn is metered during teardown, once').toBe(2600)
    await page.evaluate((id) => (window as unknown as MorzRunWindow).morz.run.cleanup(id), runId)
  } finally {
    await closeMorz(app)
    rmSync(fixtureParent, { recursive: true, force: true })
  }
})

/*
 * The unhappy metering path, which is where an honest tool earns its keep: a
 * transcript read that never finishes. Teardown abandons it on a deadline, and
 * the run's usage becomes a FLOOR. Every part of saying so is exercised here —
 * an agent with no transcript at all (so there are no numbers to hang the
 * message on), no observed activity (so nothing else pushes), and a full app
 * restart (so an in-memory flag would be gone).
 */
test('an abandoned transcript read is reported as a floor, and survives a restart', async () => {
  const fixtureParent = join(ROOT, 'e2e', '.tmp', `seam-partial-${Date.now()}`)
  const spaceRoot = makeSpaceFixture(fixtureParent)
  const appDataDir = join(fixtureParent, 'appdata')
  const fakeCli = join(fixtureParent, 'fake-agent.ps1')
  writeFakeCli(fakeCli)

  delete process.env.MORZ_DISPATCH_STUB
  process.env.MORZ_DISPATCH_FAKE_CLI = fakeCli
  process.env.MORZ_E2E = '1'
  // force every finalize to exceed its deadline
  process.env.MORZ_E2E_FINALIZE_TIMEOUT_MS = '0'
  let launched = await launchMorz({ appDataDir })
  let app = launched.app
  let page = launched.page
  delete process.env.MORZ_DISPATCH_FAKE_CLI
  delete process.env.MORZ_E2E_FINALIZE_TIMEOUT_MS

  let runId = ''
  try {
    await seedFixtureSpace(page, spaceRoot)

    // no EMIT_TITLES: this agent never announces itself, so it has no activity
    // chip to clear — the case where only the gap itself can trigger a push
    const plan = makePlan(spaceRoot, `plan-partial-${Date.now()}`, [
      { agentId: 'silent', cli: 'claude', promptSeed: 'You are silent. Say nothing structured.' }
    ])
    const { planHash } = await page.evaluate(
      (p) => (window as unknown as MorzRunWindow).morz.run.approvePlan(p),
      plan
    )
    runId = (
      await page.evaluate((p) => (window as unknown as MorzRunWindow).morz.run.dispatch(p), {
        ...(plan as Record<string, unknown>),
        planHash
      })
    ).runId

    await page.getByRole('radio', { name: 'Orchestrated' }).click()
    await page.getByRole('tab', { name: 'Runs' }).click()
    await expect(page.getByTestId('run-agent')).toHaveCount(1)

    const stopped = await page.evaluate(
      (id) => (window as unknown as MorzRunWindow).morz.run.stopRun(id),
      runId
    )
    expect(stopped.state).toBe('aborted')
    expect(stopped.usage.partial, 'an abandoned read must be admitted').toBe(true)
    expect(stopped.usage.tokens, 'this agent produced no transcript at all').toBeNull()

    // With no tokens and no dollars, a guard that only checks the numbers
    // renders NOTHING — an empty panel where a known undercount should be.
    await expect(page.getByTestId('run-usage-partial')).toBeVisible({ timeout: 20_000 })
    await expect(page.getByTestId('run-usage-partial')).toHaveText('at least')
    await expect(page.getByTestId('run-usage-tokens')).toHaveText('0+')

    // ── restart: the flag lives with the run, not with the process ──
    await closeMorz(app)
    launched = await launchMorz({ appDataDir })
    app = launched.app
    page = launched.page

    const afterRestart = await page.evaluate(
      (id) => (window as unknown as MorzRunWindow).morz.run.runStatus(id),
      runId
    )
    expect(
      afterRestart?.usage.partial,
      'a known undercount must not look exact after a restart'
    ).toBe(true)
  } finally {
    delete process.env.MORZ_E2E
    await closeMorz(app)
    rmSync(fixtureParent, { recursive: true, force: true })
  }
})
