import { expect, test } from '@playwright/test'
import { existsSync, readFileSync, rmSync } from 'fs'
import { join } from 'path'
import type { MemoryEntry, MemoryProposal, MorzMemoryApi } from '../src/shared/memory'
import { closeMorz, launchMorz, type MorzApp } from './app'

interface MemoryE2eApi extends MorzMemoryApi {
  testPropose(proposal: MemoryProposal): Promise<MemoryProposal>
  testRender(opts: { projectRoot?: string; spaceId?: string; agentId?: string }): Promise<string>
}

type MemoryWindow = { morz: { memory: MemoryE2eApi } }

test.describe.serial('Learning memory', () => {
  let morz: MorzApp

  test.beforeAll(async () => {
    process.env.MORZ_E2E = '1'
    morz = await launchMorz()
  })

  test.afterAll(async () => {
    delete process.env.MORZ_E2E
    if (morz) await closeMorz(morz.app)
  })

  test('persists, indexes, disables, and approves staged learning', async () => {
    const now = new Date().toISOString()
    const entry: MemoryEntry = {
      id: 'prefer-focused-tests',
      scope: 'global',
      kind: 'rule',
      title: 'Run focused tests before the full suite',
      body: 'Start with the narrowest relevant test, then run the full verification set.',
      origin: 'user',
      createdAt: now,
      updatedAt: now,
      enabled: true
    }

    const saved = await morz.page.evaluate(
      (value) => (window as unknown as MemoryWindow).morz.memory.save(value),
      entry
    )
    expect(saved.id).toBe(entry.id)

    const memoryFile = join(
      morz.appDataDir,
      'Morz',
      'memory',
      'global',
      `${entry.id}.md`
    )
    await expect.poll(() => existsSync(memoryFile)).toBe(true)
    const markdown = readFileSync(memoryFile, 'utf8')
    expect(markdown).toContain('---\n')
    expect(markdown).toContain('id: "prefer-focused-tests"')
    expect(markdown).toContain('kind: "rule"')
    expect(markdown).toContain(entry.body)

    const matches = await morz.page.evaluate(() =>
      (window as unknown as MemoryWindow).morz.memory.search('focused tests')
    )
    expect(matches.map((match) => match.id)).toContain(entry.id)

    const rendered = await morz.page.evaluate(() =>
      (window as unknown as MemoryWindow).morz.memory.testRender({})
    )
    expect(rendered).toContain('## How the user works')
    expect(rendered).toContain(entry.title)

    await morz.page.evaluate(
      (id) => (window as unknown as MemoryWindow).morz.memory.setEnabled(id, false),
      entry.id
    )
    const disabledRender = await morz.page.evaluate(() =>
      (window as unknown as MemoryWindow).morz.memory.testRender({})
    )
    expect(disabledRender).not.toContain(entry.title)

    const proposal: MemoryProposal = {
      id: 'proposal-prefer-pnpm',
      entry: {
        id: 'prefer-pnpm',
        scope: 'global',
        kind: 'rule',
        title: 'Use pnpm for JavaScript dependencies',
        body: 'Use pnpm unless the repository explicitly selects another package manager.',
        origin: 'learned',
        enabled: true
      },
      evidence: [
        'The user corrected npm to pnpm in the dashboard task.',
        'The user repeated the pnpm preference during setup.'
      ],
      ts: new Date().toISOString(),
      state: 'pending'
    }
    await morz.page.evaluate(
      (value) => (window as unknown as MemoryWindow).morz.memory.testPropose(value),
      proposal
    )

    // Markdown is the source of truth: deleting the disposable SQLite index
    // and relaunching must rebuild entries and retain pending proposals.
    const appDataDir = morz.appDataDir
    await closeMorz(morz.app)
    rmSync(join(appDataDir, 'Morz', 'morz.db'), { force: true })
    rmSync(join(appDataDir, 'Morz', 'morz.db-wal'), { force: true })
    rmSync(join(appDataDir, 'Morz', 'morz.db-shm'), { force: true })
    morz = await launchMorz({ appDataDir })
    const rebuiltMatches = await morz.page.evaluate(() =>
      (window as unknown as MemoryWindow).morz.memory.search('focused tests')
    )
    expect(rebuiltMatches.map((match) => match.id)).toContain(entry.id)
    const rebuiltRender = await morz.page.evaluate(() =>
      (window as unknown as MemoryWindow).morz.memory.testRender({})
    )
    expect(rebuiltRender).not.toContain(entry.title)
    const restoredProposal = await morz.page.evaluate(() =>
      (window as unknown as MemoryWindow).morz.memory.proposals()
    )
    expect(restoredProposal.find((item) => item.id === proposal.id)?.state).toBe('pending')
    await morz.page.getByRole('button', { name: 'Settings' }).click()
    await morz.page.getByRole('button', { name: 'Memory' }).click()

    const settings = morz.page.getByRole('region', { name: 'Learning memory' })
    await expect(settings.getByText('Pending proposals', { exact: true })).toBeVisible()
    await expect(settings.getByText(proposal.evidence[0], { exact: true })).toBeVisible()
    await settings.getByRole('button', { name: `Approve ${proposal.entry.title}` }).click()

    await expect.poll(async () => {
      const approved = await morz.page.evaluate(() =>
        (window as unknown as MemoryWindow).morz.memory.get('prefer-pnpm')
      )
      return approved?.origin ?? null
    }).toBe('learned')
    await expect.poll(async () => {
      const proposals = await morz.page.evaluate(() =>
        (window as unknown as MemoryWindow).morz.memory.proposals()
      )
      return proposals.find((item) => item.id === proposal.id)?.state ?? null
    }).toBe('approved')
    expect(existsSync(join(morz.appDataDir, 'Morz', 'memory', 'global', 'prefer-pnpm.md'))).toBe(true)
  })

  // w17/context-blocks — read-only is enforced in the store, not decorated in
  // the UI: every write path (save, enable toggle, delete) is refused, and
  // clearing the flag is the one write that gets through.
  test('a read-only fact refuses every write until it is unlocked', async () => {
    const now = '2026-07-27T12:00:00.000Z'
    const locked: MemoryEntry = {
      id: 'locked-house-rule',
      scope: 'global',
      kind: 'rule',
      title: 'Locked house rule',
      body: 'Imported from a file the user maintains by hand.',
      origin: 'user',
      createdAt: now,
      updatedAt: now,
      enabled: true,
      readOnly: true
    }
    await morz.page.evaluate(
      (value) => (window as unknown as MemoryWindow).morz.memory.save(value),
      locked
    )

    const refusals = await morz.page.evaluate(async (value: MemoryEntry) => {
      const memory = (window as unknown as MemoryWindow).morz.memory
      const attempt = async (run: () => Promise<unknown>): Promise<string> => {
        try {
          await run()
          return 'resolved'
        } catch (error) {
          return error instanceof Error ? error.message : String(error)
        }
      }
      return {
        edit: await attempt(() => memory.save({ ...value, title: 'Rewritten' })),
        disable: await attempt(() => memory.setEnabled(value.id, false)),
        remove: await attempt(() => memory.remove(value.id))
      }
    }, locked)
    for (const refusal of Object.values(refusals)) expect(refusal).toContain('read-only')

    const stored = await morz.page.evaluate(
      (id) => (window as unknown as MemoryWindow).morz.memory.get(id),
      locked.id
    )
    expect(stored?.title).toBe('Locked house rule')
    expect(stored?.enabled).toBe(true)

    await morz.page.evaluate(
      (value) => (window as unknown as MemoryWindow).morz.memory.save({ ...value, readOnly: false }),
      locked
    )
    await morz.page.evaluate(
      (value) => (window as unknown as MemoryWindow).morz.memory.save({ ...value, readOnly: false, title: 'Unlocked and edited' }),
      locked
    )
    const unlocked = await morz.page.evaluate(
      (id) => (window as unknown as MemoryWindow).morz.memory.get(id),
      locked.id
    )
    expect(unlocked?.title).toBe('Unlocked and edited')
    await morz.page.evaluate(
      (id) => (window as unknown as MemoryWindow).morz.memory.remove(id),
      locked.id
    )
  })
})
