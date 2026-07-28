import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { MemoryEntry, MemoryOpAuditRow, MemoryProposal } from '../../shared/memory'
import {
  ensureMemoryDirectories,
  readEntryDocuments,
  writeEntryDocuments
} from './documents'
import {
  applyApprovedMemoryProposal,
  assertMemoryProposalCurrent,
  assertRestoreAllowed,
  memoryRevision,
  type MemoryApplyAuditInput,
  type MemoryApplyDeps,
  type MemoryApplyFailpoint,
  type MemoryChainSnapshot
} from './apply'

function chainOf(
  entries: Iterable<MemoryEntry>,
  auditSuccessors: Record<string, string[]> = {}
): MemoryChainSnapshot {
  return {
    entries: new Map([...entries].map((value) => [value.id, value])),
    auditSuccessors: new Map(Object.entries(auditSuccessors))
  }
}

const NOW = '2026-07-28T12:00:00.000Z'

function entry(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    id: 'prefer-pnpm',
    scope: 'global',
    kind: 'rule',
    title: 'Use pnpm',
    body: 'Use pnpm for JavaScript dependencies.',
    origin: 'user',
    createdAt: '2026-07-01T12:00:00.000Z',
    updatedAt: '2026-07-01T12:00:00.000Z',
    enabled: true,
    ...overrides
  }
}

function updateProposal(
  target: MemoryEntry,
  overrides: Partial<MemoryProposal> = {}
): MemoryProposal {
  return {
    id: 'proposal-switch-package-manager',
    entry: {
      id: target.id,
      scope: target.scope,
      scopeRef: target.scopeRef,
      kind: target.kind,
      title: 'Use bun',
      body: 'Use bun for JavaScript dependencies.',
      origin: 'learned',
      enabled: true
    },
    evidence: ['The user corrected the package manager.'],
    ts: NOW,
    state: 'approved',
    op: {
      kind: 'update',
      targetId: target.id,
      targetRevision: memoryRevision(target),
      old: { title: target.title, body: target.body },
      next: { title: 'Use bun', body: 'Use bun for JavaScript dependencies.' }
    },
    ...overrides
  }
}

/** An UPDATE whose successor takes a NEW id, so the target's document is removed. */
function renameProposal(target: MemoryEntry, id: string, title: string): MemoryProposal {
  return {
    id: `proposal-${id}`,
    entry: {
      id,
      scope: target.scope,
      scopeRef: target.scopeRef,
      kind: target.kind,
      title,
      body: `${title} for JavaScript dependencies.`,
      origin: 'learned',
      enabled: true
    },
    evidence: ['The user corrected the package manager.'],
    ts: NOW,
    state: 'approved',
    op: {
      kind: 'update',
      targetId: target.id,
      targetRevision: memoryRevision(target),
      old: { title: target.title, body: target.body },
      next: { title, body: `${title} for JavaScript dependencies.` }
    }
  }
}

class ApplyHarness {
  readonly documents = new Map<string, MemoryEntry>()
  readonly index = new Map<string, MemoryEntry>()
  readonly audit = new Map<string, MemoryApplyAuditInput>()
  applied = false
  private tripped = false

  constructor(
    seed: MemoryEntry,
    private readonly failAt?: MemoryApplyFailpoint
  ) {
    this.documents.set(seed.id, structuredClone(seed))
    this.index.set(seed.id, structuredClone(seed))
  }

  deps(isRetry = false): MemoryApplyDeps {
    return {
      isRetry,
      getMemory: (id) => {
        const found = this.documents.get(id)
        return found ? structuredClone(found) : null
      },
      writeEntries: (entries, removeIds) => {
        for (const id of removeIds) this.documents.delete(id)
        for (const value of entries) this.documents.set(value.id, structuredClone(value))
      },
      indexEntries: (entries, removeIds) => {
        for (const id of removeIds) this.index.delete(id)
        for (const value of entries) this.index.set(value.id, structuredClone(value))
      },
      recordAudit: (input) => {
        if (!this.audit.has(input.idempotencyKey)) {
          this.audit.set(input.idempotencyKey, structuredClone(input))
        }
      },
      markApplied: () => {
        this.applied = true
      },
      now: () => NOW,
      failpoint: (point) => {
        if (!this.tripped && point === this.failAt) {
          this.tripped = true
          throw new Error(`simulated crash after ${point}`)
        }
      }
    }
  }
}

