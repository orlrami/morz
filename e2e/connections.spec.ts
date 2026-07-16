import { expect, test } from '@playwright/test'
import { mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import type { CliConnection, MorzConnectionsApi } from '../src/shared/connections'
import { closeMorz, launchMorz, ROOT, type MorzApp } from './app'

test.describe.serial('CLI connections', () => {
  const fixtureRoot = join(ROOT, 'e2e', '.tmp', 'connections')
  const fakeBin = join(fixtureRoot, 'bin')
  const fakeHome = join(fixtureRoot, 'home')
  const originalEnv = {
    HOME: process.env.HOME,
    MORZ_E2E: process.env.MORZ_E2E,
    PATH: process.env.PATH,
    USERPROFILE: process.env.USERPROFILE
  }
  let morz: MorzApp | undefined

  test.beforeAll(async () => {
    rmSync(fixtureRoot, { recursive: true, force: true })
    mkdirSync(join(fakeHome, '.claude'), { recursive: true })
    mkdirSync(fakeBin, { recursive: true })
    writeFileSync(
      join(fakeBin, 'claude.cmd'),
      [
        '@ECHO OFF',
        'IF "%~1"=="--version" (',
        '  ECHO Claude Code 9.9.9-e2e',
        '  EXIT /B 0',
        ')',
        'IF "%~1"=="--help" (',
        '  ECHO Usage: claude [options]',
        '  EXIT /B 0',
        ')',
        'EXIT /B 1',
        ''
      ].join('\r\n')
    )

    const systemRoot = process.env.SystemRoot ?? 'C:\\Windows'
    process.env.MORZ_E2E = '1'
    process.env.HOME = fakeHome
    process.env.USERPROFILE = fakeHome
    process.env.PATH = [
      fakeBin,
      join(systemRoot, 'System32'),
      join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0')
    ].join(delimiter)
    morz = await launchMorz()
  })

  test.afterAll(async () => {
    if (morz) await closeMorz(morz.app)
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    rmSync(fixtureRoot, { recursive: true, force: true })
  })

  test('detects installed CLIs and renders honest connection and usage states', async () => {
    const page = morz!.page
    const connections = await page.evaluate(() =>
      (window as unknown as { morzConnections: MorzConnectionsApi }).morzConnections.list()
    )

    expect(connections.find((connection) => connection.id === 'claude')).toMatchObject<Partial<CliConnection>>({
      installed: true,
      version: 'Claude Code 9.9.9-e2e',
      authed: null,
      usage: null
    })
    expect(connections.find((connection) => connection.id === 'codex')).toMatchObject<Partial<CliConnection>>({
      installed: false,
      version: null,
      authed: null,
      usage: null
    })

    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    await page.getByRole('button', { name: 'Connections', exact: true }).click()
    const settings = page.getByRole('region', { name: 'CLI connections' })
    await expect(settings).toBeVisible()
    await expect(settings.getByTestId('connection-claude')).toContainText('Claude Code 9.9.9-e2e')
    await expect(settings.getByTestId('connection-claude')).toContainText('Authentication unknown')
    await expect(settings.getByTestId('connection-codex')).toContainText('Not installed')

    await page.getByRole('button', { name: 'Limits & usage', exact: true }).click()
    await expect(page.getByRole('progressbar')).toHaveCount(0)
    await expect(page.getByText('No CLI usage data is available')).toBeVisible()

    const transcriptDir = join(fakeHome, '.claude', 'projects', 'e2e-project')
    mkdirSync(transcriptDir, { recursive: true })
    writeFileSync(
      join(transcriptDir, 'session.jsonl'),
      `${JSON.stringify({
        timestamp: new Date().toISOString(),
        type: 'rate_limit_event',
        rate_limit_info: {
          used_pct: 42.5,
          resets_at: new Date(Date.now() + 60 * 60 * 1_000).toISOString()
        }
      })}\n`
    )
    const olderEventPath = join(transcriptDir, 'newer-file-older-event.jsonl')
    writeFileSync(
      olderEventPath,
      [
        {
          timestamp: new Date(Date.now() - 30 * 60 * 1_000).toISOString(),
          type: 'rate_limit_event',
          rate_limit_info: {
            used_pct: 91,
            resets_at: new Date(Date.now() + 30 * 60 * 1_000).toISOString()
          }
        },
        {
          timestamp: new Date().toISOString(),
          type: 'assistant',
          rate_limit_info: { used_pct: 99 }
        },
        {
          timestamp: new Date(Date.now() - 6 * 60 * 60 * 1_000).toISOString(),
          type: 'rate_limit_event',
          rate_limit_info: { used_pct: 100 }
        },
        {
          timestamp: new Date(Date.now() + 24 * 60 * 60 * 1_000).toISOString(),
          type: 'rate_limit_event',
          rate_limit_info: { used_pct: 100 }
        }
      ].map((event) => JSON.stringify(event)).join('\n') + '\n'
    )
    const laterMtime = new Date(Date.now() + 5_000)
    utimesSync(olderEventPath, laterMtime, laterMtime)

    await page.getByRole('button', { name: 'Connections', exact: true }).click()
    await page.getByRole('button', { name: 'Refresh CLI connections' }).click()
    await page.getByRole('button', { name: 'Limits & usage', exact: true }).click()
    const realUsage = page.getByRole('progressbar', { name: 'Claude Code usage' })
    await expect(realUsage).toHaveAttribute('aria-valuenow', '42.5')
  })
})
