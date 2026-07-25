/*
 * w15/memory-opset — op-set reconciliation + bi-temporal soft-expiry.
 * Duplicate candidate → NOOP with no proposal card; contradiction → UPDATE
 * card carrying old→new; an applied DELETE keeps the row soft-expired and
 * restorable through the same IPC the MemorySettings Restore button uses.
 * Under MORZ_E2E the classifier is the deterministic heuristic (no LLM).
 */
import { expect, test } from '@playwright/test'
import type {
  MemoryEntry,
  MemoryOpAuditRow,
  MemoryProposal,
  MorzMemoryApi
} from '../src/shared/memory'
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

  test.beforeAll(async () => {
    process.env.MORZ_E2E = '1'
    morz = await launchMorz()

    const now = new Date().toISOString()
    const seed: MemoryEntry = {
      id: 'prefer-pnpm',
      scope: 'global',
      kind: 'rule',
      title: 'Use pnpm for JavaScript dependencies',
      body: 'Use pnpm unless the repository selects another package manager.',
      origin: 'user',
      createdAt: now,
      updatedAt: now,
      enabled: true
    }
    await morz.page.evaluate(
      (value) => (window as unknown as MemoryWindow).morz.memory.save(value),
      seed
    )
  })

  test.afterAll(async () => {
    delete process.env.MORZ_E2E
    if (morz) await closeMorz(morz.app)
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

    // The superseded row is kept (soft-expired), the successor is active.
    const old = await morz.page.evaluate(
      (id) => (window as unknown as MemoryWindow).morz.memory.get(id),
      'prefer-pnpm'
    )
    expect(old?.expiredAt).toBeTruthy()
    expect(old?.invalidAt).toBeTruthy()
    const next = await morz.page.evaluate(
      (id) => (window as unknown as MemoryWindow).morz.memory.get(id),
      'learned-bun'
    )
    expect(next?.expiredAt).toBeFalsy()

    // Search never surfaces expired rows; injection renders a validity window.
    const matches = await morz.page.evaluate(() =>
      (window as unknown as MemoryWindow).morz.memory.search('pnpm dependencies')
    )
    expect(matches.map((match) => match.id)).not.toContain('prefer-pnpm')
    const rendered = await morz.page.evaluate(() =>
      (window as unknown as MemoryWindow).morz.memory.testRender({})
    )
    expect(rendered).toMatch(/superseded rule:.*used until \d{4}-\d{2}-\d{2}/)

    // Every applied op lands in the SQLite audit table.
    const audit = await morz.page.evaluate(() =>
      (window as unknown as MemoryWindow).morz.memory.testAudit()
    )
    const updateRow = audit.find((row) => row.op === 'update')
    expect(updateRow?.targetId).toBe('prefer-pnpm')
    expect(updateRow?.oldTitle).toBe('Use pnpm for JavaScript dependencies')
    expect(updateRow?.newBody).toContain('bun')
  })

  test('applied DELETE keeps the row expired and restorable', async () => {
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
          old: {
            title: 'Use pnpm for JavaScript dependencies',
            body: 'Correction: the user has switched every repository to bun.'
          },
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