test('approved UPDATE keeps the clean live id and links both directions', () => {
  const old = entry()
  const harness = new ApplyHarness(old)
  const saved = applyApprovedMemoryProposal(updateProposal(old), harness.deps())

  assert.equal(saved?.id, 'prefer-pnpm')
  assert.ok(saved?.supersedesId)
  assert.match(saved.supersedesId, /^prefer-pnpm-rev-[a-f0-9]{64}$/)

  const expired = harness.documents.get(saved.supersedesId)
  assert.equal(expired?.title, 'Use pnpm')
  assert.equal(expired?.supersededBy, 'prefer-pnpm')
  assert.equal(expired?.expiredAt, NOW)
  assert.equal(harness.documents.size, 2)
  assert.equal(harness.audit.size, 1)
})

test('legacy link-less entries remain valid update targets', () => {
  const legacy = entry()
  assert.equal(legacy.supersedesId, undefined)
  assert.equal(legacy.supersededBy, undefined)
  assert.match(memoryRevision(legacy), /^[a-f0-9]{64}$/)

  const harness = new ApplyHarness(legacy)
  const saved = applyApprovedMemoryProposal(updateProposal(legacy), harness.deps())
  assert.equal(saved?.title, 'Use bun')
  assert.equal(harness.index.size, 2)
})

test('CAS rejects the second proposal staged against the same target revision', () => {
  const old = entry()
  const proposalA = updateProposal(old)
  const proposalB = updateProposal(old, {
    id: 'proposal-use-npm',
    entry: {
      ...updateProposal(old).entry,
      title: 'Use npm',
      body: 'Use npm for JavaScript dependencies.'
    },
    op: {
      ...updateProposal(old).op!,
      next: { title: 'Use npm', body: 'Use npm for JavaScript dependencies.' }
    }
  })
  const harness = new ApplyHarness(old)

  assertMemoryProposalCurrent(proposalA, harness.deps().getMemory)
  assertMemoryProposalCurrent(proposalB, harness.deps().getMemory)
  applyApprovedMemoryProposal(proposalA, harness.deps())

  assert.throws(
    () => assertMemoryProposalCurrent(proposalB, harness.deps().getMemory),
    /Memory changed since this was proposed — re-propose\./
  )
  assert.throws(
    () => applyApprovedMemoryProposal(proposalB, harness.deps()),
    /Memory changed since this was proposed — re-propose\./
  )
  assert.equal(harness.audit.size, 1)
})

test('a proposal without a target revision must be re-proposed', () => {
  const old = entry()
  const staged = updateProposal(old)
  const { targetRevision: _revision, ...legacyOp } = staged.op!
  const legacy: MemoryProposal = { ...staged, op: legacyOp }
  // The user disabled the fact after the proposal was staged: title and body
  // still match, so the old snapshot-only CAS would have let this through.
  const harness = new ApplyHarness({ ...old, enabled: false })

  assert.throws(
    () => assertMemoryProposalCurrent(legacy, harness.deps().getMemory),
    /Memory changed since this was proposed — re-propose\./
  )
  assert.throws(
    () => applyApprovedMemoryProposal(legacy, harness.deps(true)),
    /Memory changed since this was proposed — re-propose\./
  )
  assert.equal(harness.documents.get('prefer-pnpm')?.title, 'Use pnpm')
})

test('an occupied revision id aborts the apply instead of overwriting it', () => {
  const old = entry()
  const proposal = updateProposal(old)
  const archivedId = `prefer-pnpm-rev-${memoryRevision(old)}`
  const harness = new ApplyHarness(old)
  const unrelated = entry({ id: archivedId, title: 'UNRELATED', body: 'A different memory.' })
  harness.documents.set(unrelated.id, unrelated)

  assert.throws(
    () => applyApprovedMemoryProposal(proposal, harness.deps()),
    /Another memory already occupies the archived revision id/
  )
  assert.equal(harness.documents.get(archivedId)?.title, 'UNRELATED')
  assert.equal(harness.documents.get('prefer-pnpm')?.title, 'Use pnpm')
  assert.equal(harness.audit.size, 0)
})

test('an occupied successor id aborts the apply instead of overwriting it', () => {
  const alpha = entry()
  const harness = new ApplyHarness(alpha)
  const unrelated = entry({ id: 'use-bun', title: 'UNRELATED', body: 'A different live memory.' })
  harness.documents.set(unrelated.id, unrelated)

  assert.throws(
    () => applyApprovedMemoryProposal(renameProposal(alpha, 'use-bun', 'Use bun'), harness.deps()),
    /Memory changed since this was proposed — re-propose\./
  )
  assert.equal(harness.documents.get('use-bun')?.title, 'UNRELATED')
  assert.equal(harness.documents.get('prefer-pnpm')?.title, 'Use pnpm')
  assert.equal(harness.documents.size, 2)
  assert.equal(harness.audit.size, 0)
})

