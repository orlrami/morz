/*
 * Cross-agent LEARNING memory contract (0.0.4 "Learns You" — wave-8 seam).
 * A global memory every agent reads at launch: coding standards, conventions,
 * "how the user likes things done". Writes are STAGED behind write-approval —
 * memory never changes silently ("assist, don't take over").
 *
 * Storage: local-first markdown + frontmatter, ONE fact/skill per file,
 * scoped global / project / space / agent, indexed locally. NOT a cloud
 * service. Owners: w8/memory-core implements the store + IPC; w8/memory-learn
 * implements correction-detection + launch-prompt injection. ADDITIVE changes
 * only during the wave.
 */

export type MemoryScope = 'global' | 'project' | 'space' | 'agent'

export type MemoryKind =
  | 'rule' // a durable preference/standard ("always use pnpm", "tests colocated")
  | 'skill' // a procedural how-to ("release steps: ...")
  | 'fact' // stable context ("the API lives in services/api")

export interface MemoryEntry {
  /** Stable slug id — also the markdown filename (kebab-case). */
  id: string
  scope: MemoryScope
  /** Present when scope is project/space/agent. */
  scopeRef?: string
  kind: MemoryKind
  /** One-line summary — this is what gets injected into launch prompts. */
  title: string
  /** Full markdown body (the why + the how). */
  body: string
  /** Where it came from ('user' manual add, 'learned' from corrections). */
  origin: 'user' | 'learned'
  createdAt: string // ISO-8601 UTC
  updatedAt: string
  /** Soft-disable without deleting. */
  enabled: boolean
  /*
   * w15/memory-opset — bi-temporal fields (Zep-style, all optional/additive).
   * valid/invalid describe WORLD truth ("we used X until <date>");
   * created/expired describe SYSTEM knowledge (soft-expiry keeps the row).
   */
  /** When the fact became true in the world (defaults to createdAt). */
  validAt?: string
  /** When the fact stopped being true (set when superseded/contradicted). */
  invalidAt?: string
  /** Soft-expiry marker — expired rows are kept, auditable, and restorable. */
  expiredAt?: string
  /** Provenance: the run/lane that produced this fact. */
  sourceRunId?: string
  /** File provenance for bootstrap imports (`absolute-path#heading`). */
  source?: string
  /** Previous revision in this fact's supersession chain. */
  supersedesId?: string
  /** Live successor that replaced this expired revision. */
  supersededBy?: string
}

/*
 * w15/memory-opset — mem0-style op-set reconciliation. A candidate write is
 * classified against same-scope facts as ADD / UPDATE / DELETE / NOOP; the op
 * object IS the approval payload rendered on the proposal card.
 */
export type MemoryOpKind = 'add' | 'update' | 'delete' | 'noop'

export interface MemoryOpSnapshot {
  title: string
  body: string
}

export interface MemoryOp {
  kind: MemoryOpKind
  /** Existing entry this op targets (update/delete/noop-duplicate). */
  targetId?: string
  /** SHA-256 revision captured when the proposal was staged (approval CAS). */
  targetRevision?: string
  /** Target's content at classification time (update/delete diff rendering). */
  old?: MemoryOpSnapshot
  /** Candidate content to write (add/update). */
  next?: MemoryOpSnapshot
  /** Why (delete/noop). */
  reason?: string
}

/** One applied-op audit row (SQLite memory_ops_audit). */
export interface MemoryOpAuditRow {
  seq: number
  op: 'add' | 'update' | 'delete' | 'restore'
  memoryId: string
  targetId: string | null
  oldTitle: string | null
  oldBody: string | null
  newTitle: string | null
  newBody: string | null
  reason: string | null
  source: string
  ts: string
  /** Stable proposal/manual-operation key used for crash-safe audit deduplication. */
  idempotencyKey: string | null
}

/** A staged write awaiting the user's approval (never auto-applied). */
export interface MemoryProposal {
  id: string
  /** The entry to create/update if approved. */
  entry: Omit<MemoryEntry, 'createdAt' | 'updatedAt'>
  /** Evidence: the repeated corrections/observations that triggered this. */
  evidence: string[]
  ts: string
  state: 'pending' | 'approved' | 'rejected'
  /**
   * w15/memory-opset — how this proposal reconciles against existing facts.
   * Absent = plain add (pre-opset proposals stay valid). NOOP ops never
   * become stored proposals (no card).
   */
  op?: MemoryOp
}

export interface MemoryBootstrapSpace {
  id: string
  name: string
  root: string
}

export interface MemoryBootstrapCounts {
  filesScanned: number
  filesRead: number
  candidates: number
  adds: number
  updates: number
  deletes: number
  noops: number
}

export interface MemoryBootstrapReviewItem {
  id: string
  sourceFile: string
  source: string
  proposal: MemoryProposal
}

export interface MemoryBootstrapReviewGroup {
  source: string
  items: MemoryBootstrapReviewItem[]
}

export interface MemoryBootstrapReview {
  reviewId: string
  counts: MemoryBootstrapCounts
  groups: MemoryBootstrapReviewGroup[]
  truncations: string[]
}

export interface MemoryBootstrapApplyResult {
  applied: number
  skipped: number
}

