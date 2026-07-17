import { expect, test } from '@playwright/test'
import { execFileSync } from 'child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { closeMorz, launchMorz } from './app'

interface CommitBranchDiff {
  commits: Array<{ sha: string; subject: string }>
}

interface CommitAiBridge {
  branchDiffVsBase(root: string): Promise<CommitBranchDiff>
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim()
}

async function openCommitFixture(
  page: Awaited<ReturnType<typeof launchMorz>>['page'],
  root: string
): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await page.evaluate(({ repo }) => {
      localStorage.setItem(
        'morz.spaces',
        JSON.stringify({
          state: {
            spaces: [{ id: 'commit-fix-fixture', name: 'commit-fix-fixture', root: repo, agents: [] }],
            activeSpaceId: 'commit-fix-fixture',
            initialized: true
          },
          version: 2
        })
      )
      localStorage.setItem('morz.mode', JSON.stringify({ state: { mode: 'manual' }, version: 1 }))
    }, { repo: root })
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.getByRole('tab', { name: 'Commit', exact: true }).click()
    try {
      await expect(page.getByRole('button', { name: 'Stage tracked.txt', exact: true })).toBeVisible({
        timeout: 5_000
      })
      return
    } catch {
      // The persisted space store may finish one last write during reload; reseed deterministically.
    }
  }
  throw new Error('Failed to activate the commit fixture repository')
}

test('committing refreshes history and reports the created commit honestly', async () => {
  const root = mkdtempSync(join(tmpdir(), 'morz-commit-fix-'))
  git(root, 'init', '-b', 'main')
  git(root, 'config', 'user.name', 'Morz Commit Fix Test')
  git(root, 'config', 'user.email', 'commit-fix-test@morz.invalid')
  writeFileSync(join(root, 'tracked.txt'), 'seed\n', 'utf8')
  git(root, 'add', 'tracked.txt')
  git(root, 'commit', '-m', 'test: seed commit fixture')
  writeFileSync(join(root, 'tracked.txt'), 'seed\ncommitted from the panel\n', 'utf8')

  const { app, page } = await launchMorz()
  try {
    await openCommitFixture(page, root)
    await page.getByRole('button', { name: 'Stage tracked.txt', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Unstage tracked.txt', exact: true })).toBeVisible()
    await page.getByLabel('Commit message').fill('fix: refresh commit history')
    await page.getByRole('button', { name: 'Commit', exact: true }).click()

    await expect.poll(() => git(root, 'log', '-1', '--pretty=%s')).toBe('fix: refresh commit history')
    const sha = git(root, 'rev-parse', 'HEAD')
    const shortSha = git(root, 'rev-parse', '--short', 'HEAD')

    await expect(
      page.getByRole('button', { name: `Explain commit ${shortSha}: fix: refresh commit history` })
    ).toBeVisible()

    const branch = await page.evaluate(
      ({ repo }) =>
        (window as unknown as { morzCommitAi: CommitAiBridge }).morzCommitAi.branchDiffVsBase(repo),
      { repo: root }
    )
    expect(branch.commits[0]?.sha).toBe(sha)

    await expect(page.getByRole('status')).toHaveText(`Committed ${shortSha}`)
    await expect(page.getByRole('region', { name: 'Commit' })).not.toContainText('(no commits found)')

    const notices = await page.evaluate(() => window.morz.notify?.list())
    expect(notices?.some((notice) => notice.title === `Committed ${shortSha}`)).toBe(true)
  } finally {
    await closeMorz(app)
    rmSync(root, { recursive: true, force: true })
  }
})