test('an expired successor id occupant is archived, not overwritten', () => {
  // use-bun is an expired revision whose live successor is use-npm. A new
  // update of prefer-pnpm wants the use-bun id for its own successor.
  const alpha = entry()
  const harness = new ApplyHarness(alpha)
  const occupant = entry({
    id: 'use-bun',
    title: 'Use bun',
    body: 'Use bun for JavaScript dependencies.',
    expiredAt: NOW,
    invalidAt: NOW,
    supersededBy: 'use-npm'
  })
  const head = entry({ id: 'use-npm', title: 'Use npm', supersedesId: 'use-bun' })
  harness.documents.set(occupant.id, occupant)
  harness.documents.set(head.id, head)

  const successor = applyApprovedMemoryProposal(
    renameProposal(alpha, 'use-bun', 'Use bun'),
    harness.deps()
  )!

  const movedId = `use-bun-rev-${memoryRevision(occupant)}`
  const moved = harness.documents.get(movedId)!
  // The old revision survives verbatim under its own archive id...
  assert.equal(moved.body, 'Use bun for JavaScript dependencies.')
  assert.equal(moved.expiredAt, NOW)
  // ...and both of its links moved with it.
  assert.equal(harness.documents.get('use-npm')?.supersedesId, movedId)
  assert.equal(moved.supersededBy, 'use-npm')

  // Exactly one live head per chain: use-npm for the old one, the new
  // successor for prefer-pnpm's.
  const live = [...harness.documents.values()].filter((value) => !value.expiredAt)
  assert.deepEqual(live.map((value) => value.id).sort(), ['use-bun', 'use-npm'])
  assert.equal(successor.id, 'use-bun')
  assert.equal(successor.supersedesId, `prefer-pnpm-rev-${memoryRevision(alpha)}`)
  // The relocated revision is still guarded by its own live successor.
  assert.throws(
    () => assertRestoreAllowed(moved, chainOf(harness.documents.values())),
    /Cannot restore memory while its successor is active: use-npm/
  )
})

test('a relocated occupant keeps the chain walkable through the target', () => {
  // The occupant's successor IS the target being updated, so its link fix has
  // to land on the target's archived copy rather than on a removed document.
  const occupant = entry({
    id: 'use-bun',
    title: 'Use bun',
    expiredAt: NOW,
    invalidAt: NOW,
    supersededBy: 'prefer-pnpm'
  })
  const target = entry({ supersedesId: 'use-bun' })
  const harness = new ApplyHarness(target)
  harness.documents.set(occupant.id, occupant)

  applyApprovedMemoryProposal(renameProposal(target, 'use-bun', 'Use bun again'), harness.deps())

  const movedId = `use-bun-rev-${memoryRevision(occupant)}`
  const archivedTarget = harness.documents.get(`prefer-pnpm-rev-${memoryRevision(target)}`)!
  assert.equal(archivedTarget.supersedesId, movedId)
  // The relocated occupant now points at the archive the target moved into.
  assert.equal(harness.documents.get(movedId)?.supersededBy, archivedTarget.id)
  assert.throws(
    () => assertRestoreAllowed(harness.documents.get(movedId)!, chainOf(harness.documents.values())),
    /Cannot restore memory while its successor is active: use-bun/
  )
})

test('a second proposal cannot adopt an identical materialized result', () => {
  const old = entry()
  const proposalA = updateProposal(old)
  const proposalB = updateProposal(old, { id: 'proposal-switch-package-manager-again' })
  const harness = new ApplyHarness(old)

  applyApprovedMemoryProposal(proposalA, harness.deps())

  assert.throws(
    () => assertMemoryProposalCurrent(proposalB, harness.deps().getMemory),
    /Memory changed since this was proposed — re-propose\./
  )
  assert.throws(
    () => applyApprovedMemoryProposal(proposalB, harness.deps()),
    /Memory changed since this was proposed — re-propose\./
  )
  // Only the proposal that owns the outcome replays it after a crash.
  assert.doesNotThrow(() => applyApprovedMemoryProposal(proposalA, harness.deps(true)))
  assert.equal(harness.audit.size, 1)
})

