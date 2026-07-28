import { createHash } from 'node:crypto'
import {
  memoryWriteRejection,
  type MemoryEntry,
  type MemoryOp,
  type MemoryOpAuditRow,
  type MemoryProposal
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

function archiveId(id: string, revision: string): string {
  const base = id.slice(0, REVISION_ID_BASE_MAX).replace(/-+$/g, '') || 'memory'
  return `${base}-rev-${revision}`
}

function revisionId(op: MemoryOp): string {
  if (!op.targetRevision) throw new Error(CAS_ERROR)
  return archiveId(op.targetId ?? 'memory', op.targetRevision)
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
  // idempotency key is the proposal id, so recognizing the retry is the
  // caller's job: it re-approves a persisted approved+unapplied proposal.
  if (options.isRetry && isMaterialized(proposal, getMemory)) return
  if (op.kind === 'add') {
    if (getMemory(proposal.entry.id)) throw new Error(CAS_ERROR)
    return
  }
  if (!op.targetId || !op.old) throw new Error(`A ${op.kind} op requires a target snapshot`)
  const target = getMemory(op.targetId)
  if (!target || target.expiredAt) throw new Error(CAS_ERROR)
  // w17/context-blocks — apply writes documents directly (not via saveMemory),
  // so the read-only guard must also run here: a locked fact can never be
  // superseded or deleted by an approved op until the user unlocks it.
  const readOnlyRejection = memoryWriteRejection(
    target,
    op.kind === 'delete'
      ? null
      : { ...proposal.entry, createdAt: target.createdAt, updatedAt: target.updatedAt }
  )
  if (readOnlyRejection) throw new Error(readOnlyRejection)
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
  return {
    entries: [...withRewiredPredecessor([], archived, successor.id, getMemory), archived, successor],
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
 * The predecessor can be a document this plan is already relocating, so it is
 * updated in place rather than written twice.
 */
function withRewiredPredecessor(
  planned: MemoryEntry[],
  archived: MemoryEntry,
  successorId: string,
  getMemory: (id: string) => MemoryEntry | null
): MemoryEntry[] {
  const id = archived.supersedesId
  if (!id || id === archived.id || id === successorId) return planned
  const index = planned.findIndex((value) => value.id === id)
  const predecessor = index < 0 ? getMemory(id) : planned[index]
  if (!predecessor || predecessor.supersededBy === archived.id) return planned
  const rewired = { ...predecessor, supersededBy: archived.id }
  if (index < 0) return [...planned, rewired]
  const next = [...planned]
  next[index] = rewired
  return next
}

interface Relocation {
  /** The occupant, preserved verbatim under its own revision id. */
  moved: MemoryEntry
  /** Neighbours whose link now points at the occupant's new id. */
  rewires: MemoryEntry[]
  /** The target's link fix, applied to its archived copy instead. */
  targetFix?: Partial<Pick<MemoryEntry, 'supersedesId' | 'supersededBy'>>
}

/**
 * An expired revision already sitting on the id the successor wants is a real
 * chain member: overwriting it destroys a revision the audit rows cannot
 * reconstruct, and leaves its own live successor pointing at a brand new fact.
 * It moves to its own archive id — content untouched — and both adjacent links
 * follow it. The collision check waits for the final form (see
 * assertRelocationSafe): the predecessor rewire can still change this entry.
 */
function relocateOccupant(
  occupant: MemoryEntry,
  targetId: string,
  getMemory: (id: string) => MemoryEntry | null
): Relocation {
  const moved: MemoryEntry = { ...occupant, id: archiveId(occupant.id, memoryRevision(occupant)) }
  const relocation: Relocation = { moved, rewires: [] }
  const neighbours = [
    [occupant.supersedesId, 'supersededBy'],
    [occupant.supersededBy, 'supersedesId']
  ] as const
  for (const [id, link] of neighbours) {
    if (!id || id === occupant.id || id === moved.id) continue
    const neighbour = getMemory(id)
    if (!neighbour || neighbour[link] !== occupant.id) continue
    if (id === targetId) relocation.targetFix = { ...relocation.targetFix, [link]: moved.id }
    else relocation.rewires.push({ ...neighbour, [link]: moved.id })
  }
  return relocation
}

/**
 * The relocated occupant may only land on an id that is free or already holds
 * the byte-identical document this plan is about to write. It is checked
 * against the FINAL planned entry, not the verbatim copy: the predecessor
 * rewire can repoint the relocated entry first, and a retry that hashed the
 * pre-rewire form would report a phantom collision with its own crashed write.
 */
function assertRelocationSafe(
  movedId: string,
  planned: MemoryEntry[],
  getMemory: (id: string) => MemoryEntry | null
): void {
  const existing = getMemory(movedId)
  if (!existing) return
  const final = planned.find((value) => value.id === movedId)
  if (!final || memoryRevision(existing) !== memoryRevision(final)) {
    throw new Error(`${COLLISION_ERROR}: ${movedId}`)
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
  // A successor that takes an id other than the target's lands on a document
  // no CAS has looked at. A live memory there means the proposal is stale; an
  // expired revision is moved out of the way rather than destroyed.
  let relocation: Relocation | null = null
  if (op.targetId !== successor.id) {
    const occupied = getMemory(successor.id)
    if (occupied && !occupied.expiredAt) throw new Error(CAS_ERROR)
    if (occupied) relocation = relocateOccupant(occupied, target.id, getMemory)
  }
  const archived: MemoryEntry = {
    ...target,
    ...relocation?.targetFix,
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
  // The relocation lands before the successor overwrites the occupant.
  const relocated = relocation ? [relocation.moved, ...relocation.rewires] : []
  const planned = withRewiredPredecessor(relocated, archived, successor.id, getMemory)
  if (relocation) assertRelocationSafe(relocation.moved.id, planned, getMemory)
  return {
    entries: [...planned, archived, successor],
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

/**
 * Everything the chain walk reads, gathered ONCE by the caller: one Markdown
 * pass and one audit scan. Re-reading per hop turned a 200-revision chain into
 * seconds of blocked main process.
 */
export interface MemoryChainSnapshot {
  /** Every stored entry by id. */
  entries: Map<string, MemoryEntry>
  /** Audit adjacency: a memory id to the revisions recorded as replacing it. */
  auditSuccessors: Map<string, string[]>
}

function successorIds(entry: MemoryEntry, chain: MemoryChainSnapshot): string[] {
  return [
    ...(entry.supersededBy ? [entry.supersededBy] : []),
    ...(chain.auditSuccessors.get(entry.id) ?? [])
  ]
}

/**
 * Un-expiring a revision is only safe when nothing downstream of it is live.
 * The walk follows the whole chain — a successor that was itself superseded
 * hands off to its own successor — and falls back to the audit trail for
 * legacy rows written before supersession links existed. Visited ids are
 * tracked so a cycle in the links cannot spin.
 */
export function assertRestoreAllowed(entry: MemoryEntry, chain: MemoryChainSnapshot): void {
  const seen = new Set<string>([entry.id])
  const queue = successorIds(entry, chain)
  while (queue.length > 0) {
    const id = queue.shift()!
    if (seen.has(id)) continue
    seen.add(id)
    const successor = chain.entries.get(id)
    if (!successor) {
      // The link points at a document that was archived under a revision id;
      // the audit trail still records what replaced it.
      queue.push(...(chain.auditSuccessors.get(id) ?? []))
      continue
    }
    if (!successor.expiredAt) {
      throw new Error(`Cannot restore memory while its successor is active: ${successor.id}`)
    }
    queue.push(...successorIds(successor, chain))
  }
}
