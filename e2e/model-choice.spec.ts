/*
 * w15/model-choice e2e — the ModelChoice engine on every launch surface.
 *
 * DoD (WAVE15 slice 6):
 *  - a session-flag choice appears in the spawn args for a Claude LANE and in
 *    the typed launch command of a DISPATCHED agent (stubbed fake CLI),
 *  - inherit adds NO flag,
 *  - the cli-config path yields a DIFF PROPOSAL, never a write,
 *  - a per-space override wins over the global choice.
 *
 * The lane assertion rides the MORZ_E2E spawn-args seam (the adapter records
 * argv before spawning); the dispatch assertion reads the typed command out
 * of the pane's PTY buffer (the fake-CLI path from dispatch.spec).
 * MORZ_CONFIG_HOME points the config-writer at a fixture home so proposals
 * never touch the developer's real ~/.claude or ~/.codex.
 */
import { expect, test } from '@playwright/test'
import { execFileSync } from 'child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'path'
import { closeMorz, launchMorz, waitForTerm, ROOT } from './app'
import { createConfigWriter } from '../src/main/services/config-writer'
import type { ConfigWriterProposal, ModelChoiceSetInput, ModelChoiceSnapshot } from '../src/shared/ipc'

interface ModelsWindow {
  morzModels: {
    list(spaceRoot?: string): Promise<ModelChoiceSnapshot[]>
    set(input: ModelChoiceSetInput): Promise<ModelChoiceSnapshot[]>
    clearOverride(cli: string, spaceRoot: string): Promise<ModelChoiceSnapshot[]>
    proposeConfig(cli: string, model: string): Promise<ConfigWriterProposal>
    testLaneSpawnArgs(): Promise<string[] | null>
  }
  morz: {
    claude: { start(o: { agentId: string; cwd: string }): Promise<{ agentId: string }> }
    run: {
      approvePlan(plan: unknown): Promise<{ planHash: string }>
      dispatch(plan: unknown): Promise<{ runId: string }>
      runStatus(runId: string): Promise<{ agentsDetail?: Record<string, { paneId: string }> } | null>
      stopRun(runId: string): Promise<unknown>
      cleanup(runId: string): Promise<unknown>
    }
  }
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim()
}

function makeConfigHome(parent: string): string {
  const home = join(parent, 'config-home')
  mkdirSync(join(home, '.claude'), { recursive: true })
  mkdirSync(join(home, '.codex'), { recursive: true })
  writeFileSync(join(home, '.claude', 'settings.json'), '{\n  "theme": "dark"\n}\n', 'utf8')
  writeFileSync(join(home, '.codex', 'config.toml'), 'model = "gpt-5.5"\n', 'utf8')
  return home
}

function makeSpaceFixture(parent: string): string {
  const spaceRoot = join(parent, 'space')
  mkdirSync(spaceRoot, { recursive: true })
  writeFileSync(join(spaceRoot, 'README.md'), '# model-choice fixture\n', 'utf8')
  git(spaceRoot, 'init', '-b', 'main')
  git(spaceRoot, 'config', 'user.name', 'Morz Model Test')
  git(spaceRoot, 'config', 'user.email', 'model-test@morz.invalid')
  git(spaceRoot, 'add', '-A')
  git(spaceRoot, 'commit', '-m', 'test: model-choice fixture')
  return spaceRoot
}

/* ── lanes: session flag / inherit / override / cli-config / fallback ── */