for (const failpoint of ['markdown', 'index', 'audit', 'applied'] as const) {
  test(`UPDATE recovers exactly once after a crash at the ${failpoint} boundary`, () => {
    const old = entry()
    const proposal = updateProposal(old)
    const harness = new ApplyHarness(old, failpoint)

    assert.throws(
      () => applyApprovedMemoryProposal(proposal, harness.deps()),
      new RegExp(`simulated crash after ${failpoint}`)
    )
    applyApprovedMemoryProposal(proposal, harness.deps(true))

    const active = [...harness.documents.values()].filter((value) => !value.expiredAt)
    const expired = [...harness.documents.values()].filter((value) => value.expiredAt)
    assert.deepEqual(active.map((value) => value.id), ['prefer-pnpm'])
    assert.equal(active[0].title, 'Use bun')
    assert.equal(expired.length, 1)
    assert.equal(expired[0].supersededBy, active[0].id)
    assert.equal(harness.index.size, 2)
    assert.equal(harness.audit.size, 1)
    assert.equal(harness.applied, true)
  })
}

/**
 * The Map harness above cannot die between two Markdown documents. This one
 * drives the real document writer against a temp directory and crashes after
 * a chosen durable step — archive write, successor write, or prune — then
 * restarts against whatever is actually on disk.
 */
class DiskHarness {
  readonly root: string
  readonly index = new Map<string, MemoryEntry>()
  readonly audit = new Map<string, MemoryApplyAuditInput>()
  applied = false

  constructor(seed: MemoryEntry) {
    this.root = mkdtempSync(join(tmpdir(), 'morz-memory-apply-'))
    ensureMemoryDirectories(this.root)
    writeEntryDocuments(this.root, [seed])
    this.index.set(seed.id, seed)
  }

  entries(): MemoryEntry[] {
    const { entries, invalid } = readEntryDocuments(this.root)
    assert.equal(invalid, 0)
    return entries
  }

  /** One process run: crash after `crashAfter` durable steps (0 = never). */
  deps(crashAfter = 0, isRetry = false): MemoryApplyDeps {
    let steps = 0
    return {
      isRetry,
      getMemory: (id) => this.entries().find((entry) => entry.id === id) ?? null,
      writeEntries: (entries, removeIds) =>
        writeEntryDocuments(this.root, entries, removeIds, (step) => {
          steps += 1
          if (steps === crashAfter) {
            throw new Error(`simulated crash after ${step.phase} of ${step.id}`)
          }
        }),
      indexEntries: (entries, removeIds) => {
        for (const id of removeIds) this.index.delete(id)
        for (const value of entries) this.index.set(value.id, value)
      },
      recordAudit: (input) => {
        if (!this.audit.has(input.idempotencyKey)) this.audit.set(input.idempotencyKey, input)
      },
      markApplied: () => {
        this.applied = true
      },
      // A real restart never reuses the crashed run's clock.
      now: () => new Date().toISOString()
    }
  }

  cleanup(): void {
    rmSync(this.root, { recursive: true, force: true })
  }
}

const MARKDOWN_STEPS = [
  'write of prefer-pnpm-rev-',
  'write of use-bun',
  'prune of prefer-pnpm'
]

for (const [step, boundary] of MARKDOWN_STEPS.entries()) {
  test(`markdown UPDATE recovers exactly once after a crash at the ${boundary}`, () => {
    const alpha = entry()
    const harness = new DiskHarness(alpha)
    const proposal = renameProposal(alpha, 'use-bun', 'Use bun')
    try {
      assert.throws(
        () => applyApprovedMemoryProposal(proposal, harness.deps(step + 1)),
        new RegExp(`simulated crash after ${boundary}`)
      )
      applyApprovedMemoryProposal(proposal, harness.deps(0, true))

      const entries = harness.entries()
      const live = entries.filter((value) => !value.expiredAt)
      const expired = entries.filter((value) => value.expiredAt)
      assert.deepEqual(live.map((value) => value.id), ['use-bun'])
      assert.equal(live[0].title, 'Use bun')
      // Exactly one archived revision: a shifted derived id would leave two.
      assert.equal(expired.length, 1)
      assert.equal(expired[0].title, 'Use pnpm')
      assert.equal(expired[0].supersededBy, 'use-bun')
      assert.equal(live[0].supersedesId, expired[0].id)
      assert.equal(entries.length, 2)
      assert.equal(readdirSync(join(harness.root, 'global')).length, 2)
      assert.equal(harness.index.size, 2)
      assert.equal(harness.audit.size, 1)
      assert.equal(harness.applied, true)
    } finally {
      harness.cleanup()
    }
  })
}

const CHAIN_BUDGET_MS = 500

