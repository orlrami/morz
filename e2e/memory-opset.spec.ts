/*
 * w15/memory-opset — op-set reconciliation + bi-temporal soft-expiry.
 * Duplicate candidate → NOOP with no proposal card; contradiction → UPDATE
 * card carrying old→new; an applied DELETE keeps the row soft-expired and
 * restorable through the same IPC the MemorySettings Restore button uses.
 * Under MORZ_E2E the classifier is the deterministic heuristic (no LLM).
 */
import { expect, test } from '@playwright/test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type {
  MemoryEntry,
  MemoryOpAuditRow,
  MemoryProposal,
  MorzMemoryApi
} from '../src/shared/memory'
import { memoryRevision } from '../src/main/memory/apply'
import { closeMorz, launchMorz, type MorzApp } from './app'

interface MemoryE2eApi extends MorzMemoryApi {
  testPropose(proposal: MemoryProposal): Promise<MemoryProposal>
  testRender(opts: { projectRoot?: string; spaceId?: string; agentId?: string }): Promise<string>
  testReconcile(proposal: MemoryProposal): Promise<MemoryProposal>
  testAudit(): Promise<MemoryOpAuditRow[]>
}

type MemoryWindow = { morz: { memory: MemoryE2eApi } }

function proposal(
  id: string,
  entry: Partial<MemoryProposal['entry']> & { id: string; title: string; body: string }
): MemoryProposal {
  return {
    id,
    entry: {
      scope: 'global',
      kind: 'rule',
      origin: 'learned',
      enabled: true,
      ...entry
    },
    evidence: ['Observed in the dashboard task.'],
    ts: new Date().toISOString(),
    state: 'pending'
  }
}

