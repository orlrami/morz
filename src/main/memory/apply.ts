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
  /**
   * Crash recovery only: set when replaying a PERSISTED approved+unapplied
   * proposal. A first-time approval must never treat an already materialized
   * outcome as its own retry — that would accept a second distinct proposal
   * carrying the same target revision and replacement.
   */
  isRetry?: boolean
}

const CAS_ERROR = 'Memory changed since this was proposed — re-propose.'
const COLLISION_ERROR = 'Another memory already occupies the archived revision id'

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

// The archived id must stay under the store's 120-character id limit while
// carrying the FULL 64-character revision hash: a truncated hash could collide
// with an unrelated entry, and the store overwrites whatever lives at an id.
const REVISION_ID_BASE_MAX = 120 - '-rev-'.length - 64

function revisionId(op: MemoryOp): string {
  if (!op.targetRevision) throw new Error(CAS_ERROR)
  const base = (op.targetId ?? 'memory').slice(0, REVISION_ID_BASE_MAX).replace(/-+$/g, '') || 'memory'
  return `${base}-rev-${op.targetRevision}`
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
  if (!op.targetId || !op.old || !op.targetRevision) return false
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
  getMemory: (id: string) => MemoryEntry | null,
  options: { isRetry?: boolean } = {}
): void {
  const op = proposal.op ?? { kind: 'add' as const }
  if (op.kind === 'noop') return
  // Only the proposal that already owns this outcome may skip the CAS. Its
  // idempotency key is the proposal id, so recognising the retry is the
  // caller's job: it re-approves a persisted approved+unapplied proposal.
  if (options.isRetry && isMaterialized(proposal, getMemory)) return
  if (op.kind === 'add') {
    if (getMemory(proposal.entry.id)) throw new Error(CAS_ERROR)
    return
  }
  if (!op.targetId || !op.old) throw new Error(`A ${op.kind} op requires a target snapshot`)
  const target = getMemory(op.targetId)
  if (!target || target.expiredAt) throw new Error(CAS_ERROR)
  // Pre-wave proposals carry no revision hash, and their old title/body
  // snapshot ignores every other mutable field (a proposal staged while the
  // fact was enabled would still apply after the user disabled it). They must
  // be re-proposed, which is exactly what the stale-CAS error asks for.
  if (memoryRevision(target) !== op.targetRevision) throw new Error(CAS_ERROR)
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
  const predecessor = rewiredPredecessor(archived, successor.id, getMemory)
  return {
    entries: [...(predecessor ? [predecessor] : []), archived, successor],
    removeIds: op.targetId === successor.id ? [] : [op.targetId!],
    result: successor,
    audit: auditFor(proposal, successor, now)
  }
}

/**
 * A crash between the archived write and the successor write leaves a partial
 * archive the retry must be free to rewrite (only its timestamps differ).
 * Anything else living at the derived id belongs to a different memory, and
 * the store overwrites whatever it finds there — so fail closed instead.
 */
function isPartialArchive(occupant: MemoryEntry, archived: MemoryEntry): boolean {
  return occupant.expiredAt !== undefined
    && occupant.scope === archived.scope
    && occupant.scopeRef === archived.scopeRef
    && occupant.kind === archived.kind
    && occupant.title === archived.title
    && occupant.body === archived.body
    && occupant.origin === archived.origin
    && occupant.createdAt === archived.createdAt
    && occupant.supersededBy === archived.supersededBy
}

/**
 * A predecessor's supersededBy names the revision that replaced it, and that
 * revision has just moved from the live clean id to the archived id. Rewiring
 * the link in the same durable write keeps the chain walkable; leaving it
 * dangling at a removed id would hide the live head from the restore guard.
 */
function rewiredPredecessor(
  archived: MemoryEntry,
  successorId: string,
  getMemory: (id: string) => MemoryEntry | null
): MemoryEntry | null {
  const id = archived.supersedesId
  if (!id || id === archived.id || id === successorId) return null
  const predecessor = getMemory(id)
  if (!predecessor || predecessor.supersededBy === archived.id) return null
  return { ...predecessor, supersededBy: archived.id }
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
  const occupant = getMemory(archivedId)
  if (occupant && !isPartialArchive(occupant, archived)) {
    throw new Error(`${COLLISION_ERROR}: ${archivedId}`)
  }
  const predecessor = rewiredPredecessor(archived, successor.id, getMemory)
  return {
    entries: [...(predecessor ? [predecessor] : []), archived, successor],
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
  let plan = deps.isRetry ? recoveredPlan(proposal, deps.getMemory, now) : null
  if (!plan) {
    assertMemoryProposalCurrent(proposal, deps.getMemory, { isRetry: deps.isRetry })
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

/** Ids of the revisions recorded as replacing a memory (audit target_id chain). */
export type MemoryAuditSuccessors = (memoryId: string) => string[]

function successorIds(entry: MemoryEntry, audit?: MemoryAuditSuccessors): string[] {
  return [...(entry.supersededBy ? [entry.supersededBy] : []), ...(audit?.(entry.id) ?? [])]
}

/**
 * Un-expiring a revision is only safe when nothing downstream of it is live.
 * The walk follows the whole chain — a successor that was itself superseded
 * hands off to its own successor — and falls back to the audit trail for
 * legacy rows written before supersession links existed. Visited ids are
 * tracked so a cycle in the links cannot spin.
 */
export function assertRestoreAllowed(
  entry: MemoryEntry,
  getMemory: (id: string) => MemoryEntry | null,
  audit?: MemoryAuditSuccessors
): void {
  const seen = new Set<string>([entry.id])
  const queue = successorIds(entry, audit)
  while (queue.length > 0) {
    const id = queue.shift()!
    if (seen.has(id)) continue
    seen.add(id)
    const successor = getMemory(id)
    if (!successor) {
      // The link points at a document that was archived under a revision id;
      // the audit trail still records what replaced it.
      queue.push(...(audit?.(id) ?? []))
      continue
    }
    if (!successor.expiredAt) {
      throw new Error(`Cannot restore memory while its successor is active: ${successor.id}`)
    }
    queue.push(...successorIds(successor, audit))
  }
}
