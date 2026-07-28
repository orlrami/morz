import { createHash } from 'node:crypto'
import type {
  MemoryEntry,
  MemoryOp,
  MemoryOpAuditRow,
  MemoryProposal
} from '../../shared/memory'

export type MemoryApplyFailpoint = 'markdown' | 'index' | 'audit' | 'applied'

export interface MemoryApplyAuditInput {
  op: MemoryOpAuditRow['op']
  memoryId: string
  targetId?: string
  old?: { title: string; body: string }
  next?: { title: string; body: string }
  reason?: string
  source: string
  ts: string
  idempotencyKey: string
}

export interface MemoryApplyDeps {
  getMemory(id: string): MemoryEntry | null
  writeEntries(entries: MemoryEntry[], removeIds: string[]): void
  indexEntries(entries: MemoryEntry[], removeIds: string[]): void
  recordAudit(input: MemoryApplyAuditInput): void
  markApplied(): void
  now(): string
  failpoint?(point: MemoryApplyFailpoint): void
}

const CAS_ERROR = 'Memory changed since this was proposed — re-propose.'

function hashParts(parts: unknown[]): string {
  return createHash('sha256').update(JSON.stringify(parts), 'utf8').digest('hex')
}

export function memoryRevision(entry: MemoryEntry): string {
  return hashParts([
    entry.id,
    entry.scope,
    entry.scopeRef ?? null,
    entry.kind,
    entry.title,
    entry.body,
    entry.origin,
    entry.createdAt,
    entry.updatedAt,
    entry.enabled,
    entry.validAt ?? null,
    entry.invalidAt ?? null,
    entry.expiredAt ?? null,
    entry.sourceRunId ?? null,
    entry.source ?? null,
    entry.supersedesId ?? null,
    entry.supersededBy ?? null
  ])
}

function legacyTargetRevision(op: MemoryOp): string {
  return hashParts([op.targetId ?? null, op.old?.title ?? null, op.old?.body ?? null])
}

function targetRevision(op: MemoryOp): string {
  return op.targetRevision ?? legacyTargetRevision(op)
}

function revisionId(op: MemoryOp): string {
  const base = (op.targetId ?? 'memory').slice(0, 103).replace(/-+$/g, '') || 'memory'
  return `${base}-rev-${targetRevision(op).slice(0, 12)}`
}

function matchesProposal(entry: MemoryEntry, proposal: MemoryProposal): boolean {
  return entry.id === proposal.entry.id
    && entry.scope === proposal.entry.scope
    && entry.scopeRef === proposal.entry.scopeRef
    && entry.kind === proposal.entry.kind
    && entry.title === proposal.entry.title
    && entry.body === proposal.entry.body
    && entry.origin === proposal.entry.origin
    && entry.enabled === proposal.entry.enabled
}

function isMaterialized(
  proposal: MemoryProposal,
  getMemory: (id: string) => MemoryEntry | null
): boolean {
  const op = proposal.op ?? { kind: 'add' as const }
  if (op.kind === 'noop') return true
  if (op.kind === 'add') {
    const saved = getMemory(proposal.entry.id)
    return saved !== null && !saved.expiredAt && matchesProposal(saved, proposal)
  }
  if (!op.targetId || !op.old) return false
  if (op.kind === 'delete') {
    const expired = getMemory(op.targetId)
    return expired !== null
      && expired.expiredAt !== undefined
      && expired.title === op.old.title
      && expired.body === op.old.body
  }
  const successor = getMemory(proposal.entry.id)
  const archivedId = revisionId(op)
  const archived = getMemory(archivedId)
  return successor !== null
    && archived !== null
    && !successor.expiredAt
    && matchesProposal(successor, proposal)
    && successor.supersedesId === archivedId
    && archived.supersededBy === successor.id
}

export function assertMemoryProposalCurrent(
  proposal: MemoryProposal,
  getMemory: (id: string) => MemoryEntry | null
): void {
  const op = proposal.op ?? { kind: 'add' as const }
  if (isMaterialized(proposal, getMemory) || op.kind === 'noop') return
  if (op.kind === 'add') {
    if (getMemory(proposal.entry.id)) throw new Error(CAS_ERROR)
    return
  }
  if (!op.targetId || !op.old) throw new Error(`A ${op.kind} op requires a target snapshot`)
  const target = getMemory(op.targetId)
  if (!target || target.expiredAt) throw new Error(CAS_ERROR)
  if (op.targetRevision) {
    if (memoryRevision(target) !== op.targetRevision) throw new Error(CAS_ERROR)
    return
  }
  // Pre-wave proposals have no revision hash. Their persisted old snapshot is
  // still a safe compatibility CAS for the mutable content fields.
  if (target.title !== op.old.title || target.body !== op.old.body) throw new Error(CAS_ERROR)
}

interface ApplyPlan {
  entries: MemoryEntry[]
  removeIds: string[]
  result: MemoryEntry | null
  audit?: MemoryApplyAuditInput
}

