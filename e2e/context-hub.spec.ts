import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { closeMorz, installCollector, launchMorz } from './app'

test.describe.serial('context hub', () => {
  let app: ElectronApplication
  let page: Page
  let firstRoot: string
  let secondRoot: string

  test.beforeAll(async () => {
    process.env.MORZ_E2E = '1'
    process.env.MORZ_E2E_CONTEXT_ENABLED = '1'
    // w16 — no MORZ_E2E_CONTEXT_ROOTS allowlist: spaces seeded straight into
    // localStorage (legacy spaces, never picker-authorized) must scan fine.
    firstRoot = mkdtempSync(join(tmpdir(), 'morz-context-first-'))
    secondRoot = mkdtempSync(join(tmpdir(), 'morz-context-second-'))
    writeFileSync(join(firstRoot, 'package.json'), '{"name":"first"}\n')
    writeFileSync(join(secondRoot, 'CLAUDE.md'), '# Second fixture\n')

    const morz = await launchMorz()
    app = morz.app
    page = morz.page
    await page.evaluate(
      ({ first, second }) => {
        localStorage.setItem('morz.spaces', JSON.stringify({
          state: {
            spaces: [
              { id: 'first', name: 'First fixture', root: first, agents: [] },
              { id: 'second', name: 'Second fixture', root: second, agents: [] }
            ],
            activeSpaceId: 'first',
            initialized: true
          },
          version: 2
        }))
      },
      { first: firstRoot, second: secondRoot }
    )
    await page.reload()
    await page.waitForLoadState('domcontentloaded')
    await installCollector(page)
    await page.getByRole('tab', { name: 'Context' }).click()
    await expect(page.getByTestId('context-matrix')).toBeVisible()
  })

  test.afterAll(async () => {
    if (app) await closeMorz(app)
    rmSync(firstRoot, { recursive: true, force: true })
    rmSync(secondRoot, { recursive: true, force: true })
    delete process.env.MORZ_E2E_CONTEXT_ENABLED
    delete process.env.MORZ_E2E
  })

  test('missing CLAUDE.md creates a Node template only after diff approval', async () => {
    const cell = page.getByTestId('context-cell-first-claude')
    await expect(cell).toContainText('Missing')
    await cell.getByRole('button', { name: 'Create CLAUDE.md from template' }).click()

    const dialog = page.getByTestId('context-diff-dialog')
    await expect(dialog).toContainText('npm run typecheck')
    expect(() => readFileSync(join(firstRoot, 'CLAUDE.md'), 'utf8')).toThrow()
    await dialog.getByRole('button', { name: 'Apply 1 selected' }).click()
    await expect(dialog).toBeHidden()

    await expect(cell).toContainText('Present')
    expect(readFileSync(join(firstRoot, 'CLAUDE.md'), 'utf8')).toContain('First fixture context')
  })

  test('shared block targeting two spaces presents two individual diffs', async () => {
    await page.getByRole('button', { name: 'Shared block' }).click()
    await page.getByLabel('Block name').fill('quality-gate')
    await page.getByLabel('Block content').fill('## Quality gate\n\nRun targeted tests before shipping.')
    await page.getByRole('button', { name: 'Review 2 block diffs' }).click()

    const dialog = page.getByTestId('context-diff-dialog')
    await expect(dialog.getByTestId('context-proposal-row')).toHaveCount(2)
    await expect(dialog).toContainText('First fixture')
    await expect(dialog).toContainText('Second fixture')
    await dialog.getByRole('button', { name: 'Apply 2 selected' }).click()
    await expect(dialog).toBeHidden()

    expect(readFileSync(join(firstRoot, 'CLAUDE.md'), 'utf8')).toContain('morz:block:quality-gate')
    expect(readFileSync(join(secondRoot, 'CLAUDE.md'), 'utf8')).toContain('morz:block:quality-gate')
  })

  test('a later conflict preserves only unapplied proposal rows for recovery', async () => {
    await page.getByRole('button', { name: 'Shared block' }).click()
    await page.getByLabel('Block name').fill('conflict-recovery')
    await page.getByLabel('Block content').fill('## Conflict recovery')
    await page.getByRole('button', { name: 'Review 2 block diffs' }).click()

    const dialog = page.getByTestId('context-diff-dialog')
    appendFileSync(join(secondRoot, 'CLAUDE.md'), '\nUser edit during review.\n')
    await dialog.getByRole('button', { name: 'Apply 2 selected' }).click()

    await expect(dialog).toContainText('1 file applied')
    await expect(dialog.getByTestId('context-proposal-row')).toHaveCount(1)
    await expect(dialog).toContainText('Second fixture')
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(dialog).toBeHidden()
  })

  test('memory refresh re-proposes one idempotent managed block', async () => {
    await page.evaluate(async () => {
      const now = '2026-07-24T12:00:00.000Z'
      await window.morz.memory!.save({
        id: 'focused-tests',
        scope: 'global',
        kind: 'rule',
        title: 'Prefer focused tests',
        body: 'Run the narrow test before the broad verification gate.',
        origin: 'user',
        createdAt: now,
        updatedAt: now,
        enabled: true
      })
    })

    await page.getByRole('button', { name: 'Export memory' }).click()
    await page.getByLabel('Include Second fixture').uncheck()
    await page.getByRole('button', { name: 'Review 1 memory diff' }).click()
    const firstDialog = page.getByTestId('context-diff-dialog')
    await firstDialog.getByRole('button', { name: 'Apply 1 selected' }).click()
    await expect(firstDialog).toBeHidden()

    await page.evaluate(async () => {
      const existing = await window.morz.memory!.get('focused-tests')
      if (!existing) throw new Error('memory fixture missing')
      await window.morz.memory!.save({
        ...existing,
        title: 'Prefer focused tests before broad verification',
        updatedAt: '2026-07-24T13:00:00.000Z'
      })
    })
    await page.getByRole('button', { name: 'Export memory' }).click()
    await page.getByLabel('Include Second fixture').uncheck()
    await page.getByRole('button', { name: 'Review 1 memory diff' }).click()
    const dialog = page.getByTestId('context-diff-dialog')
    await expect(dialog).toContainText('Prefer focused tests before broad verification')
    await dialog.getByRole('button', { name: 'Apply 1 selected' }).click()
    await expect(dialog).toBeHidden()

    const content = readFileSync(join(firstRoot, 'CLAUDE.md'), 'utf8')
    expect(content.match(/<!-- morz:memory -->/g)).toHaveLength(1)
    expect(content.match(/<!-- \/morz:memory -->/g)).toHaveLength(1)
    expect(content).toContain('Prefer focused tests before broad verification')
  })

  test('scan rejects roots that fail path hygiene', async () => {
    // The picker-only allowlist is gone; scans are guarded by structural
    // validation instead. Relative and nonexistent roots must still throw.
    const results = await page.evaluate(async (existing) => {
      const scanError = async (root: string): Promise<string> => {
        try {
          await window.morz.contextHub!.scan([{ id: 'forged', name: 'Forged', root }])
          return 'resolved'
        } catch (error) {
          return error instanceof Error ? error.message : String(error)
        }
      }
      return {
        relative: await scanError('relative/path'),
        nonexistent: await scanError(`${existing}\\does-not-exist-w16`)
      }
    }, firstRoot)
    expect(results.relative).toContain('absolute')
    expect(results.nonexistent).toContain('does not exist')
  })

  test('disabled module sends zero scan IPC', async () => {
    await closeMorz(app)
    process.env.MORZ_E2E_CONTEXT_ENABLED = '0'
    // w15/modules-core — the registry gates the module; seed it off here.
    const disabled = await launchMorz({ env: { MORZ_MODULES: 'sessions' } })
    app = disabled.app
    page = disabled.page

    await expect(page.getByRole('tab', { name: 'Context' })).toHaveCount(0)
    const directScan = await page.evaluate(async (root) => {
      try {
        await window.morz.contextHub!.scan([
          { id: 'forged-disabled', name: 'Forged disabled', root }
        ])
        return 'resolved'
      } catch (error) {
        return error instanceof Error ? error.message : String(error)
      }
    }, firstRoot)
    expect(directScan).toContain('Context module is disabled')
    const scans = await page.evaluate(async () => window.morz.contextHub?.testStats?.())
    expect(scans).toEqual({ scans: 0 })
  })
})
