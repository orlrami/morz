import { expect, test } from '@playwright/test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { MemoryEntry, MorzMemoryApi } from '../src/shared/memory'
import { closeMorz, launchMorz, type MorzApp } from './app'

type MemoryWindow = { morz: { memory: MorzMemoryApi } }

test.describe.serial('Memory bootstrap', () => {
  let morz: MorzApp
  let fixtureHome: string
  let sourceFile: string

  test.beforeAll(async () => {
    fixtureHome = mkdtempSync(join(tmpdir(), 'morz-memory-bootstrap-'))
    const claudeRoot = join(fixtureHome, '.claude')
    const projectMemory = join(claudeRoot, 'projects', 'fixture', 'memory')
    mkdirSync(projectMemory, { recursive: true })
    sourceFile = join(claudeRoot, 'CLAUDE.md')
    writeFileSync(
      sourceFile,
      '# Package manager\nUse pnpm for JavaScript projects.\n\n# Tests\nRun focused tests before the full suite.\n',
      'utf8'
    )
    writeFileSync(
      join(projectMemory, 'reviews.md'),
      '# Reviews\nUse a non-author reviewer before merging.\n',
      'utf8'
    )
    process.env.MORZ_E2E = '1'
    morz = await launchMorz({
      env: {
        MORZ_MEMORY_BOOTSTRAP_HOME: fixtureHome,
        MORZ_MEMORY_BOOTSTRAP_GLOBAL_ONLY: '1'
      }
    })
    await morz.page.getByRole('button', { name: 'Settings', exact: true }).click()
    await morz.page.getByRole('button', { name: 'Memory', exact: true }).click()
  })

  test.afterAll(async () => {
    delete process.env.MORZ_E2E
    if (morz) await closeMorz(morz.app)
    if (fixtureHome) rmSync(fixtureHome, { recursive: true, force: true })
  })

  test('reviews once, imports only selected entries, and reruns as NOOP', async () => {
    await morz.page.getByRole('button', { name: 'Build memory from my files…' }).click()
    const review = morz.page.getByRole('region', { name: 'Memory bootstrap review' })
    await expect(review).toBeVisible()
    await expect(review.getByTestId('memory-bootstrap-counts')).toContainText(
      '2 files scanned, 3 candidates, 3 new / 0 updates / 0 skipped'
    )
    await expect(review.getByText(sourceFile, { exact: true })).toBeVisible()

    const beforeApply = await morz.page.evaluate(() =>
      (window as unknown as MemoryWindow).morz.memory.list('global')
    )
    expect(beforeApply).toEqual([])
    const pendingBeforeApply = await morz.page.evaluate(() =>
      (window as unknown as MemoryWindow).morz.memory.proposals()
    )
    expect(pendingBeforeApply).toEqual([])

    await review.getByRole('button', { name: 'Select none' }).click()
    await review.getByRole('checkbox', { name: 'Select Package manager' }).check()
    await review.getByRole('button', { name: 'Apply 1 selected' }).click()
    await expect(morz.page.getByRole('status')).toContainText('1 imported.')

    const imported = await morz.page.evaluate(() =>
      (window as unknown as MemoryWindow).morz.memory.list('global')
    ) as MemoryEntry[]
    expect(imported).toHaveLength(1)
    expect(imported[0].title).toBe('Package manager')
    expect(imported[0].source).toBe(`${sourceFile}#Package manager`)

    const storedPath = join(morz.appDataDir, 'Morz', 'memory', 'global', `${imported[0].id}.md`)
    expect(existsSync(storedPath)).toBe(true)
    expect(readFileSync(storedPath, 'utf8')).toContain(
      `source: ${JSON.stringify(`${sourceFile}#Package manager`)}`
    )

    await morz.page.getByRole('button', { name: 'Build memory from my files…' }).click()
    const rerun = morz.page.getByRole('region', { name: 'Memory bootstrap review' })
    await expect(rerun.getByTestId('memory-bootstrap-counts')).toContainText(
      '2 files scanned, 3 candidates, 2 new / 0 updates / 1 skipped'
    )
    await expect(rerun.getByRole('checkbox', { name: 'Select Package manager' })).toBeDisabled()
  })
})
