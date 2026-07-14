import { expect, test } from '@playwright/test'
import { execFileSync } from 'child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { closeMorz, launchMorz } from './app'

interface CommitLogEntry {
  sha: string
  shortSha: string
  author: string
  date: string
  subject: string
}

interface CommitBridge {
  fileDiff(root: string, path: string): Promise<{ path: string; staged: string; unstaged: string }>
  stageFile(root: string, path: string): Promise<void>
  unstageFile(root: string, path: string): Promise<void>
  stageHunk(root: string, patch: string): Promise<void>
  discardFile(root: string, path: string, confirmed: boolean): Promise<void>
  stagedDiff(root: string): Promise<string>
  commit(root: string, message: string): Promise<{ sha: string }>
  log(root: string): Promise<CommitLogEntry[]>
  suggestMessage(root: string): Promise<string>
}

function firstHunkPatch(diff: string): string {
  const lines = diff.split('\n')
  const firstHunk = lines.findIndex((line) => line.startsWith('@@'))
  const secondHunk = lines.findIndex((line, index) => index > firstHunk && line.startsWith('@@'))
  if (firstHunk < 0 || secondHunk < 0) throw new Error('Fixture did not produce two hunks')
  return `${lines.slice(0, secondHunk).join('\n')}\n`
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim()
}

test('stages only the selected file, runs hooks, commits it, and requires discard confirmation', async () => {
  const root = mkdtempSync(join(tmpdir(), 'morz-commit-'))
  git(root, 'init', '-b', 'main')
  git(root, 'config', 'user.name', 'Morz Commit Test')
  git(root, 'config', 'user.email', 'commit-test@morz.invalid')
  writeFileSync(join(root, 'alpha.txt'), 'alpha v1\n', 'utf8')
  writeFileSync(join(root, 'beta.txt'), 'beta v1\n', 'utf8')
  git(root, 'add', 'alpha.txt', 'beta.txt')
  git(root, 'commit', '-m', 'test: seed fixture')

  writeFileSync(join(root, 'alpha.txt'), 'alpha v2\n', 'utf8')
  writeFileSync(join(root, 'beta.txt'), 'beta v2\n', 'utf8')
  const hookPath = join(root, '.git', 'hooks', 'pre-commit')
  writeFileSync(hookPath, '#!/bin/sh\ntouch HOOK_RAN\n', 'utf8')
  chmodSync(hookPath, 0o755)

  const { app, page } = await launchMorz()
  try {
    await expect(
      page.evaluate(
        ({ repo }) =>
          (window as unknown as { morzCommit: CommitBridge }).morzCommit.stageFile(
            repo,
            '../outside.txt'
          ),
        { repo: root }
      )
    ).rejects.toThrow(/space root|escapes/i)

    await page.evaluate(
      ({ repo }) =>
        (window as unknown as { morzCommit: CommitBridge }).morzCommit.stageFile(repo, 'alpha.txt'),
      { repo: root }
    )

    const staged = await page.evaluate(
      ({ repo }) =>
        (window as unknown as { morzCommit: CommitBridge }).morzCommit.stagedDiff(repo),
      { repo: root }
    )
    expect(staged).toContain('alpha.txt')
    expect(staged).toContain('alpha v2')
    expect(staged).not.toContain('beta.txt')
    expect(staged).not.toContain('beta v2')

    await expect(
      page.evaluate(
        ({ repo }) =>
          (window as unknown as { morzCommit: CommitBridge }).morzCommit.discardFile(
            repo,
            'beta.txt',
            false
          ),
        { repo: root }
      )
    ).rejects.toThrow(/confirm/i)
    expect(readFileSync(join(root, 'beta.txt'), 'utf8')).toBe('beta v2\n')

    await page.evaluate(
      ({ repo }) =>
        (window as unknown as { morzCommit: CommitBridge }).morzCommit.discardFile(
          repo,
          'beta.txt',
          true
        ),
      { repo: root }
    )
    expect(readFileSync(join(root, 'beta.txt'), 'utf8').replace(/\r\n/g, '\n')).toBe('beta v1\n')

    const committed = await page.evaluate(
      ({ repo }) =>
        (window as unknown as { morzCommit: CommitBridge }).morzCommit.commit(
          repo,
          'feat: commit selected file'
        ),
      { repo: root }
    )
    expect(committed.sha).toMatch(/^[a-f0-9]{40}$/)
    expect(existsSync(join(root, 'HOOK_RAN'))).toBe(true)

    const log = await page.evaluate(
      ({ repo }) => (window as unknown as { morzCommit: CommitBridge }).morzCommit.log(repo),
      { repo: root }
    )
    expect(log[0].sha).toBe(committed.sha)
    expect(log[0].subject).toBe('feat: commit selected file')
    expect(git(root, 'status', '--porcelain')).toBe('?? HOOK_RAN')
  } finally {
    await closeMorz(app)
    rmSync(root, { recursive: true, force: true })
  }
})

