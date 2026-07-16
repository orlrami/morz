import { expect, test } from '@playwright/test'
import { execFileSync } from 'child_process'
import { randomBytes } from 'crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { closeMorz, launchMorz } from './app'

interface CommitHistoryEntry {
  sha: string
  shortSha: string
  subject: string
  diff: string
}

interface CommitFileHistory {
  path: string
  firstSeenCommit: string | null
  firstSeenDate: string | null
  firstSeenSubject: string | null
  branch: string | null
  commits: Array<{ sha: string; subject: string }>
}

interface CommitBranchDiff {
  branch: string | null
  baseBranch: string | null
  diff: string
  commits: Array<{ sha: string; subject: string }>
}

interface CommitAiBridge {
  commitLog(root: string): Promise<CommitHistoryEntry[]>
  fileHistory(root: string, path: string): Promise<CommitFileHistory>
  branchDiffVsBase(root: string): Promise<CommitBranchDiff>
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim()
}

function createFixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'morz-commit-ai-history-'))
  git(root, 'init', '-b', 'main')
  git(root, 'config', 'user.name', 'Morz Commit AI Test')
  git(root, 'config', 'user.email', 'commit-ai-test@morz.invalid')
  writeFileSync(join(root, 'README.md'), '# fixture\n', 'utf8')
  git(root, 'add', 'README.md')
  git(root, 'commit', '-m', 'chore: seed repository')
  git(root, 'switch', '-c', 'feature/commit-story')
  writeFileSync(
    join(root, 'launch.png'),
    Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex')
  )
  writeFileSync(join(root, 'story.txt'), 'first version\n', 'utf8')
  git(root, 'add', 'launch.png', 'story.txt')
  git(root, 'commit', '-m', 'feat: add launch artwork')
  writeFileSync(join(root, 'story.txt'), 'first version\npolished copy\n', 'utf8')
  git(root, 'add', 'story.txt')
  git(root, 'commit', '-m', 'fix: polish launch copy')
  return root
}

async function openCommitPage(page: Awaited<ReturnType<typeof launchMorz>>['page'], root: string): Promise<void> {
  await page.evaluate(({ repo }) => {
    localStorage.setItem(
      'morz.spaces',
      JSON.stringify({
        state: { spaces: [{ id: 'commit-ai-fixture', name: 'commit-ai-fixture', root: repo, agents: [] }] },
        version: 1
      })
    )
  }, { repo: root })
  await page.reload()
  await page.getByRole('tab', { name: 'Commit', exact: true }).click()
}

test('renders commit history and returns commit, file, and branch context', async () => {
  const root = createFixture()
  const { app, page } = await launchMorz()
  try {
    const result = await page.evaluate(async ({ repo }) => {
      const bridge = (window as unknown as { morzCommitAi: CommitAiBridge }).morzCommitAi
      return {
        log: await bridge.commitLog(repo),
        file: await bridge.fileHistory(repo, 'launch.png'),
        branch: await bridge.branchDiffVsBase(repo)
      }
    }, { repo: root })

    expect(result.log[0]?.subject).toBe('fix: polish launch copy')
    expect(result.log[0]?.diff).toContain('polished copy')
    expect(result.file.path).toBe('launch.png')
    expect(result.file.firstSeenCommit).toMatch(/^[a-f0-9]{40}$/)
    expect(result.file.firstSeenDate).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(result.file.firstSeenSubject).toBe('feat: add launch artwork')
    expect(result.file.branch).toBe('feature/commit-story')
    expect(result.file.commits[0]?.subject).toBe('feat: add launch artwork')
    expect(result.branch.branch).toBe('feature/commit-story')
    expect(result.branch.baseBranch).toBe('main')
    expect(result.branch.diff).toContain('launch.png')
    expect(result.branch.commits.map((entry) => entry.subject)).toEqual([
      'fix: polish launch copy',
      'feat: add launch artwork'
    ])

    await openCommitPage(page, root)
    await expect(page.getByRole('button', { name: /fix: polish launch copy/ })).toBeVisible()
    await expect(page.getByRole('button', { name: /feat: add launch artwork/ })).toBeVisible()

    writeFileSync(join(root, 'large-branch.bin'), randomBytes(9 * 1024 * 1024))
    git(root, 'add', 'large-branch.bin')
    git(root, 'commit', '-m', 'feat: add large branch artifact')
    const largeBranch = await page.evaluate(
      ({ repo }) =>
        (window as unknown as { morzCommitAi: CommitAiBridge }).morzCommitAi.branchDiffVsBase(repo),
      { repo: root }
    )
    expect(largeBranch.diff).toContain('[diff truncated at 256 KB]')
  } finally {
    await closeMorz(app)
    rmSync(root, { recursive: true, force: true })
  }
})