test('lane spawn args carry the session-flag model; inherit adds no flag; space override wins; cli-config never flags', async () => {
  const fixtureParent = join(ROOT, 'e2e', '.tmp', `model-choice-${Date.now()}`)
  mkdirSync(fixtureParent, { recursive: true })
  const configHome = makeConfigHome(fixtureParent)
  const spaceRoot = join(fixtureParent, 'lane-space')
  mkdirSync(spaceRoot, { recursive: true })

  process.env.MORZ_E2E = '1'
  process.env.MORZ_CONFIG_HOME = configHome
  const { app, page } = await launchMorz()
  delete process.env.MORZ_E2E
  delete process.env.MORZ_CONFIG_HOME
  try {
    const startLane = async (agentId: string, cwd: string): Promise<string[]> => {
      await page.evaluate(
        async ({ id, dir }) => {
          const win = window as unknown as ModelsWindow
          await win.morz.claude.start({ agentId: id, cwd: dir })
        },
        { id: agentId, dir: cwd }
      )
      const args = await page.evaluate(() =>
        (window as unknown as ModelsWindow).morzModels.testLaneSpawnArgs()
      )
      expect(args).not.toBeNull()
      return args!
    }

    // 1. global session flag → --model opus in the lane argv
    await page.evaluate(() =>
      (window as unknown as ModelsWindow).morzModels.set({
        cli: 'claude',
        model: 'opus',
        source: 'session-flag'
      })
    )
    let args = await startLane('e2e-model-flag', spaceRoot)
    expect(args.join(' ')).toContain('--model opus')

    // 2. fallback chain rides along (print mode)
    await page.evaluate(() =>
      (window as unknown as ModelsWindow).morzModels.set({
        cli: 'claude',
        model: 'opus',
        source: 'session-flag',
        fallback: 'opus, sonnet'
      })
    )
    args = await startLane('e2e-model-fallback', spaceRoot)
    expect(args.join(' ')).toContain('--model opus')
    expect(args.join(' ')).toContain('--fallback-model opus,sonnet')

    // 3. inherit → NO model flag at all
    await page.evaluate(() =>
      (window as unknown as ModelsWindow).morzModels.set({
        cli: 'claude',
        model: 'inherit',
        source: 'inherit'
      })
    )
    args = await startLane('e2e-model-inherit', spaceRoot)
    expect(args).not.toContain('--model')
    expect(args).not.toContain('--fallback-model')

    // 4. per-space override WINS over the global choice
    await page.evaluate(() =>
      (window as unknown as ModelsWindow).morzModels.set({
        cli: 'claude',
        model: 'sonnet',
        source: 'session-flag'
      })
    )
    await page.evaluate(
      (root) =>
        (window as unknown as ModelsWindow).morzModels.set({
          cli: 'claude',
          model: 'opus',
          source: 'session-flag',
          spaceRoot: root
        }),
      spaceRoot
    )
    args = await startLane('e2e-model-override', spaceRoot)
    expect(args.join(' ')).toContain('--model opus')
    // a lane in a DIFFERENT cwd still gets the global choice
    args = await startLane('e2e-model-global', fixtureParent)
    expect(args.join(' ')).toContain('--model sonnet')
    // snapshot reports override vs global distinctly
    const snapshots = await page.evaluate(
      (root) => (window as unknown as ModelsWindow).morzModels.list(root),
      spaceRoot
    )
    const claude = snapshots.find((snapshot) => snapshot.cli === 'claude')!
    expect(claude.global.model).toBe('sonnet')
    expect(claude.spaceOverride?.model).toBe('opus')
    expect(claude.effective.model).toBe('opus')

    // 5. cli-config source: launches carry NO flag; the write path is a DIFF
    //    PROPOSAL against the fixture home — the file itself never changes.
    await page.evaluate(
      (root) => (window as unknown as ModelsWindow).morzModels.clearOverride('claude', root),
      spaceRoot
    )
    await page.evaluate(() =>
      (window as unknown as ModelsWindow).morzModels.set({
        cli: 'claude',
        model: 'opus',
        source: 'cli-config'
      })
    )
    args = await startLane('e2e-model-config', spaceRoot)
    expect(args).not.toContain('--model')

    const settingsPath = join(configHome, '.claude', 'settings.json')
    const before = await readFile(settingsPath, 'utf8')
    const proposal = await page.evaluate(() =>
      (window as unknown as ModelsWindow).morzModels.proposeConfig('claude', 'opus')
    )
    expect(proposal.unifiedDiff).toContain('"model": "opus"')
    expect(proposal.path).toBe(settingsPath)
    await expect(readFile(settingsPath, 'utf8')).resolves.toBe(before) // proposal ≠ write
  } finally {
    await closeMorz(app)
    try {
      rmSync(fixtureParent, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
    } catch {
      // a real `claude` lane may release its cwd lock after the kill sweep;
      // e2e/.tmp is git-ignored, so a leftover fixture dir is harmless.
    }
  }
})

/* ── dispatch: the typed launch command carries the per-agent model flag ── */

test('dispatched agent launch command prefers the explicit plan model over the user default', async () => {
  const fixtureParent = join(ROOT, 'e2e', '.tmp', `model-dispatch-${Date.now()}`)
  const spaceRoot = makeSpaceFixture(fixtureParent)
  const fakeCli = join(fixtureParent, 'fake-claude.cmd')
  writeFileSync(fakeCli, '@echo off\r\necho MORZ_FAKE_MODEL_READY\r\n', 'utf8')

  process.env.MORZ_E2E = '1'
  process.env.MORZ_DISPATCH_FAKE_CLI = fakeCli
  const { app, page } = await launchMorz()
  delete process.env.MORZ_E2E
  delete process.env.MORZ_DISPATCH_FAKE_CLI
  try {
    await page.evaluate(() =>
      (window as unknown as ModelsWindow).morzModels.set({
        cli: 'claude',
        model: 'opus',
        source: 'session-flag'
      })
    )

    const plan = {
      version: '1.0',
      id: 'plan-model-choice-e2e',
      goal: 'prove the model flag rides the dispatch launch',
      agents: [
        {
          agentId: 'solo',
          cli: 'claude',
          model: 'fable',
          role: 'builder: solo',
          branch: 'run/e2e/model-solo',
          worktree: null,
          cwd: '',
          promptSeed: 'You are solo. Do the thing.',
          dependsOn: [],
          port: null
        }
      ],
      spaceRoot,
      caps: { maxUsd: null, maxTokens: null },
      createdAt: new Date().toISOString(),
      planHash: ''
    }
    const { planHash } = await page.evaluate(
      (p) => (window as unknown as ModelsWindow).morz.run.approvePlan(p),
      plan
    )
    const { runId } = await page.evaluate(
      (p) => (window as unknown as ModelsWindow).morz.run.dispatch(p),
      { ...(plan as Record<string, unknown>), planHash }
    )
    const status = (await page.evaluate(
      (id) => (window as unknown as ModelsWindow).morz.run.runStatus(id),
      runId
    ))!
    const paneId = status.agentsDetail!.solo.paneId

    // the typed launch command echoes in the PTY: flag present, CLI executed.
    // PSReadLine interleaves ANSI redraws/wraps inside the echoed command, so
    // strip escapes and whitespace before matching the flag.
    const buffer = await waitForTerm(page, paneId, /MORZ_FAKE_MODEL_READY/)
    const clean = buffer.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\s+/g, '')
    expect(clean).toContain('--modelfable')

    await page.evaluate((id) => (window as unknown as ModelsWindow).morz.run.stopRun(id), runId)
    await page.evaluate((id) => (window as unknown as ModelsWindow).morz.run.cleanup(id), runId)
  } finally {
    await closeMorz(app)
    rmSync(fixtureParent, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  }
})

/* ── config-writer model proposals (node-level, fixture paths) ── */

test('proposeModel produces diffs for claude/codex/opencode and creates a missing settings.json only on apply', async () => {
  const home = await mkdtemp(join(tmpdir(), 'morz-model-config-'))
  mkdirSync(join(home, '.claude'), { recursive: true })
  mkdirSync(join(home, '.codex'), { recursive: true })
  const claudePath = join(home, '.claude', 'settings.json')
  const codexPath = join(home, '.codex', 'config.toml')
  const opencodePath = join(home, 'opencode.json')
  writeFileSync(codexPath, 'model = "gpt-5.5"\nprofile = "dev"\n', 'utf8')
  writeFileSync(opencodePath, '{\n  "model": "anthropic/claude-sonnet-4-5"\n}\n', 'utf8')
  const writer = createConfigWriter({
    modelPaths: { claude: claudePath, codex: codexPath, opencode: opencodePath },
    homeDir: home,
    projectDir: home
  })

  // codex: TOML model key swapped, nothing written until apply
  const codexProposal = await writer.proposeModel('codex', 'gpt-5.4')
  expect(codexProposal.unifiedDiff).toContain('model = "gpt-5.4"')
  await expect(readFile(codexPath, 'utf8')).resolves.toContain('gpt-5.5')

  // opencode: JSON model key replaced
  const opencodeProposal = await writer.proposeModel('opencode', 'anthropic/claude-opus-4-6')
  expect(opencodeProposal.unifiedDiff).toContain('"model": "anthropic/claude-opus-4-6"')

  // claude: settings.json absent → CREATE proposal; apply writes it once
  expect(existsSync(claudePath)).toBe(false)
  const claudeProposal = await writer.proposeModel('claude', 'sonnet')
  expect(claudeProposal.unifiedDiff).toContain('"model": "sonnet"')
  expect(existsSync(claudePath)).toBe(false) // still a proposal, not a write
  const applied = await writer.apply(claudeProposal.proposalId)
  expect(applied.backupPath).toBe('') // nothing existed to back up
  const written = JSON.parse(await readFile(claudePath, 'utf8'))
  expect(written.model).toBe('sonnet')

  // unsafe model ids are refused before any file is read
  await expect(writer.proposeModel('claude', 'opus"; rm -rf /')).rejects.toThrow(/unsupported shape/i)
  rmSync(home, { recursive: true, force: true })
})