test.describe.serial('Memory op-set reconciliation', () => {
  let morz: MorzApp
  let appDataDir: string

  test.beforeAll(async () => {
    process.env.MORZ_E2E = '1'
    appDataDir = mkdtempSync(join(tmpdir(), 'morz-memory-supersession-'))
    const memoryDir = join(appDataDir, 'Morz', 'memory', 'global')
    mkdirSync(memoryDir, { recursive: true })
    // d374a68-era fixture: no supersedesId/supersededBy fields. Startup must
    // load and index it without a rewrite or migration warning.
    writeFileSync(join(memoryDir, 'prefer-pnpm.md'), [
      '---',
      'id: "prefer-pnpm"',
      'scope: "global"',
      'kind: "rule"',
      'title: "Use pnpm for JavaScript dependencies"',
      'origin: "user"',
      'createdAt: "2026-07-01T00:00:00.000Z"',
      'updatedAt: "2026-07-01T00:00:00.000Z"',
      'enabled: true',
      '---',
      'Use pnpm unless the repository selects another package manager.'
    ].join('\n'), 'utf8')
    morz = await launchMorz({ appDataDir })
  })

  test.afterAll(async () => {
    delete process.env.MORZ_E2E
    if (morz) await closeMorz(morz.app)
    if (appDataDir) rmSync(appDataDir, { recursive: true, force: true })
  })

  test('duplicate candidate reconciles to NOOP with no proposal card', async () => {
    const before = await morz.page.evaluate(() =>
      (window as unknown as MemoryWindow).morz.memory.proposals()
    )

    const result = await morz.page.evaluate(
      (value) => (window as unknown as MemoryWindow).morz.memory.testReconcile(value),
      proposal('op-dup', {
        id: 'learned-dup',
        title: '  use PNPM for JavaScript   dependencies ',
        body: 'Use pnpm unless the repository selects another package manager.'
      })
    )
    expect(result.op?.kind).toBe('noop')
    expect(result.op?.targetId).toBe('prefer-pnpm')
    expect(result.state).toBe('rejected')

    const after = await morz.page.evaluate(() =>
      (window as unknown as MemoryWindow).morz.memory.proposals()
    )
    expect(after.length).toBe(before.length) // no card staged
    expect(after.some((item) => item.id === 'op-dup')).toBe(false)
  })

  test('contradiction stages an UPDATE card with old→new and applies as soft-expiry', async () => {
    const staged = await morz.page.evaluate(
      (value) => (window as unknown as MemoryWindow).morz.memory.testReconcile(value),
      proposal('op-contradiction', {
        id: 'learned-bun',
        title: 'Use pnpm for JavaScript dependencies',
        body: 'Correction: the user has switched every repository to bun.'
      })
    )
    expect(staged.state).toBe('pending')
    expect(staged.op?.kind).toBe('update')
    expect(staged.op?.targetId).toBe('prefer-pnpm')
    expect(staged.op?.old?.body).toContain('Use pnpm unless')
    expect(staged.op?.next?.body).toContain('switched every repository to bun')

    const approved = await morz.page.evaluate(
      (id) => (window as unknown as MemoryWindow).morz.memory.resolveProposal(id, true),
      staged.id
    )
    expect(approved.state).toBe('approved')

    // The live fact keeps its clean id. The old revision moves to a derived id
    // and both rows link to one another.
    const entries = await morz.page.evaluate(() =>
      (window as unknown as MemoryWindow).morz.memory.list()
    )
    const old = entries.find((entry) => entry.supersededBy === 'learned-bun')
    expect(old?.expiredAt).toBeTruthy()
    expect(old?.invalidAt).toBeTruthy()
    expect(old?.id).toMatch(/^prefer-pnpm-rev-[a-f0-9]{64}$/)
    const next = await morz.page.evaluate(
      (id) => (window as unknown as MemoryWindow).morz.memory.get(id),
      'learned-bun'
    )
    expect(next?.expiredAt).toBeFalsy()
    expect(next?.supersedesId).toBe(old?.id)
    const restoreError = await morz.page.evaluate(async (id) => {
      try {
        await (window as unknown as MemoryWindow).morz.memory.restore(id)
        return null
      } catch (error) {
        return error instanceof Error ? error.message : String(error)
      }
    }, old!.id)
    expect(restoreError).toContain('Cannot restore memory while its successor is active')

    await morz.page.getByRole('button', { name: 'Settings' }).click()
    await morz.page.getByRole('button', { name: 'Memory' }).click()
    const settings = morz.page.getByRole('region', { name: 'Learning memory' })
    await expect(settings.getByText(
      new RegExp(`Replaced #${old?.id} on \\d{4}-\\d{2}-\\d{2}`)
    )).toBeVisible()

    // Search never surfaces expired rows. Superseded facts stay queryable by
    // id (asserted above) but never enter a prompt — w17/renderer-core law.
    const matches = await morz.page.evaluate(() =>
      (window as unknown as MemoryWindow).morz.memory.search('pnpm dependencies')
    )
    expect(matches.map((match) => match.id)).not.toContain('prefer-pnpm')
    const rendered = await morz.page.evaluate(() =>
      (window as unknown as MemoryWindow).morz.memory.testRender({})
    )
    expect(rendered).not.toMatch(/superseded/i)
    expect(rendered).not.toMatch(/used until/)
    // Only the live successor renders, not the expired row it replaced.
    const bullets = rendered
      .split('\n')
      .filter((line) => line.includes('Use pnpm for JavaScript dependencies'))
    expect(bullets).toHaveLength(1)

    // Every applied op lands in the SQLite audit table.
    const audit = await morz.page.evaluate(() =>
      (window as unknown as MemoryWindow).morz.memory.testAudit()
    )
    const updateRow = audit.find((row) => row.op === 'update')
    expect(updateRow?.targetId).toBe('prefer-pnpm')
    expect(updateRow?.oldTitle).toBe('Use pnpm for JavaScript dependencies')
    expect(updateRow?.newBody).toContain('bun')
  })

  test('second concurrent approval stays pending and shows the re-propose error', async () => {
    const now = new Date().toISOString()
    await morz.page.evaluate(
      (value) => (window as unknown as MemoryWindow).morz.memory.save(value),
      {
        id: 'format-biome',
        scope: 'global',
        kind: 'rule',
        title: 'Format TypeScript with Biome',
        body: 'Run Biome with the repository defaults.',
        origin: 'user',
        createdAt: now,
        updatedAt: now,
        enabled: true
      } satisfies MemoryEntry
    )
    const [proposalA, proposalB] = await Promise.all([
      morz.page.evaluate(
        (value) => (window as unknown as MemoryWindow).morz.memory.testReconcile(value),
        proposal('op-format-a', {
          id: 'format-biome-a',
          title: 'Format TypeScript with Biome',
          body: 'Run Biome and apply the shared strict preset.'
        })
      ),
      morz.page.evaluate(
        (value) => (window as unknown as MemoryWindow).morz.memory.testReconcile(value),
        proposal('op-format-b', {
          id: 'format-biome-b',
          title: 'Format TypeScript with Biome',
          body: 'Run Biome but keep the relaxed preset.'
        })
      )
    ])
    expect(proposalA.op?.targetRevision).toBeTruthy()
    expect(proposalB.op?.targetRevision).toBe(proposalA.op?.targetRevision)

    await morz.page.evaluate(
      (id) => (window as unknown as MemoryWindow).morz.memory.resolveProposal(id, true),
      proposalA.id
    )

    const settings = morz.page.getByRole('region', { name: 'Learning memory' })
    await settings.getByRole('button', { name: `Approve ${proposalB.entry.title}` }).click()
    await expect(settings.getByRole('alert')).toContainText(
      'Memory changed since this was proposed — re-propose.'
    )
    const stillPending = await morz.page.evaluate(
      (id) => (window as unknown as MemoryWindow).morz.memory.proposals()
        .then((items) => items.find((item) => item.id === id)?.state),
      proposalB.id
    )
    expect(stillPending).toBe('pending')
  })

  test('manual save and delete use pre-approved reconciliation with audit', async () => {
    const now = new Date().toISOString()
    const original: MemoryEntry = {
      id: 'manual-format-rule',
      scope: 'global',
      kind: 'rule',
      title: 'Format TypeScript before commit',
      body: 'Run the repository formatter.',
      origin: 'user',
      createdAt: now,
      updatedAt: now,
      enabled: true
    }
    await morz.page.evaluate(
      (value) => (window as unknown as MemoryWindow).morz.memory.save(value),
      original
    )
    const beforeProposals = await morz.page.evaluate(() =>
      (window as unknown as MemoryWindow).morz.memory.proposals()
    )
    const successor = await morz.page.evaluate(
      (value) => (window as unknown as MemoryWindow).morz.memory.save(value),
      { ...original, body: 'Run Biome before every commit.' }
    )
    expect(successor.id).toBe(original.id)
    expect(successor.supersedesId).toMatch(/^manual-format-rule-rev-[a-f0-9]{64}$/)
    const afterProposals = await morz.page.evaluate(() =>
      (window as unknown as MemoryWindow).morz.memory.proposals()
    )
    expect(afterProposals.filter((item) => item.state === 'pending')).toHaveLength(
      beforeProposals.filter((item) => item.state === 'pending').length
    )
    expect(afterProposals.some((item) =>
      item.id.startsWith('manual-') && item.state === 'approved')).toBe(true)

    await morz.page.evaluate(
      (id) => (window as unknown as MemoryWindow).morz.memory.remove(id),
      successor.id
    )
    const removed = await morz.page.evaluate(
      (id) => (window as unknown as MemoryWindow).morz.memory.get(id),
      successor.id
    )
    expect(removed?.expiredAt).toBeTruthy()
    const audit = await morz.page.evaluate(() =>
      (window as unknown as MemoryWindow).morz.memory.testAudit()
    )
    expect(audit.some((row) => row.op === 'update' && row.memoryId === original.id)).toBe(true)
    expect(audit.some((row) => row.op === 'delete' && row.memoryId === original.id)).toBe(true)
  })

  test('applied DELETE keeps the row expired and restorable', async () => {
    // Every UPDATE/DELETE op carries the target's revision hash: the approval
    // CAS rejects revision-less proposals and asks for a re-propose.
    const target = await morz.page.evaluate(
      (id) => (window as unknown as MemoryWindow).morz.memory.get(id),
      'learned-bun'
    )
    expect(target).toBeTruthy()
    const staged = await morz.page.evaluate(
      (value) => (window as unknown as MemoryWindow).morz.memory.testPropose(value),
      {
        ...proposal('op-delete', {
          id: 'learned-drop-bun',
          title: 'Drop the bun rule',
          body: 'The user reverted the bun migration.'
        }),
        op: {
          kind: 'delete' as const,
          targetId: 'learned-bun',
          targetRevision: memoryRevision(target!),
          old: { title: target!.title, body: target!.body },
          reason: 'Reverted by the user'
        }
      }
    )
    await morz.page.evaluate(
      (id) => (window as unknown as MemoryWindow).morz.memory.resolveProposal(id, true),
      staged.id
    )

    const expired = await morz.page.evaluate(
      (id) => (window as unknown as MemoryWindow).morz.memory.get(id),
      'learned-bun'
    )
    expect(expired?.expiredAt).toBeTruthy() // kept, not deleted

    const audit = await morz.page.evaluate(() =>
      (window as unknown as MemoryWindow).morz.memory.testAudit()
    )
    expect(audit.some((row) => row.op === 'delete' && row.targetId === 'learned-bun')).toBe(true)

    // Restore = the MemorySettings Restore button's IPC.
    const restored = await morz.page.evaluate(
      (id) => (window as unknown as MemoryWindow).morz.memory.restore(id),
      'learned-bun'
    )
    expect(restored.expiredAt).toBeFalsy()
    expect(restored.invalidAt).toBeFalsy()

    const auditAfter = await morz.page.evaluate(() =>
      (window as unknown as MemoryWindow).morz.memory.testAudit()
    )
    expect(auditAfter.some((row) => row.op === 'restore' && row.memoryId === 'learned-bun')).toBe(true)
  })
})
