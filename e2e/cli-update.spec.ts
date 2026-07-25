import { expect, test } from '@playwright/test'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import type { CliConnection, MorzConnectionsApi } from '../src/shared/connections'
import type { MorzApi } from '../src/shared/ipc'
import { closeMorz, launchMorz, ROOT, waitForTerm, type MorzApp } from './app'

interface UpdateAwareConnection extends CliConnection {
  detectedAt: number
  versionStale: boolean
  update: {
    available: boolean
    latestVersion: string | null
  } | null
}

interface CliUpdateWindow {
  morz: MorzApi
  morzConnections: MorzConnectionsApi
}

test.describe.serial('CLI update flow', () => {
  const fixtureRoot = join(ROOT, 'e2e', '.tmp', 'cli-update')
  const fakeBin = join(fixtureRoot, 'bin')
  const fakeHome = join(fixtureRoot, 'home')
  const versionFile = join(fixtureRoot, 'claude-version.txt')
  const latestFile = join(fixtureRoot, 'claude-latest.txt')
  const invocationLog = join(fixtureRoot, 'invocations.log')
  const originalEnv = {
    HOME: process.env.HOME,
    MORZ_E2E: process.env.MORZ_E2E,
    MORZ_CLI_UPDATE_LOG: process.env.MORZ_CLI_UPDATE_LOG,
    PATH: process.env.PATH,
    USERPROFILE: process.env.USERPROFILE
  }
  let morz: MorzApp | undefined

  const writeVersion = (version: string): void => {
    writeFileSync(versionFile, version, 'utf8')
  }

  const invocations = (): string => {
    try {
      return readFileSync(invocationLog, 'utf8')
    } catch {
      return ''
    }
  }

  test.beforeAll(async () => {
    rmSync(fixtureRoot, { recursive: true, force: true })
    mkdirSync(join(fakeHome, '.claude'), { recursive: true })
    mkdirSync(fakeBin, { recursive: true })
    writeVersion('1.0.0-e2e')
    writeFileSync(latestFile, '2.0.0-e2e', 'utf8')
    writeFileSync(
      join(fakeBin, 'claude.cmd'),
      [
        '@ECHO OFF',
        'SETLOCAL ENABLEDELAYEDEXPANSION',
        'IF "%~1"=="--version" (',
        `  SET /P MORZ_VERSION=<"${versionFile}"`,
        '  IF /I "!MORZ_VERSION!"=="FAIL" EXIT /B 1',
        '  ECHO Claude Code !MORZ_VERSION!',
        '  EXIT /B 0',
        ')',
        'IF "%~1"=="--help" (',
        '  ECHO Usage: claude [options] [command]',
        '  ECHO Commands: update',
        '  EXIT /B 0',
        ')',
        'IF "%~1"=="doctor" (',
        `  SET /P MORZ_LATEST=<"${latestFile}"`,
        '  ECHO Claude Code doctor',
        '  ECHO Latest version: !MORZ_LATEST!',
        '  EXIT /B 0',
        ')',
        'IF "%~1"=="update" (',
        `  ECHO update>>"${invocationLog}"`,
        '  ECHO MORZ_STUB_UPDATE_VISIBLE',
        '  EXIT /B 0',
        ')',
        `"${process.execPath}" "${join(fakeBin, 'claude-lane.cjs')}" %*`,
        ''
      ].join('\r\n'),
      'utf8'
    )
    writeFileSync(
      join(fakeBin, 'claude-lane.cjs'),
      [
        "const fs = require('node:fs')",
        "const args = process.argv.slice(2)",
        "fs.appendFileSync(process.env.MORZ_CLI_UPDATE_LOG, `lane ${args.join(' ')}\\n`, 'utf8')",
        "if (!process.cwd().includes('no-session')) {",
        "  process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'held-resume-e2e', model: 'stub' }) + '\\n')",
        "}",
        "process.stdin.resume()"
      ].join('\n'),
      'utf8'
    )
    writeFileSync(
      join(fakeBin, 'codex.cmd'),
      [
        '@ECHO OFF',
        'IF "%~1"=="--version" ECHO codex-cli 1.0.0-e2e& EXIT /B 0',
        'EXIT /B 1',
        ''
      ].join('\r\n'),
      'utf8'
    )
    writeFileSync(
      join(fakeBin, 'npm.cmd'),
      [
        '@ECHO OFF',
        'IF "%~1"=="ls" (',
        '  ECHO npm warn e2e fixture',
        '  ECHO {"dependencies":{"@openai/codex":{"version":"1.0.0-e2e"}}}',
        '  EXIT /B 0',
        ')',
        'IF "%~1"=="outdated" (',
        '  ECHO npm warn e2e fixture',
        '  ECHO {"@openai/codex":{"current":"1.0.0-e2e","latest":"2.0.0-e2e"}}',
        '  EXIT /B 1',
        ')',
        'IF "%~1"=="update" (',
        `  ECHO npm-update>>"${invocationLog}"`,
        '  ECHO MORZ_STUB_NPM_UPDATE_VISIBLE',
        '  EXIT /B 0',
        ')',
        'EXIT /B 1',
        ''
      ].join('\r\n'),
      'utf8'
    )
    writeFileSync(
      join(fakeBin, 'agy.cmd'),
      [
        '@ECHO OFF',
        'IF "%~1"=="--version" ECHO agy 1.0.0-e2e& EXIT /B 0',
        'IF "%~1"=="update" ECHO unknown command update 1>&2& EXIT /B 1',
        'EXIT /B 1',
        ''
      ].join('\r\n'),
      'utf8'
    )

    const systemRoot = process.env.SystemRoot ?? 'C:\\Windows'
    process.env.MORZ_E2E = '1'
    process.env.MORZ_CLI_UPDATE_LOG = invocationLog
    process.env.HOME = fakeHome
    process.env.USERPROFILE = fakeHome
    process.env.PATH = [
      fakeBin,
      join(systemRoot, 'System32'),
      join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0')
    ].join(delimiter)
  })

  test.afterAll(async () => {
    if (morz) await closeMorz(morz.app)
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    rmSync(fixtureRoot, { recursive: true, force: true })
  })

  test('re-probes on boot and keeps a failed refresh visibly stale', async () => {
    morz = await launchMorz()
    const first = await morz.page.evaluate(() =>
      (window as unknown as CliUpdateWindow).morzConnections.list()
    ) as UpdateAwareConnection[]
    const firstClaude = first.find((connection) => connection.id === 'claude')
    expect(firstClaude).toMatchObject({
      version: 'Claude Code 1.0.0-e2e',
      versionStale: false,
      update: { available: true, latestVersion: '2.0.0-e2e' }
    })
    expect(firstClaude!.detectedAt).toBeGreaterThan(Date.now() - 30_000)
    expect(invocations()).not.toContain('update')
    expect(first.find((connection) => connection.id === 'codex')).toMatchObject({
      update: { available: true, latestVersion: '2.0.0-e2e' }
    })
    expect(first.find((connection) => connection.id === 'agy')).toMatchObject({ update: null })

    const appDataDir = morz.appDataDir
    await closeMorz(morz.app)
    morz = undefined
    writeVersion('1.1.0-e2e')
    morz = await launchMorz({ appDataDir })

    await morz.page.getByRole('button', { name: 'Settings', exact: true }).click()
    await morz.page.getByRole('button', { name: 'Connections & Models', exact: true }).click()
    const card = morz.page.getByTestId('connection-claude')
    await expect(card).toContainText('Claude Code 1.1.0-e2e')
    await expect(card).toContainText(/checked (just now|\d+[smh] ago)/i)

    writeVersion('FAIL')
    await morz.page.getByRole('button', { name: 'Refresh CLI connections' }).click()
    await expect(card).toContainText('Claude Code 1.1.0-e2e')
    await expect(card).toContainText(/stale/i)
    await expect(morz.page.getByTestId('model-card-claude')).toContainText(/stale/i)
    await expect(card.getByRole('button', { name: 'Update Claude Code now' })).toHaveCount(0)
  })

  test('runs the updater in a visible pane and restarts a held Claude session only after consent', async () => {
    const page = morz!.page
    writeVersion('1.1.0-e2e')
    await page.getByRole('button', { name: 'Refresh CLI connections' }).click()

    await page.evaluate(
      ({ cwd }) =>
        new Promise<void>((resolve) => {
          const api = (window as unknown as CliUpdateWindow).morz.claude
          api.onEvent(({ agentId, event }) => {
            if (
              agentId === 'cli-update-live-lane'
              && event.type === 'system'
              && (event as { subtype?: string }).subtype === 'init'
            ) {
              resolve()
            }
          })
          void api.start({ agentId: 'cli-update-live-lane', cwd })
        }),
      { cwd: fixtureRoot }
    )
    const noSessionRoot = join(fixtureRoot, 'no-session')
    mkdirSync(noSessionRoot, { recursive: true })
    await page.evaluate(
      ({ cwd }) =>
        (window as unknown as CliUpdateWindow).morz.claude.start({
          agentId: 'cli-update-plain-lane',
          cwd
        }),
      { cwd: noSessionRoot }
    )
    await expect.poll(() => invocations().match(/^lane /gm)?.length ?? 0).toBe(2)

    const card = page.getByTestId('connection-claude')
    await expect(card).toContainText('Update available')
    await card.getByRole('button', { name: 'Update Claude Code now' }).click()

    const updatePane = page.locator('[data-pane-id^="cli-update-claude-"]')
    await expect(updatePane).toBeVisible()
    const paneId = await updatePane.getAttribute('data-pane-id')
    expect(paneId).not.toBeNull()
    await waitForTerm(page, paneId!, /MORZ_STUB_UPDATE_VISIBLE/)
    await expect.poll(invocations).toContain('update')

    await page.getByRole('button', { name: /^Notifications/ }).click()
    const center = page.getByRole('dialog', { name: 'Notification center' })
    await expect(center.getByText('Claude Code updated')).toBeVisible()
    await center.getByRole('button', { name: 'Restart Claude sessions' }).click()

    await expect.poll(() => invocations().match(/^lane /gm)?.length ?? 0).toBe(4)
    expect(invocations()).toMatch(/lane .*--resume held-resume-e2e/)
    await expect(center).toContainText('1 restarted without a resume ID')
  })

  test('uses the npm installer channel for Codex and hides unsupported agy updates', async () => {
    const page = morz!.page
    const openCenter = page.getByRole('dialog', { name: 'Notification center' })
    if (await openCenter.isVisible()) {
      await openCenter.getByRole('button', { name: 'Close notification center' }).click()
    }
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    await page.getByRole('button', { name: 'Connections & Models', exact: true }).click()

    const codexCard = page.getByTestId('connection-codex')
    await expect(codexCard).toContainText('Update available')
    await expect(page.getByTestId('connection-agy').getByRole('button', { name: 'Update Antigravity now' }))
      .toHaveCount(0)
    await codexCard.getByRole('button', { name: 'Update Codex now' }).click()

    const updatePane = page.locator('[data-pane-id^="cli-update-codex-"]')
    await expect(updatePane).toBeVisible()
    const paneId = await updatePane.getAttribute('data-pane-id')
    expect(paneId).not.toBeNull()
    await waitForTerm(page, paneId!, /MORZ_STUB_NPM_UPDATE_VISIBLE/)
    await expect.poll(invocations).toContain('npm-update')

    await page.getByRole('button', { name: /^Notifications/ }).click()
    const center = page.getByRole('dialog', { name: 'Notification center' })
    const notice = center.locator('[data-notice-id="connections:update:codex"]')
    await expect(notice).toContainText('Codex updated')
    await expect(notice.getByRole('button', { name: 'Restart Claude sessions' })).toHaveCount(0)
  })
})
