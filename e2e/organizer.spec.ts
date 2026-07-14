import { expect, test } from '@playwright/test'
import { execFileSync } from 'child_process'
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { closeMorz, launchMorz, ROOT } from './app'

interface OrganizerOperation {
  kind: 'move' | 'create'
  from?: string
  to: string
  content?: string
  inverse: { kind: 'move' | 'delete'; from?: string; to: string }
}

interface OrganizerPlan {
  root: string
  operations: OrganizerOperation[]
  beforeTree: string[]
  afterTree: string[]
  planHash: string
}

interface ApplyResult {
  runTag: string
  branch: string
  commit: string
  worktreePath: string
  journalPath: string
  diff: string
}

const templateRoot = join(ROOT, 'e2e', 'fixtures', 'messy-repo')

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim()
}

test('Organizer audits, proposes, explains, and applies only in a sandbox worktree', async () => {
  const fixtureRoot = join(ROOT, 'e2e', '.tmp', `organizer-${Date.now()}`)
  const filteredRoot = `${fixtureRoot}-filtered`
  mkdirSync(fixtureRoot, { recursive: true })
  cpSync(templateRoot, fixtureRoot, { recursive: true })
  git(fixtureRoot, 'init', '-b', 'main')
  git(fixtureRoot, 'config', 'user.name', 'Morz Organizer Test')
  git(fixtureRoot, 'config', 'user.email', 'organizer-test@morz.invalid')
  git(fixtureRoot, 'add', '-A')
  git(fixtureRoot, 'commit', '-m', 'test: add messy fixture')
  const liveHead = git(fixtureRoot, 'rev-parse', 'HEAD')
  const liveBranch = git(fixtureRoot, 'branch', '--show-current')
  const hookPath = join(fixtureRoot, '.git', 'hooks', 'pre-commit')
  writeFileSync(hookPath, '#!/bin/sh\ntouch HOOK_RAN\n', 'utf8')
  chmodSync(hookPath, 0o755)
  writeFileSync(join(fixtureRoot, '.git', 'info', 'exclude'), 'ignored-local.txt\n', 'utf8')
  writeFileSync(join(fixtureRoot, 'ignored-local.txt'), 'live-only ignored state\n', 'utf8')

  const { app, page } = await launchMorz()
  const appliedWorktrees: ApplyResult[] = []

  try {
    await expect(page.evaluate(() => {
      const morz = (window as unknown as { morz: { organizer: { audit(root: string): Promise<unknown> } } }).morz
      return morz.organizer.audit('.')
    })).rejects.toThrow(/absolute/i)

    const violations = await page.evaluate((root) => {
      const morz = (window as unknown as { morz: { organizer: { audit(root: string): Promise<Array<{ rule: string; path: string; detail: string; cite: string }>> } } }).morz
      return morz.organizer.audit(root)
    }, fixtureRoot)
    const rules = new Set(violations.map((violation) => violation.rule))

    for (const expectedRule of [
      'required-file/readme',
      'required-file/gitignore',
      'naming/kebab-case',
      'docs/diataxis',
      'adr/madr-log',
      'dependencies/no-cycles',
      'boundaries/main-to-renderer',
      'dependencies/version-drift'
    ]) expect(rules.has(expectedRule)).toBe(true)
    expect(rules.has('required-file/license')).toBe(false)
    expect(violations.every((violation) => violation.cite.startsWith('https://'))).toBe(true)

    const explanation = await page.evaluate(() => {
      const morz = (window as unknown as { morz: { organizer: { explain(ruleId: string): Promise<{ rule: string; explanation: string; cite: string }> } } }).morz
      return morz.organizer.explain('adr/madr-log')
    })
    expect(explanation.explanation.length).toBeGreaterThan(80)
    expect(explanation.cite).toContain('adr.github.io/madr')

    const importerPath = join(fixtureRoot, 'src', 'uses-imported.ts')
    writeFileSync(importerPath, "export const usedValue = 'temporarily dirty'\n", 'utf8')
    const plan = await page.evaluate((root) => {
      const morz = (window as unknown as { morz: { organizer: { propose(root: string): Promise<OrganizerPlan> } } }).morz
      return morz.organizer.propose(root)
    }, fixtureRoot)
    // restore via git so the worktree byte-matches the index EXACTLY — a
    // writeFileSync round-trip can differ in EOL from what the index holds
    // (checkout normalization) and busts git's stat cache into reporting M.
    git(fixtureRoot, 'checkout', '--', 'src/uses-imported.ts')
    expect(plan.planHash).toMatch(/^[a-f0-9]{64}$/)
    expect(plan.operations.length).toBeGreaterThan(0)
    expect(plan.operations.every((operation) => operation.inverse)).toBe(true)
    expect(plan.beforeTree).toContain('src/Bad_Name.ts')
    expect(plan.afterTree).toContain('src/bad-name.ts')
    expect(plan.beforeTree).toContain('src/Pascal.ts')
    expect(plan.afterTree).toContain('src/pascal.ts')
    expect(plan.beforeTree).toContain('src/Imported_Bad.ts')
    expect(plan.afterTree).toContain('src/Imported_Bad.ts')
    expect(plan.afterTree).not.toContain('src/imported-bad.ts')

    await expect(page.evaluate(({ root, hash }) => {
      const morz = (window as unknown as { morz: { organizer: { apply(root: string, planHash: string): Promise<ApplyResult> } } }).morz
      return morz.organizer.apply(root, hash)
    }, { root: fixtureRoot, hash: '0'.repeat(64) })).rejects.toThrow(/hash/i)

    const concurrentResults = await page.evaluate(async ({ root, hash }) => {
      const morz = (window as unknown as { morz: { organizer: { apply(root: string, planHash: string): Promise<ApplyResult> } } }).morz
      const results = await Promise.allSettled([
        morz.organizer.apply(root, hash),
        morz.organizer.apply(root, hash)
      ])
      return results.map((result) => result.status === 'fulfilled'
        ? { status: result.status, value: result.value }
        : { status: result.status, reason: String(result.reason) })
    }, { root: fixtureRoot, hash: plan.planHash })
    const fulfilled = concurrentResults.filter((result) => result.status === 'fulfilled')
    for (const result of fulfilled) appliedWorktrees.push(result.value as ApplyResult)
    expect(fulfilled, JSON.stringify(concurrentResults, null, 2)).toHaveLength(1)
    expect(concurrentResults.filter((result) => result.status === 'rejected')).toHaveLength(1)
    const applied = appliedWorktrees[0]

    expect(applied.runTag).toMatch(/^organizer-/)
    expect(applied.branch).toContain(applied.runTag)
    expect(applied.commit).toMatch(/^[a-f0-9]{40}$/)
    expect(applied.worktreePath).not.toBe(fixtureRoot)
    expect(existsSync(join(applied.worktreePath, 'src', 'bad-name.ts'))).toBe(true)
    expect(existsSync(join(applied.worktreePath, 'src', 'Bad_Name.ts'))).toBe(false)
    expect(existsSync(join(applied.worktreePath, 'src', 'pascal.ts'))).toBe(true)
    expect(existsSync(join(applied.worktreePath, 'README.md'))).toBe(true)
    expect(existsSync(join(fixtureRoot, 'src', 'Bad_Name.ts'))).toBe(true)
    expect(existsSync(join(fixtureRoot, 'src', 'bad-name.ts'))).toBe(false)
    expect(existsSync(join(fixtureRoot, 'ignored-local.txt'))).toBe(true)
    expect(existsSync(join(applied.worktreePath, 'ignored-local.txt'))).toBe(false)
    expect(applied.diff).toContain('src/Bad_Name.ts')
    expect(applied.diff).toContain('README.md')
    expect(existsSync(join(applied.worktreePath, 'HOOK_RAN'))).toBe(false)
    expect(existsSync(join(fixtureRoot, 'HOOK_RAN'))).toBe(false)
    expect(git(fixtureRoot, 'rev-parse', 'HEAD')).toBe(liveHead)
    expect(git(fixtureRoot, 'branch', '--show-current')).toBe(liveBranch)
    expect(git(fixtureRoot, 'status', '--porcelain')).toBe('')
    expect(git(applied.worktreePath, 'rev-parse', 'HEAD^')).toBe(liveHead)
    expect(git(applied.worktreePath, 'status', '--porcelain')).toBe('')
    expect(existsSync(applied.journalPath)).toBe(true)
    expect(JSON.parse(readFileSync(applied.journalPath, 'utf8')).status).toBe('committed')

    await expect(page.evaluate(({ root, hash }) => {
      const morz = (window as unknown as { morz: { organizer: { apply(root: string, planHash: string): Promise<ApplyResult> } } }).morz
      return morz.organizer.apply(root, hash)
    }, { root: fixtureRoot, hash: plan.planHash })).rejects.toThrow(/proposal/i)

    mkdirSync(filteredRoot, { recursive: true })
    cpSync(templateRoot, filteredRoot, { recursive: true })
    git(filteredRoot, 'init', '-b', 'main')
    git(filteredRoot, 'config', 'user.name', 'Morz Organizer Test')
    git(filteredRoot, 'config', 'user.email', 'organizer-test@morz.invalid')
    git(filteredRoot, 'add', '-A')
    git(filteredRoot, 'commit', '-m', 'test: add messy fixture')
    writeFileSync(join(filteredRoot, '.gitattributes'), '*.ts filter=evil\n', 'utf8')
    git(filteredRoot, 'add', '.gitattributes')
    git(filteredRoot, 'commit', '-m', 'test: add an untrusted checkout filter')
    git(filteredRoot, 'config', 'filter.evil.clean', 'touch FILTER_RAN; cat')
    git(filteredRoot, 'config', 'filter.evil.smudge', 'touch FILTER_RAN; cat')
    const filteredPlan = await page.evaluate((root) => {
      const morz = (window as unknown as { morz: { organizer: { propose(root: string): Promise<OrganizerPlan> } } }).morz
      return morz.organizer.propose(root)
    }, filteredRoot)
    await expect(page.evaluate(({ root, hash }) => {
      const morz = (window as unknown as { morz: { organizer: { apply(root: string, planHash: string): Promise<ApplyResult> } } }).morz
      return morz.organizer.apply(root, hash)
    }, { root: filteredRoot, hash: filteredPlan.planHash })).rejects.toThrow(/Git filters/i)
    expect(existsSync(join(filteredRoot, 'FILTER_RAN'))).toBe(false)
    expect(git(filteredRoot, 'branch', '--format=%(refname:short)')).toBe('main')
  } finally {
    await closeMorz(app)
    for (const applied of appliedWorktrees) {
      if (!existsSync(applied.worktreePath)) continue
      git(fixtureRoot, 'worktree', 'remove', '--force', applied.worktreePath)
      git(fixtureRoot, 'branch', '-D', applied.branch)
    }
    rmSync(fixtureRoot, { recursive: true, force: true })
    rmSync(filteredRoot, { recursive: true, force: true })
  }
})
