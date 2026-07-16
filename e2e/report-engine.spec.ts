import { expect, test, type Page } from '@playwright/test'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { MorzReportApi } from '../src/shared/report'
import { closeMorz, launchMorz, type MorzApp } from './app'

const E2E_REPORT = 'MORZ_E2E report: deterministic summary.'
const TEST_KEY = 'sk-morz-e2e-report-key-never-return'
const REPLACEMENT_KEY = 'sk-morz-e2e-report-key-replacement'

function reportConfig(page: Page): Promise<Awaited<ReturnType<MorzReportApi['config']>>> {
  return page.evaluate(() => {
    const report = (window.morz as typeof window.morz & { report: MorzReportApi }).report
    return report.config()
  })
}

test.describe.serial('AI report engine', () => {
  let morz: MorzApp

  test.beforeAll(async () => {
    process.env.MORZ_E2E = '1'
    process.env.MORZ_E2E_REPORT_STUB = E2E_REPORT
    morz = await launchMorz()
  })

  test.afterAll(async () => {
    if (morz) await closeMorz(morz.app)
    delete process.env.MORZ_E2E
    delete process.env.MORZ_E2E_REPORT_STUB
  })

  test('defaults to a configured Claude CLI provider', async () => {
    const config = await reportConfig(morz.page)
    expect(config).toEqual({
      provider: 'claude-cli',
      hasKey: false,
      configured: true
    })
  })

  test('stores API keys encrypted and never returns them through IPC', async () => {
    const firstResponses = await morz.page.evaluate(async ({ key }) => {
      const report = (window.morz as typeof window.morz & { report: MorzReportApi }).report
      const selected = await report.setProvider('openai', 'gpt-4o-mini')
      const saved = await report.setKey('openai', key)
      const loaded = await report.config()
      return { selected, saved, loaded }
    }, { key: TEST_KEY })

    expect(firstResponses.saved).toMatchObject({
      provider: 'openai',
      model: 'gpt-4o-mini',
      hasKey: true,
      configured: true
    })
    expect(JSON.stringify(firstResponses)).not.toContain(TEST_KEY)

    const encryptedPath = join(morz.appDataDir, 'Morz', 'report-secrets.bin')
    expect(existsSync(encryptedPath)).toBe(true)
    expect(readFileSync(encryptedPath).includes(Buffer.from(TEST_KEY))).toBe(false)

    const appDataDir = morz.appDataDir
    await closeMorz(morz.app)
    morz = await launchMorz({ appDataDir })

    const restored = await reportConfig(morz.page)
    expect(restored).toMatchObject({
      provider: 'openai',
      model: 'gpt-4o-mini',
      hasKey: true,
      configured: true
    })
    expect(JSON.stringify(restored)).not.toContain(TEST_KEY)
  })

  test('summarizes through the deterministic E2E provider', async () => {
    const result = await morz.page.evaluate(async () => {
      const report = (window.morz as typeof window.morz & { report: MorzReportApi }).report
      return report.summarize({ kind: 'diff', context: '+const answer = 42\n-const answer = 0' })
    })

    expect(result).toEqual({ ok: true, text: E2E_REPORT, provider: 'openai' })
  })

  test('replaces an unreadable encrypted key store without exposing the key', async () => {
    const encryptedPath = join(morz.appDataDir, 'Morz', 'report-secrets.bin')
    writeFileSync(encryptedPath, Buffer.from('corrupt encrypted report key store'))

    const response = await morz.page.evaluate(async ({ key }) => {
      const report = (window.morz as typeof window.morz & { report: MorzReportApi }).report
      await report.setProvider('openai', 'gpt-4o-mini')
      const before = await report.config()
      const saved = await report.setKey('openai', key)
      return { before, saved }
    }, { key: REPLACEMENT_KEY })

    expect(response.before).toMatchObject({ provider: 'openai', hasKey: false, configured: false })
    expect(response.saved).toMatchObject({ provider: 'openai', hasKey: true, configured: true })
    expect(JSON.stringify(response)).not.toContain(REPLACEMENT_KEY)
    expect(readFileSync(encryptedPath).includes(Buffer.from(REPLACEMENT_KEY))).toBe(false)
  })

  test('fails closed when a key-based provider is unconfigured', async () => {
    const response = await morz.page.evaluate(async () => {
      const report = (window.morz as typeof window.morz & { report: MorzReportApi }).report
      const config = await report.clearKey('openai')
      const result = await report.summarize({ kind: 'commit', context: 'abc123 test commit' })
      return { config, result }
    })

    expect(response.config).toMatchObject({ provider: 'openai', hasKey: false, configured: false })
    expect(response.result).toMatchObject({ ok: false, provider: 'openai' })
    expect(response.result.text).toContain('not configured')
  })

  test('launches an npm-style Windows Claude command shim', async () => {
    test.skip(process.platform !== 'win32', 'Windows command-shim regression.')
    const appDataDir = morz.appDataDir
    const originalPath = process.env.PATH
    const shimDirectory = join(appDataDir, 'fake claude bin')
    mkdirSync(shimDirectory, { recursive: true })
    writeFileSync(
      join(shimDirectory, 'claude.cmd'),
      '@echo off\r\nmore >nul\r\necho MORZ_E2E command shim summary.\r\n',
      'utf8'
    )

    let shimMorz: MorzApp | undefined
    let result: Awaited<ReturnType<MorzReportApi['summarize']>> | undefined
    await closeMorz(morz.app)
    delete process.env.MORZ_E2E_REPORT_STUB
    process.env.PATH = `${shimDirectory};${originalPath ?? ''}`
    try {
      shimMorz = await launchMorz({ appDataDir })
      result = await shimMorz.page.evaluate(async () => {
        const report = (window.morz as typeof window.morz & { report: MorzReportApi }).report
        await report.setProvider('claude-cli')
        return report.summarize({ kind: 'commit', context: 'test the command shim' })
      })
    } finally {
      if (shimMorz) await closeMorz(shimMorz.app)
      if (originalPath === undefined) delete process.env.PATH
      else process.env.PATH = originalPath
      process.env.MORZ_E2E_REPORT_STUB = E2E_REPORT
      morz = await launchMorz({ appDataDir })
    }

    expect(result).toEqual({
      ok: true,
      text: 'MORZ_E2E command shim summary.',
      provider: 'claude-cli'
    })
  })

  test('replies through the live Claude CLI when explicitly enabled', async () => {
    test.skip(process.env.MORZ_LIVE_REPORT !== '1', 'Set MORZ_LIVE_REPORT=1 for the live CLI gate.')
    const appDataDir = morz.appDataDir
    await closeMorz(morz.app)
    delete process.env.MORZ_E2E_REPORT_STUB
    morz = await launchMorz({ appDataDir })

    const hostileCwd = join(appDataDir, 'hostile-report-cwd')
    const marker = join(hostileCwd, 'shadowed-claude-ran.txt')
    mkdirSync(hostileCwd, { recursive: true })
    writeFileSync(
      join(hostileCwd, 'claude.cmd'),
      `@echo off\r\n> "${marker}" echo compromised\r\necho MALICIOUS CLAUDE\r\n`,
      'utf8'
    )

    const result = await morz.page.evaluate(async ({ cwd }) => {
      const report = (window.morz as typeof window.morz & { report: MorzReportApi }).report
      await report.setProvider('claude-cli')
      return report.summarize({
        kind: 'diff',
        context: '+const trusted = true\n-const trusted = false',
        cwd
      })
    }, { cwd: hostileCwd })

    expect(result).toMatchObject({ ok: true, provider: 'claude-cli' })
    expect(result.text.length).toBeGreaterThan(0)
    expect(result.text).not.toContain('MALICIOUS CLAUDE')
    expect(existsSync(marker)).toBe(false)
  })
})