test('suggests an editable conventional message from only the staged diff', async () => {
  test.skip(process.platform !== 'win32', 'Morz is Windows-first and resolves the claude.cmd shim')
  const root = mkdtempSync(join(tmpdir(), 'morz-commit-ai-'))
  const bin = join(root, 'bin')
  const capturedPrompt = join(root, 'claude-prompt.txt')
  git(root, 'init', '-b', 'main')
  git(root, 'config', 'user.name', 'Morz Commit Test')
  git(root, 'config', 'user.email', 'commit-test@morz.invalid')
  writeFileSync(join(root, 'staged.txt'), 'staged v1\n', 'utf8')
  writeFileSync(join(root, 'unstaged.txt'), 'unstaged v1\n', 'utf8')
  git(root, 'add', 'staged.txt', 'unstaged.txt')
  git(root, 'commit', '-m', 'test: seed AI fixture')
  writeFileSync(join(root, 'staged.txt'), 'staged v2\n', 'utf8')
  writeFileSync(join(root, 'unstaged.txt'), 'unstaged v2\n', 'utf8')
  git(root, 'add', 'staged.txt')
  mkdirSync(bin)
  writeFileSync(
    join(bin, 'claude.cmd'),
    '@echo off\r\nmore > "%MORZ_CLAUDE_INPUT%"\r\necho feat: suggest staged change\r\n',
    'utf8'
  )

  const oldPath = process.env.PATH
  const oldCapture = process.env.MORZ_CLAUDE_INPUT
  process.env.PATH = `${bin};${oldPath ?? ''}`
  process.env.MORZ_CLAUDE_INPUT = capturedPrompt
  const { app, page } = await launchMorz()
  try {
    const suggestion = await page.evaluate(
      ({ repo }) =>
        (window as unknown as { morzCommit: CommitBridge }).morzCommit.suggestMessage(repo),
      { repo: root }
    )
    expect(suggestion).toBe('feat: suggest staged change')
    const prompt = readFileSync(capturedPrompt, 'utf8')
    expect(prompt).toContain('staged.txt')
    expect(prompt).toContain('staged v2')
    expect(prompt).not.toContain('unstaged.txt')
    expect(git(root, 'log', '-1', '--pretty=%s')).toBe('test: seed AI fixture')
  } finally {
    await closeMorz(app)
    process.env.PATH = oldPath
    if (oldCapture === undefined) delete process.env.MORZ_CLAUDE_INPUT
    else process.env.MORZ_CLAUDE_INPUT = oldCapture
    rmSync(root, { recursive: true, force: true })
  }
})