test(`a 200-revision chain walk stays under ${CHAIN_BUDGET_MS}ms`, () => {
  const root = mkdtempSync(join(tmpdir(), 'morz-memory-chain-'))
  try {
    ensureMemoryDirectories(root)
    const revisions = Array.from({ length: 200 }, (_value, index) => entry({
      id: `revision-${index}`,
      title: `Revision ${index}`,
      expiredAt: NOW,
      invalidAt: NOW,
      supersedesId: index > 0 ? `revision-${index - 1}` : undefined,
      supersededBy: index < 199 ? `revision-${index + 1}` : 'live-head'
    }))
    const head = entry({ id: 'live-head', title: 'Live head', supersedesId: 'revision-199' })
    writeEntryDocuments(root, [...revisions, head])

    // The whole cost the guard is allowed: one Markdown pass, then memory.
    const started = performance.now()
    const chain = chainOf(readEntryDocuments(root).entries)
    assert.throws(
      () => assertRestoreAllowed(chain.entries.get('revision-0')!, chain),
      /Cannot restore memory while its successor is active: live-head/
    )
    const elapsed = performance.now() - started
    assert.ok(elapsed < CHAIN_BUDGET_MS, `chain walk took ${elapsed.toFixed(0)}ms`)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('restore fails while the linked successor is live', () => {
  const old = entry()
  const harness = new ApplyHarness(old)
  const successor = applyApprovedMemoryProposal(updateProposal(old), harness.deps())
  assert.ok(successor?.supersedesId)
  const expired = harness.documents.get(successor.supersedesId)
  assert.ok(expired)

  assert.throws(
    () => assertRestoreAllowed(expired, chainOf(harness.documents.values())),
    /Cannot restore memory while its successor is active/
  )

  harness.documents.set(successor.id, { ...successor, expiredAt: NOW, invalidAt: NOW })
  assert.doesNotThrow(() => assertRestoreAllowed(expired, chainOf(harness.documents.values())))
})

test('restore walks a three-link chain to the live head', () => {
  const alpha = entry()
  const harness = new ApplyHarness(alpha)
  const beta = applyApprovedMemoryProposal(
    renameProposal(alpha, 'use-bun', 'Use bun'),
    harness.deps()
  )!
  const gamma = applyApprovedMemoryProposal(
    renameProposal(beta, 'use-npm', 'Use npm'),
    harness.deps()
  )!

  const archivedAlpha = harness.documents.get(`prefer-pnpm-rev-${memoryRevision(alpha)}`)!
  const archivedBeta = harness.documents.get(`use-bun-rev-${memoryRevision(beta)}`)!
  // beta's clean document is gone; alpha must now point at beta's archive.
  assert.equal(harness.documents.get('use-bun'), undefined)
  assert.equal(archivedAlpha.supersededBy, archivedBeta.id)
  assert.equal(archivedBeta.supersededBy, gamma.id)

  assert.throws(
    () => assertRestoreAllowed(archivedAlpha, chainOf(harness.documents.values())),
    /Cannot restore memory while its successor is active: use-npm/
  )
})

test('restore follows the audit chain for legacy link-less rows', () => {
  const legacy = entry({ expiredAt: NOW, invalidAt: NOW })
  const harness = new ApplyHarness(legacy)
  const live = entry({ id: 'use-bun', title: 'Use bun' })
  harness.documents.set(live.id, live)
  assert.equal(legacy.supersededBy, undefined)

  assert.throws(
    () => assertRestoreAllowed(
      legacy,
      chainOf(harness.documents.values(), { 'prefer-pnpm': ['use-bun'] })
    ),
    /Cannot restore memory while its successor is active: use-bun/
  )
  assert.doesNotThrow(() => assertRestoreAllowed(legacy, chainOf(harness.documents.values())))
})

test('restore survives a supersession cycle', () => {
  const first = entry({ id: 'first', expiredAt: NOW, supersededBy: 'second' })
  const second = entry({ id: 'second', expiredAt: NOW, supersededBy: 'first' })
  const harness = new ApplyHarness(first)
  harness.documents.set(second.id, second)

  assert.doesNotThrow(() => assertRestoreAllowed(first, chainOf(harness.documents.values())))
})

test('audit input stays compatible with the public audit row shape', () => {
  const row: Omit<MemoryOpAuditRow, 'seq'> = {
    op: 'update',
    memoryId: 'prefer-pnpm',
    targetId: 'prefer-pnpm',
    oldTitle: 'Use pnpm',
    oldBody: 'Use pnpm for JavaScript dependencies.',
    newTitle: 'Use bun',
    newBody: 'Use bun for JavaScript dependencies.',
    reason: null,
    source: 'proposal:proposal-switch-package-manager',
    ts: NOW,
    idempotencyKey: 'proposal-switch-package-manager'
  }
  assert.equal(row.idempotencyKey, 'proposal-switch-package-manager')
})