function recoveredPlan(
  proposal: MemoryProposal,
  getMemory: (id: string) => MemoryEntry | null,
  now: string
): ApplyPlan | null {
  if (!isMaterialized(proposal, getMemory)) return null
  const op = proposal.op ?? { kind: 'add' as const }
  if (op.kind === 'noop') return { entries: [], removeIds: [], result: null }
  if (op.kind === 'add') {
    const saved = getMemory(proposal.entry.id)!
    return {
      entries: [saved],
      removeIds: [],
      result: saved,
      audit: auditFor(proposal, saved, now)
    }
  }
  if (op.kind === 'delete') {
    const expired = getMemory(op.targetId!)!
    return {
      entries: [expired],
      removeIds: [],
      result: expired,
      audit: auditFor(proposal, expired, now)
    }
  }
  const successor = getMemory(proposal.entry.id)!
  const archived = getMemory(revisionId(op))!
  return {
    entries: [archived, successor],
    removeIds: op.targetId === successor.id ? [] : [op.targetId!],
    result: successor,
    audit: auditFor(proposal, successor, now)
  }
}

function freshPlan(
  proposal: MemoryProposal,
  getMemory: (id: string) => MemoryEntry | null,
  now: string
): ApplyPlan {
  const op = proposal.op ?? { kind: 'add' as const }
  if (op.kind === 'noop') return { entries: [], removeIds: [], result: null }
  if (op.kind === 'add') {
    const saved: MemoryEntry = {
      ...proposal.entry,
      createdAt: now,
      updatedAt: now,
      validAt: proposal.entry.validAt ?? now
    }
    return {
      entries: [saved],
      removeIds: [],
      result: saved,
      audit: auditFor(proposal, saved, now)
    }
  }

  const target = getMemory(op.targetId!)!
  if (op.kind === 'delete') {
    const expired: MemoryEntry = {
      ...target,
      invalidAt: target.invalidAt ?? now,
      expiredAt: now,
      updatedAt: now,
      ...(proposal.entry.sourceRunId ? { sourceRunId: proposal.entry.sourceRunId } : {})
    }
    return {
      entries: [expired],
      removeIds: [],
      result: expired,
      audit: auditFor(proposal, expired, now)
    }
  }

  const archivedId = revisionId(op)
  const successor: MemoryEntry = {
    ...proposal.entry,
    createdAt: now,
    updatedAt: now,
    validAt: proposal.entry.validAt ?? now,
    supersedesId: archivedId
  }
  const archived: MemoryEntry = {
    ...target,
    id: archivedId,
    invalidAt: target.invalidAt ?? now,
    expiredAt: now,
    updatedAt: now,
    supersededBy: successor.id,
    ...(proposal.entry.sourceRunId ? { sourceRunId: proposal.entry.sourceRunId } : {})
  }
  return {
    entries: [archived, successor],
    removeIds: op.targetId === successor.id ? [] : [op.targetId!],
    result: successor,
    audit: auditFor(proposal, successor, now)
  }
}

function auditFor(
  proposal: MemoryProposal,
  saved: MemoryEntry,
  now: string
): MemoryApplyAuditInput | undefined {
  const op = proposal.op ?? { kind: 'add' as const }
  if (op.kind === 'noop') return undefined
  return {
    op: op.kind === 'delete' ? 'delete' : op.kind === 'update' ? 'update' : 'add',
    memoryId: op.kind === 'delete' ? op.targetId ?? saved.id : saved.id,
    targetId: op.targetId,
    old: op.old,
    next: op.kind === 'delete' ? undefined : { title: saved.title, body: saved.body },
    reason: op.reason,
    source: `proposal:${proposal.id}`,
    ts: now,
    idempotencyKey: proposal.id
  }
}

export function applyApprovedMemoryProposal(
  proposal: MemoryProposal,
  deps: MemoryApplyDeps
): MemoryEntry | null {
  const now = deps.now()
  let plan = recoveredPlan(proposal, deps.getMemory, now)
  if (!plan) {
    assertMemoryProposalCurrent(proposal, deps.getMemory)
    plan = freshPlan(proposal, deps.getMemory, now)
  }
  // Rewriting an already materialized plan is intentional: a process can die
  // between individual Markdown renames/removals inside the durable phase.
  // Replaying the same documents also finishes pruning any stale clean-id file.
  deps.writeEntries(plan.entries, plan.removeIds)
  deps.failpoint?.('markdown')

  // Crash ordering contract: Markdown (source of truth) → FTS index → one
  // idempotent audit row → proposal applied marker. Startup rebuilds FTS from
  // Markdown before retrying approved+unapplied proposals, and the stable audit
  // key makes every retry converge on one logical operation.
  deps.indexEntries(plan.entries, plan.removeIds)
  deps.failpoint?.('index')
  if (plan.audit) deps.recordAudit(plan.audit)
  deps.failpoint?.('audit')
  deps.markApplied()
  deps.failpoint?.('applied')
  return plan.result
}

export function assertRestoreAllowed(
  entry: MemoryEntry,
  getMemory: (id: string) => MemoryEntry | null
): void {
  if (!entry.supersededBy) return
  const successor = getMemory(entry.supersededBy)
  if (successor && !successor.expiredAt) {
    throw new Error(`Cannot restore memory while its successor is active: ${successor.id}`)
  }
}
