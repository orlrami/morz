import { expect, test } from '@playwright/test'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { closeMorz, launchMorz, ROOT, type MorzApp } from './app'

const NATIVE_SESSION_ID = '33333333-3333-4333-8333-333333333333'

function projectSlug(root: string): string {
  return root.replace(/[^A-Za-z0-9]/g, '-')
}

test.describe.serial('start screen (wave 15 slice 7)', () => {
  const fixtureRoot = join(ROOT, 'e2e', '.tmp', `start-screen-${Date.now()}`)
  const fakeBin = join(fixtureRoot, 'bin')
  const fakeHome = join(fixtureRoot, 'home')
  const spaceRoot = join(fixtureRoot, 'space')
  const claudeProject = join(fakeHome, 'projects', projectSlug(spaceRoot))
  const originalEnv = {
    CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
    HOME: process.env.HOME,
    MORZ_E2E: process.env.MORZ_E2E,
    MORZ_E2E_PICK_FOLDER: process.env.MORZ_E2E_PICK_FOLDER,
    MORZ_E2E_SESSIONS_RESUME_STUB: process.env.MORZ_E2E_SESSIONS_RESUME_STUB,
    MORZ_E2E_START_SCREEN_STUB: process.env.MORZ_E2E_START_SCREEN_STUB,
    PATH: process.env.PATH,
    USERPROFILE: process.env.USERPROFILE
  }
  let morz: MorzApp | undefined

  test.beforeAll(() => {
    mkdirSync(fakeBin, { recursive: true })
    mkdirSync(join(fakeHome, '.claude'), { recursive: true })
    mkdirSync(claudeProject, { recursive: true })
    mkdirSync(spaceRoot, { recursive: true })
    writeFileSync(join(spaceRoot, 'README.md'), '# Start screen fixture\n', 'utf8')
    writeFileSync(
      join(fakeBin, 'claude.cmd'),
      [
        '@ECHO OFF',
        'IF "%~1"=="--version" (',
        '  ECHO Claude Code 9.9.9-start-screen',
        '  EXIT /B 0',
        ')',
        'IF "%~1"=="--help" (',
        '  ECHO Usage: claude [options]',
        '  EXIT /B 0',
        ')',
        'EXIT /B 0',
        ''
      ].join('\r\n')
    )
    writeFileSync(
      join(claudeProject, `${NATIVE_SESSION_ID}.jsonl`),
      [
        JSON.stringify({
          type: 'user',
          sessionId: NATIVE_SESSION_ID,
          timestamp: '2026-07-24T12:00:00.000Z',
          gitBranch: 'start-screen',
          cwd: spaceRoot
        }),
        JSON.stringify({
          type: 'assistant',
          message: { model: 'claude-sonnet-4-6', content: [] }
        })
      ].join('\n') + '\n',
      'utf8'
    )

    const systemRoot = process.env.SystemRoot ?? 'C:\\Windows'
    process.env.CLAUDE_CONFIG_DIR = fakeHome
    process.env.HOME = fakeHome
    process.env.USERPROFILE = fakeHome
    process.env.MORZ_E2E = '1'
    process.env.MORZ_E2E_PICK_FOLDER = spaceRoot
    process.env.MORZ_E2E_SESSIONS_RESUME_STUB = '1'
    process.env.MORZ_E2E_START_SCREEN_STUB = '1'
    process.env.PATH = [
      fakeBin,
      join(systemRoot, 'System32'),
      join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0')
    ].join(delimiter)
  })

  test.afterEach(async () => {
    if (morz) await closeMorz(morz.app)
    morz = undefined
  })

  test.afterAll(() => {
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    rmSync(fixtureRoot, { recursive: true, force: true })
  })

  test('fresh profile shows the launcher with plain shell as the default', async () => {
    morz = await launchMorz({ showStartScreen: true })
    const { page } = morz

    await expect(page.getByTestId('start-screen')).toBeVisible()
    await expect(page.getByRole('heading', { name: 'What do you want to do?' })).toBeVisible()
    await expect(page.getByLabel('Session', { exact: true })).toHaveValue('shell')
    await expect(page.getByLabel('Space', { exact: true })).toBeVisible()
    await expect(page.getByRole('region', { name: 'Explorer preview' })).toBeVisible()

    // w16 — frameless window: the launcher must carry a drag strip so the
    // window can be moved before entering the shell.
    const dragRegion = await page
      .getByTestId('start-drag-strip')
      .evaluate((el) => getComputedStyle(el).getPropertyValue('-webkit-app-region'))
    expect(dragRegion.trim()).toBe('drag')
  })

  test('a restored layout boots the shell without ever mounting the launcher', async () => {
    morz = await launchMorz({ showStartScreen: true })
    const { page, appDataDir } = morz
    await page.evaluate(() => {
      window.morz.session.save({
        layout: {
          version: 2,
          tree: {
            type: 'leaf',
            pane: {
              paneId: 'restored-pane',
              kind: 'terminal',
              cwd: '',
              shell: '',
              touched: false
            }
          },
          panes: [
            {
              paneId: 'restored-pane',
              kind: 'terminal',
              cwd: '',
              shell: '',
              touched: false
            }
          ]
        },
        panes: []
      })
    })
    await page.waitForTimeout(300)
    await closeMorz(morz.app)
    morz = undefined

    morz = await launchMorz({ appDataDir, showStartScreen: true })
    await expect(morz.page.getByTestId('start-screen')).toHaveCount(0)
    await expect(morz.page.getByTestId('shell-root')).toBeVisible()
  })

  test('opening the default plain shell creates no agent process', async () => {
    morz = await launchMorz({ showStartScreen: true })
    const { page } = morz

    await page.getByTestId('start-launch').click()
    await expect(page.getByTestId('start-screen')).toHaveCount(0)

    const launches = await page.evaluate(async () => {
      return (
        (window as unknown as {
          morzStartScreenTest?: {
            launches(): Promise<Array<{ shell?: string; argv?: string[] }>>
          }
        }).morzStartScreenTest?.launches() ?? []
      )
    })
    expect(launches.length).toBeGreaterThan(0)
    expect(launches.every((launch) => !launch.shell && (launch.argv?.length ?? 0) === 0)).toBe(true)
  })

  test('selected model reaches the exact CLI spawn arguments', async () => {
    morz = await launchMorz({ showStartScreen: true })
    const { page } = morz

    await page.getByLabel('Session', { exact: true }).selectOption('claude')
    await page.getByLabel('Model').selectOption('sonnet')
    await page.getByLabel('Goal').fill('Review the launch flow')
    await expect(page.getByTestId('spawn-command')).toContainText(
      'claude --model sonnet "Review the launch flow"'
    )
    await page.getByTestId('start-launch').click()

    const launches = await page.evaluate(async () => {
      return (
        (window as unknown as {
          morzStartScreenTest?: {
            launches(): Promise<Array<{ shell?: string; argv?: string[] }>>
          }
        }).morzStartScreenTest?.launches() ?? []
      )
    })
    expect(launches.at(-1)).toMatchObject({
      shell: 'claude',
      argv: ['--model', 'sonnet', 'Review the launch flow']
    })
  })

  test('on-launch preference persists across app relaunches', async () => {
    morz = await launchMorz({ showStartScreen: true })
    const { page, appDataDir } = morz

    await page.getByLabel('On launch').selectOption('always-start-screen')
    await expect(page.getByLabel('On launch')).toHaveValue('always-start-screen')
    await closeMorz(morz.app)
    morz = undefined

    morz = await launchMorz({ appDataDir, showStartScreen: true })
    await expect(morz.page.getByLabel('On launch')).toHaveValue('always-start-screen')
  })

  test('recent native session resumes from the selected space', async () => {
    morz = await launchMorz({ showStartScreen: true })
    const { page } = morz

    await page.getByRole('button', { name: 'Open a folder' }).click()
    await expect(page.getByText('start-screen', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Resume start-screen' }).click()
    await expect(page.getByTestId('start-screen')).toHaveCount(0)

    const starts = await page.evaluate(async () => {
      return (
        (window as unknown as {
          morzSessionsResumeTest?: {
            starts(): Promise<Array<{ sessionId: string; cwd: string }>>
          }
        }).morzSessionsResumeTest?.starts() ?? []
      )
    })
    expect(starts.at(-1)).toMatchObject({ sessionId: NATIVE_SESSION_ID, cwd: spaceRoot })
  })
})
