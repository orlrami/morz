import { expect, test } from '@playwright/test'
import { execFileSync } from 'child_process'
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { closeMorz, launchMorz, ROOT } from './app'

const templateRoot = join(ROOT, 'e2e', 'fixtures', 'messy-repo')

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim()
}

test('Organizer audits, proposes, and applies a plan through the UI', async () => {
  const fixtureRoot = join(ROOT, 'e2e', '.tmp', `organizer-ui-${Date.now()}`)
  mkdirSync(fixtureRoot, { recursive: true })
  cpSync(templateRoot, fixtureRoot, { recursive: true })
  git(fixtureRoot, 'init', '-b', 'main')
  git(fixtureRoot, 'config', 'user.name', 'Morz Organizer UI Test')
  git(fixtureRoot, 'config', 'user.email', 'organizer-ui-test@morz.invalid')
  git(fixtureRoot, 'add', '-A')
  git(fixtureRoot, 'commit', '-m', 'test: add messy fixture')

  const { app, page } = await launchMorz()
  let sandboxPath = ''
  let sandboxBranch = ''

  try {
    await page.getByRole('tab', { name: 'Organizer' }).click()
    const organizer = page.getByRole('region', { name: 'Organizer' })
    await expect(organizer).toBeVisible()

    await organizer.getByRole('textbox', { name: 'Repository root' }).fill(fixtureRoot)
    await organizer.getByRole('button', { name: 'Audit repository' }).click()
    await expect(organizer.getByText('naming/kebab-case', { exact: true }).first()).toBeVisible()
    await expect(organizer.getByText('src/Bad_Name.ts', { exact: true })).toBeVisible()

    await organizer.getByRole('button', { name: 'naming/kebab-case' }).first().click()
    await expect(organizer.getByText(/source filenames should use a single predictable/i)).toBeVisible()

    const badNamePath = join(fixtureRoot, 'src', 'Bad_Name.ts')
    await organizer.getByRole('button', { name: 'src/Bad_Name.ts' }).click()
    await expect(page.getByTitle(badNamePath).first()).toBeVisible()
    await page.getByTitle('Close editor').click()

    await organizer.getByRole('button', { name: 'Propose plan' }).click()
    await expect(organizer.getByRole('heading', { name: /^Before tree/ })).toBeVisible()
    await expect(organizer.getByRole('heading', { name: /^After tree/ })).toBeVisible()
    await expect(organizer.getByTestId('organizer-plan-hash')).toHaveText(/^[a-f0-9]{64}$/)
    await expect(organizer.getByRole('listitem', { name: 'src/bad-name.ts', exact: true })).toBeVisible()

    await organizer.getByRole('button', { name: 'Apply plan in sandbox' }).click()
    const worktree = organizer.getByTestId('organizer-worktree-path')
    await expect(worktree).toBeVisible()
    sandboxPath = (await worktree.textContent())?.trim() ?? ''
    sandboxBranch = (await organizer.getByTestId('organizer-worktree-branch').textContent())?.trim() ?? ''
    await expect(worktree).not.toHaveText(fixtureRoot)
    await expect(organizer.getByText(/live tree remains unchanged/i)).toBeVisible()

    expect(sandboxPath).not.toBe('')
    expect(existsSync(sandboxPath)).toBe(true)
  } finally {
    await closeMorz(app)
    if (sandboxPath && existsSync(sandboxPath)) {
      git(fixtureRoot, 'worktree', 'remove', '--force', sandboxPath)
    }
    if (sandboxBranch) git(fixtureRoot, 'branch', '-D', sandboxBranch)
    rmSync(fixtureRoot, { recursive: true, force: true })
  }
})

test('Organizer locks its root while an audit is running', async () => {
  const { app, page } = await launchMorz()
  try {
    await app.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('organizer:audit')
      ipcMain.handle('organizer:audit', async () => {
        await new Promise((resolve) => setTimeout(resolve, 750))
        return []
      })
    })

    await page.getByRole('tab', { name: 'Organizer' }).click()
    const organizer = page.getByRole('region', { name: 'Organizer' })
    const root = organizer.getByRole('textbox', { name: 'Repository root' })
    await root.fill('C:\\delayed-repository')
    await organizer.getByRole('button', { name: 'Audit repository' }).click()
    await expect(root).toBeDisabled()
    await expect(root).toBeEnabled()
  } finally {
    await closeMorz(app)
  }
})

test('Organizer does not apply a plan with no automatic operations', async () => {
  const fixtureRoot = join(ROOT, 'e2e', '.tmp', `organizer-ui-clean-${Date.now()}`)
  mkdirSync(join(fixtureRoot, 'docs', 'decisions'), { recursive: true })
  mkdirSync(join(fixtureRoot, '.morz'), { recursive: true })
  for (const [path, content] of [
    ['README.md', '# Clean fixture\n'],
    ['LICENSE', 'Test license\n'],
    ['.gitignore', 'node_modules/\n'],
    ['docs/decisions/README.md', '# Decisions\n'],
    ['.morz/organizer.config', '{"stack":"none","rules":{"docs/diataxis":false}}\n']
  ]) writeFileSync(join(fixtureRoot, path), content, 'utf8')
  git(fixtureRoot, 'init', '-b', 'main')
  git(fixtureRoot, 'config', 'user.name', 'Morz Organizer UI Test')
  git(fixtureRoot, 'config', 'user.email', 'organizer-ui-test@morz.invalid')
  git(fixtureRoot, 'add', '-A')
  git(fixtureRoot, 'commit', '-m', 'test: add clean fixture')

  const { app, page } = await launchMorz()
  try {
    await page.getByRole('tab', { name: 'Organizer' }).click()
    const organizer = page.getByRole('region', { name: 'Organizer' })
    await organizer.getByRole('textbox', { name: 'Repository root' }).fill(fixtureRoot)
    await organizer.getByRole('button', { name: 'Audit repository' }).click()
    await expect(organizer.getByText(/no enabled Organizer rules/i)).toBeVisible()
    await organizer.getByRole('button', { name: 'Propose plan' }).click()
    await expect(organizer.getByTestId('organizer-plan-hash')).toHaveText(/^[a-f0-9]{64}$/)
    await expect(organizer.getByText(/no automatically applicable operations/i)).toBeVisible()
    await expect(organizer.getByRole('button', { name: 'Apply plan in sandbox' })).toBeDisabled()
  } finally {
    await closeMorz(app)
    rmSync(fixtureRoot, { recursive: true, force: true })
  }
})
