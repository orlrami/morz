import { expect, test } from '@playwright/test'
import { execFileSync } from 'child_process'
import { mkdirSync, rmSync, writeFileSync } from 'fs'
import { basename, join } from 'path'
import { closeMorz, launchMorz, type MorzApp, ROOT } from './app'

const OLD_SESSION_ID = '11111111-1111-4111-8111-111111111111'
const NEW_SESSION_ID = '22222222-2222-4222-8222-222222222222'
const UNSAFE_SESSION_ID = 'bad&session'

function projectSlug(root: string): string {
  return root.replace(/[^A-Za-z0-9]/g, '-')
}

function seedClaudeSession(
  projectDir: string,
  sessionId: string,
  timestamp: string,
  branch: string,
  model: string
): void {
  writeFileSync(
    join(projectDir, `${sessionId}.jsonl`),
    [
      JSON.stringify({
        type: 'user',
        sessionId,
        timestamp,
        gitBranch: branch,
        cwd: 'ignored-by-session-scan'
      }),
      JSON.stringify({ type: 'assistant', message: { model, content: [] } })
    ].join('\n') + '\n',
    'utf8'
  )
}

test.describe.serial('visible session controls and morz resume (w13/sessions-visible)', () => {
  let morz: MorzApp | undefined
  const fixtureParent = join(ROOT, 'e2e', '.tmp', `sessions-resume-${Date.now()}`)
  const spaceRoot = join(fixtureParent, 'resume-space')
  const noNativeSpaceRoot = join(fixtureParent, 'no-native-space')
  const claudeConfigDir = join(fixtureParent, 'claude-config')
  const projectDir = join(claudeConfigDir, 'projects', projectSlug(spaceRoot))
  const originalClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR
  const originalStub = process.env.MORZ_E2E_SESSIONS_RESUME_STUB
  const originalPicker = process.env.MORZ_E2E_PICK_FOLDER

  test.beforeAll(() => {
    mkdirSync(spaceRoot, { recursive: true })
    writeFileSync(join(spaceRoot, 'README.md'), '# sessions resume fixture\n', 'utf8')
    execFileSync('git', ['init', '-b', 'resume-work'], { cwd: spaceRoot, windowsHide: true })
    mkdirSync(noNativeSpaceRoot, { recursive: true })
    writeFileSync(join(noNativeSpaceRoot, 'README.md'), '# no native session fixture\n', 'utf8')
    execFileSync('git', ['init', '-b', 'no-native-work'], { cwd: noNativeSpaceRoot, windowsHide: true })
    mkdirSync(projectDir, { recursive: true })
    seedClaudeSession(projectDir, OLD_SESSION_ID, '2026-07-14T12:00:00.000Z', 'main-session', 'claude-opus-4-1')
    seedClaudeSession(projectDir, NEW_SESSION_ID, '2026-07-15T12:00:00.000Z', 'newer-session', 'claude-sonnet-4-5')
    seedClaudeSession(projectDir, UNSAFE_SESSION_ID, '2026-07-13T12:00:00.000Z', 'unsafe-session', 'claude-opus-4-1')
    process.env.CLAUDE_CONFIG_DIR = claudeConfigDir
    process.env.MORZ_E2E_SESSIONS_RESUME_STUB = '1'
    process.env.MORZ_E2E = '1'
    process.env.MORZ_E2E_PICK_FOLDER = spaceRoot
  })

  test.afterAll(async () => {
    if (morz) await closeMorz(morz.app)
    if (originalClaudeConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = originalClaudeConfigDir
    if (originalStub === undefined) delete process.env.MORZ_E2E_SESSIONS_RESUME_STUB
    else process.env.MORZ_E2E_SESSIONS_RESUME_STUB = originalStub
    if (originalPicker === undefined) delete process.env.MORZ_E2E_PICK_FOLDER
    else process.env.MORZ_E2E_PICK_FOLDER = originalPicker
    delete process.env.MORZ_E2E
    rmSync(fixtureParent, { recursive: true, force: true })
  })

  test('shows controls on every row, persists a morz pin, and resumes a linked morz session', async () => {
    morz = await launchMorz()
    let { page, appDataDir } = morz

    await page.getByRole('button', { name: 'Add space' }).click()
    await expect(page.locator(`[data-space-name="${basename(spaceRoot)}"]`)).toHaveAttribute('data-active', 'true')
    await page.getByRole('tab', { name: 'Sessions' }).click()

    const panel = page.getByRole('region', { name: 'Session history' })
    await expect(panel.getByText('unsafe-session', { exact: true })).toHaveCount(0)
    const records = panel.locator('[data-session-record]')
    await expect(records).toHaveCount(3)
    await expect(panel.getByRole('button', { name: /^(?:Pin|Unpin) / })).toHaveCount(3)
    await expect(panel.getByRole('button', { name: /^Resume / })).toHaveCount(3)

    const morzSession = panel.locator('[data-session-record]:not([data-session-record^="claude:"])').first()
    const morzSessionId = await morzSession.getAttribute('data-session-record')
    expect(morzSessionId).toBeTruthy()
    const morzResume = morzSession.getByRole('button', { name: 'Resume resume-work' })
    await expect(morzResume).toBeEnabled()

    const mainSession = panel.locator(`[data-session-record="claude:${OLD_SESSION_ID}"]`)
    await expect(mainSession.getByTestId('session-model')).toHaveText('claude-opus-4-1')

    await morzSession.getByRole('button', { name: 'Pin resume-work' }).click()
    await expect(panel.locator('[data-session-record]').first()).toHaveAttribute(
      'data-session-record',
      morzSessionId!
    )
    await expect(morzSession.getByRole('button', { name: 'Unpin resume-work' })).toHaveAttribute(
      'aria-pressed',
      'true'
    )

    await morzResume.click()
    await page.getByRole('tab', { name: 'Terminals' }).click()
    await expect(page.getByRole('region', { name: /Claude lane/ })).toHaveCount(1)

    const starts = await page.evaluate(async () => {
      const bridge = (window as unknown as {
        morzSessionsResumeTest?: {
          starts(): Promise<Array<{ cli: string; sessionId: string; cwd: string; agentId: string }>>
        }
      }).morzSessionsResumeTest
      return bridge?.starts() ?? []
    })
    expect(starts.at(-1)).toMatchObject({
      cli: 'claude',
      sessionId: NEW_SESSION_ID,
      cwd: spaceRoot
    })

    await closeMorz(morz.app)
    morz = undefined
    morz = await launchMorz({ appDataDir })
    page = morz.page
    await page.getByRole('tab', { name: 'Sessions' }).click()

    const relaunchedPanel = page.getByRole('region', { name: 'Session history' })
    await expect(relaunchedPanel.locator('[data-session-record]').first()).toHaveAttribute(
      'data-session-record',
      morzSessionId!
    )
    await expect(
      relaunchedPanel
        .locator(`[data-session-record="${morzSessionId}"]`)
        .getByRole('button', { name: 'Unpin resume-work' })
    ).toHaveAttribute('aria-pressed', 'true')

    await closeMorz(morz.app)
    morz = undefined
  })

  test('shows an honest disabled resume control when no native session exists', async () => {
    process.env.MORZ_E2E_PICK_FOLDER = noNativeSpaceRoot
    morz = await launchMorz()
    const { page } = morz

    await page.getByRole('button', { name: 'Add space' }).click()
    await expect(page.locator(`[data-space-name="${basename(noNativeSpaceRoot)}"]`)).toHaveAttribute('data-active', 'true')
    await page.getByRole('tab', { name: 'Sessions' }).click()

    const panel = page.getByRole('region', { name: 'Session history' })
    const morzSession = panel.locator('[data-session-record]:not([data-session-record^="claude:"])').first()
    await expect(morzSession.getByRole('button', { name: 'Pin no-native-work' })).toBeVisible()
    const resume = morzSession.getByRole('button', { name: 'Resume no-native-work' })
    await expect(resume).toBeVisible()
    await expect(resume).toBeDisabled()
    await expect(resume).toHaveAttribute('title', 'no native CLI session recorded')
  })
})