test('shows the fixed report summary when the E2E report engine is configured', async () => {
  const root = createFixture()
  writeFileSync(
    join(root, 'launch.png'),
    Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), randomBytes(600 * 1024)])
  )
  writeFileSync(join(root, 'story.txt'), 'first version\npolished copy\nworking change\n', 'utf8')
  const oldE2e = process.env.MORZ_E2E
  process.env.MORZ_E2E = '1'
  const { app, page } = await launchMorz()
  try {
    await openCommitPage(page, root)
    await page.getByRole('button', { name: /fix: polish launch copy/ }).click()
    await expect(page.getByTestId('commit-ai-summary')).toContainText('MORZ_E2E report summary (commit)')
    await page.getByRole('button', { name: 'Explain this change' }).click()
    await expect(page.getByTestId('commit-ai-summary')).toContainText('MORZ_E2E report summary (file)')
    await page.getByTitle('story.txt', { exact: true }).click()
    await page.getByRole('button', { name: 'Explain this change' }).click()
    await expect(page.getByTestId('commit-ai-summary')).toContainText('MORZ_E2E report summary (file)')
    await page.getByRole('button', { name: 'Summarize branch' }).click()
    await expect(page.getByTestId('commit-ai-summary')).toContainText('MORZ_E2E report summary (branch)')
  } finally {
    await closeMorz(app)
    if (oldE2e === undefined) delete process.env.MORZ_E2E
    else process.env.MORZ_E2E = oldE2e
    rmSync(root, { recursive: true, force: true })
  }
})

test('shows the engine connection hint without blocking staging', async () => {
  const root = createFixture()
  writeFileSync(join(root, 'story.txt'), 'first version\npolished copy\nworking change\n', 'utf8')
  const oldE2e = process.env.MORZ_E2E
  const oldDisabled = process.env.MORZ_E2E_COMMIT_AI_NO_REPORT
  process.env.MORZ_E2E = '1'
  process.env.MORZ_E2E_COMMIT_AI_NO_REPORT = '1'
  const { app, page } = await launchMorz()
  try {
    await openCommitPage(page, root)
    // report-engine now ships integrated + defaults to claude-cli (configured),
    // so the old MORZ_E2E_COMMIT_AI_NO_REPORT flag no longer forces the hint.
    // Force an unconfigured engine (key-based provider, no key) → configured=false.
    await page.evaluate(async () => {
      const report = (
        window as unknown as { morz?: { report?: { setProvider(p: string): Promise<unknown> } } }
      ).morz?.report
      if (report) await report.setProvider('openai')
    })
    await page.getByRole('button', { name: /fix: polish launch copy/ }).click()
    await expect(page.getByTestId('commit-ai-summary')).toContainText(
      'Connect an AI report engine in Settings'
    )
    await page.getByRole('button', { name: 'Stage story.txt', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Unstage story.txt', exact: true })).toBeVisible()
    expect(git(root, 'diff', '--cached', '--name-only')).toBe('story.txt')
  } finally {
    await closeMorz(app)
    if (oldE2e === undefined) delete process.env.MORZ_E2E
    else process.env.MORZ_E2E = oldE2e
    if (oldDisabled === undefined) delete process.env.MORZ_E2E_COMMIT_AI_NO_REPORT
    else process.env.MORZ_E2E_COMMIT_AI_NO_REPORT = oldDisabled
    rmSync(root, { recursive: true, force: true })
  }
})