test('returns staged and unstaged file diffs and stages one supplied hunk patch', async () => {
  const root = mkdtempSync(join(tmpdir(), 'morz-commit-hunk-'))
  git(root, 'init', '-b', 'main')
  git(root, 'config', 'user.name', 'Morz Commit Test')
  git(root, 'config', 'user.email', 'commit-test@morz.invalid')
  const original = Array.from({ length: 30 }, (_, index) => `line ${index + 1}`)
  writeFileSync(join(root, 'hunks.txt'), `${original.join('\n')}\n`, 'utf8')
  git(root, 'add', 'hunks.txt')
  git(root, 'commit', '-m', 'test: seed hunk fixture')
  const modified = [...original]
  modified[1] = 'first hunk changed'
  modified[24] = 'second hunk changed'
  writeFileSync(join(root, 'hunks.txt'), `${modified.join('\n')}\n`, 'utf8')

  const { app, page } = await launchMorz()
  try {
    const initial = await page.evaluate(
      ({ repo }) =>
        (window as unknown as { morzCommit: CommitBridge }).morzCommit.fileDiff(repo, 'hunks.txt'),
      { repo: root }
    )
    expect(initial.staged).toBe('')
    expect(initial.unstaged).toContain('first hunk changed')
    expect(initial.unstaged).toContain('second hunk changed')

    await page.evaluate(
      ({ repo }) =>
        (window as unknown as { morzCommit: CommitBridge }).morzCommit.stageFile(repo, 'hunks.txt'),
      { repo: root }
    )
    await page.evaluate(
      ({ repo }) =>
        (window as unknown as { morzCommit: CommitBridge }).morzCommit.unstageFile(repo, 'hunks.txt'),
      { repo: root }
    )
    expect(
      await page.evaluate(
        ({ repo }) =>
          (window as unknown as { morzCommit: CommitBridge }).morzCommit.stagedDiff(repo),
        { repo: root }
      )
    ).toBe('')

    const patch = firstHunkPatch(initial.unstaged)
    await page.evaluate(
      ({ repo, hunk }) =>
        (window as unknown as { morzCommit: CommitBridge }).morzCommit.stageHunk(repo, hunk),
      { repo: root, hunk: patch }
    )
    const split = await page.evaluate(
      ({ repo }) =>
        (window as unknown as { morzCommit: CommitBridge }).morzCommit.fileDiff(repo, 'hunks.txt'),
      { repo: root }
    )
    expect(split.staged).toContain('first hunk changed')
    expect(split.staged).not.toContain('second hunk changed')
    expect(split.unstaged).not.toContain('first hunk changed')
    expect(split.unstaged).toContain('second hunk changed')

    await page.evaluate(({ repo }) => {
      localStorage.setItem(
        'morz.spaces',
        JSON.stringify({
          state: { spaces: [{ id: 'fixture', name: 'fixture', root: repo, agents: [] }] },
          version: 1
        })
      )
      localStorage.setItem('morz.mode', JSON.stringify({ state: { mode: 'manual' }, version: 1 }))
    }, { repo: root })
    await page.reload()
    await page.getByRole('tab', { name: 'Commit' }).click()
    await expect(page.getByRole('button', { name: 'Stage hunks.txt', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Suggest message' })).toHaveCount(0)

    await page.getByRole('button', { name: 'Stage hunks.txt', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Unstage hunks.txt' })).toBeVisible()
    await page.getByLabel('Commit message').fill('feat: commit from panel')
    await page.getByRole('button', { name: 'Commit', exact: true }).click()
    await expect.poll(() => git(root, 'log', '-1', '--pretty=%s')).toBe('feat: commit from panel')

    await page.evaluate(() => {
      localStorage.setItem('morz.mode', JSON.stringify({ state: { mode: 'assisted' }, version: 1 }))
    })
    await page.reload()
    await page.getByRole('tab', { name: 'Commit' }).click()
    await expect(page.getByRole('button', { name: 'Suggest message' })).toBeVisible()
  } finally {
    await closeMorz(app)
    rmSync(root, { recursive: true, force: true })
  }
})

test('supports staging in a repository before its first commit', async () => {
  const root = mkdtempSync(join(tmpdir(), 'morz-commit-unborn-'))
  git(root, 'init', '-b', 'main')
  git(root, 'config', 'user.name', 'Morz Commit Test')
  git(root, 'config', 'user.email', 'commit-test@morz.invalid')
  writeFileSync(join(root, 'first.txt'), 'first version\n', 'utf8')

  const { app, page } = await launchMorz()
  try {
    const log = await page.evaluate(
      ({ repo }) => (window as unknown as { morzCommit: CommitBridge }).morzCommit.log(repo),
      { repo: root }
    )
    expect(log).toEqual([])
    await page.evaluate(
      ({ repo }) =>
        (window as unknown as { morzCommit: CommitBridge }).morzCommit.stageFile(repo, 'first.txt'),
      { repo: root }
    )
    expect(
      await page.evaluate(
        ({ repo }) =>
          (window as unknown as { morzCommit: CommitBridge }).morzCommit.stagedDiff(repo),
        { repo: root }
      )
    ).toContain('first.txt')
  } finally {
    await closeMorz(app)
    rmSync(root, { recursive: true, force: true })
  }
})