export type MemoryEventSessionKind = 'lane' | 'dispatched' | 'planner'
export type MemoryEventCli = 'claude' | 'codex' | 'agy' | 'opencode'
export type MemoryEventType = 'spawn' | 'exit' | 'tool' | 'block' | 'interrupt'
export type MemoryEventOutcome = 'ok' | 'error' | 'blocked' | 'unknown'
export type MemoryEventMode = 'manual' | 'assisted' | 'orchestrated'

/**
 * Why a write did or did not land. Callers fire and forget, so the honest
 * outcome has to be reportable rather than collapsed into a boolean:
 * `skipped-mode` is the expected Manual/E2E gate, every `dropped-*` is a real
 * event the log failed to keep. Lives here because the E2E preload returns it
 * across the IPC boundary.
 */
export type MemoryEventWriteStatus =
  | 'ok'
  | 'skipped-mode'
  | 'dropped-invalid'
  | 'dropped-oversized'
  | 'dropped-io'
  | 'dropped-lock'

/**
 * Allowlisted event metadata. Raw args, env, prompts and file contents never
 * cross this contract, and neither does the working directory — a path carries
 * the OS profile name, while agentId/spaceId already attribute the event.
 */
export interface MemoryEventMeta {
  exitCode?: number
  /** Signal name from a fixed set; anything unrecognized is dropped. */
  signal?: string
  phase?: 'start' | 'result'
  source?: 'structured' | 'pty' | '[redacted]'
  model?: string
}

export interface MemoryInvocationEvent {
  v: 1
  ts: number
  sessionKind: MemoryEventSessionKind
  cli: MemoryEventCli
  agentId?: string
  spaceId?: string
  event: MemoryEventType
  name?: string
  outcome?: MemoryEventOutcome
  durationMs?: number
  meta?: MemoryEventMeta
}

export interface MemoryEventLogStats {
  count: number
  bytes: number
  /** Events this session failed to persist (invalid, oversized, or writer lock busy). */
  dropped: number
}

export const MemoryApi = {
  list: 'memory:list', // (scope?: MemoryScope, scopeRef?: string) => Promise<MemoryEntry[]>
  get: 'memory:get', // (id) => Promise<MemoryEntry | null>
  save: 'memory:save', // (entry) => Promise<MemoryEntry>   pre-approved reconciled Settings write
  remove: 'memory:remove', // (id) => Promise<void>          pre-approved reconciled soft-delete
  setEnabled: 'memory:set-enabled', // ({id, enabled}) => Promise<MemoryEntry>
  search: 'memory:search', // (query, limit?) => Promise<MemoryEntry[]>  local index
  /** Staged learning writes (w8/memory-learn produces; user approves). */
  proposals: 'memory:proposals', // () => Promise<MemoryProposal[]>
  propose: 'memory:propose', // (proposal) => Promise<MemoryProposal>   main-side producers only
  resolveProposal: 'memory:resolve-proposal', // ({id, approved}) => Promise<MemoryProposal>
  /** w15/memory-opset — un-expire a soft-expired row (undo for UPDATE/DELETE). */
  restore: 'memory:restore', // (id) => Promise<MemoryEntry>
  bootstrap: 'memory:bootstrap',
  applyBootstrap: 'memory:apply-bootstrap',
  eventLogStats: 'memory:event-log-stats',
  clearEventLog: 'memory:event-log-clear',
  setEventLogMode: 'memory:event-log-set-mode',
  changed: 'memory:changed' // push → void (store or proposals changed)
} as const

/**
 * The launch-prompt injection every adapter/dispatcher calls: enabled entries
 * for the given scope chain (global → project → space → agent), rendered as a
 * compact "How the user works" block. Empty string when memory is empty or
 * disabled. Implemented by w8/memory-core; consumed by w8/memory-learn's
 * adapter/dispatcher wiring.
 */
export interface MemoryInjection {
  render(opts: { projectRoot?: string; spaceId?: string; agentId?: string }): string
}

/** window.morz.memory — exposed by the preload (owner: w8/memory-core). */
export interface MorzMemoryApi {
  list(scope?: MemoryScope, scopeRef?: string): Promise<MemoryEntry[]>
  get(id: string): Promise<MemoryEntry | null>
  save(entry: MemoryEntry): Promise<MemoryEntry>
  remove(id: string): Promise<void>
  setEnabled(id: string, enabled: boolean): Promise<MemoryEntry>
  search(query: string, limit?: number): Promise<MemoryEntry[]>
  proposals(): Promise<MemoryProposal[]>
  resolveProposal(id: string, approved: boolean): Promise<MemoryProposal>
  restore(id: string): Promise<MemoryEntry>
  bootstrap(spaces: MemoryBootstrapSpace[]): Promise<MemoryBootstrapReview>
  applyBootstrap(reviewId: string, selectedIds: string[]): Promise<MemoryBootstrapApplyResult>
  eventLogStats(): Promise<MemoryEventLogStats>
  clearEventLog(): Promise<void>
  setEventLogMode(mode: MemoryEventMode): Promise<MemoryEventMode>
  onChanged(cb: () => void): () => void
}
