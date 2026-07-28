import { app, ipcMain, type IpcMainInvokeEvent } from 'electron'
import { randomUUID } from 'crypto'
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'fs'
import { basename, dirname, join } from 'path'
import {
  MemoryApi,
  type MemoryBootstrapApplyResult,
  type MemoryBootstrapReview,
  type MemoryBootstrapReviewItem,
  type MemoryBootstrapSpace,
  type MemoryEntry,
  type MemoryInvocationEvent,
  type MemoryKind,
  type MemoryOp,
  type MemoryOpSnapshot,
  type MemoryProposal,
  type MemoryScope
} from '../../shared/memory'
import { notify } from '../services/notify-center'
import {
  MemoryInjection,
  emitMemoryChanged,
  getMemory,
  indexMemoryEntries,
  initializeMemoryStore,
  listMemory,
  memoryDatabase,
  restoreMemory,
  searchMemory,
  searchMemoryNeighbors,
  setMemoryEnabled,
  writeMemoryEntries
} from './store'
import {
  classifyOpWithClaude,
  listMemoryOpAudit,
  reconcileCandidate,
  recordMemoryOpAudit,
  type MemoryCandidate,
  type OpClassifier
} from './opset'
import { scanBootstrapMarkdown, splitMarkdownCandidates } from './bootstrap'
import {
  applyApprovedMemoryProposal,
  assertMemoryProposalCurrent,
  memoryRevision
} from './apply'
import { assertTrustedMemorySender } from './ipc-trust'
import {
  clearEventLog,
  eventLogStats,
  logMemoryEvent,
  setMemoryEventMode
} from './event-log'

const MEMORY_E2E_PROPOSE = 'memory:e2e-propose'
const MEMORY_E2E_RENDER = 'memory:e2e-render'
const MEMORY_E2E_RECONCILE = 'memory:e2e-reconcile'
const MEMORY_E2E_AUDIT = 'memory:e2e-audit'
const MEMORY_E2E_EVENT_LOG = 'memory:e2e-event-log'
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const SCOPES = new Set<MemoryScope>(['global', 'project', 'space', 'agent'])
const KINDS = new Set<MemoryKind>(['rule', 'skill', 'fact'])
const STATES = new Set<MemoryProposal['state']>(['pending', 'approved', 'rejected'])
let registered = false
let proposalsInitialized = false
let proposalsInitializing = false
let activeBootstrapReview:
  | {
      review: MemoryBootstrapReview
      items: Map<string, MemoryBootstrapReviewItem>
      appliedIds: Set<string>
    }
  | null = null

function assertTrustedEventLogSender(event: IpcMainInvokeEvent): void {
  if (!event.senderFrame || event.senderFrame !== event.sender.mainFrame) {
    throw new Error('Memory event log rejected an untrusted frame')
  }
  const url = new URL(event.senderFrame.url)
  const localDev =
    (url.protocol === 'http:' || url.protocol === 'https:') &&
    (url.hostname === 'localhost' || url.hostname === '127.0.0.1')
  if (url.protocol !== 'file:' && !localDev) {
    throw new Error('Memory event log rejected an untrusted renderer origin')
  }
}

interface StoredProposal {
  proposal: MemoryProposal
  /** Crash-recovery marker: approved entry was materialized through saveMemory. */
  applied: boolean
}

function cleanText(value: unknown, field: string, max: number, allowEmpty = false): string {
  if (typeof value !== 'string') throw new Error(`${field} must be a string`)
  const clean = value.replace(/\u0000/g, '').replace(/\r\n/g, '\n')
  if ((!allowEmpty && !clean.trim()) || clean.length > max) throw new Error(`Invalid ${field}`)
  return clean
}

function cleanSlug(value: unknown, field: string): string {
  const slug = cleanText(value, field, 120)
  if (!SLUG_PATTERN.test(slug)) throw new Error(`${field} must be a kebab-case slug`)
  return slug
}

function cleanIso(value: unknown): string {
  const text = cleanText(value, 'proposal timestamp', 40)
  const timestamp = Date.parse(text)
  if (!Number.isFinite(timestamp)) throw new Error('Invalid proposal timestamp')
  return new Date(timestamp).toISOString()
}

function cleanProposalTitle(value: unknown): string {
  const title = cleanText(value, 'proposal title', 240).trim()
  if (/\r|\n|[\u0001-\u0008\u000b\u000c\u000e-\u001f]/.test(title)) {
    throw new Error('Proposal title must be one line')
  }
  return title
}

const OP_KINDS = new Set<MemoryOp['kind']>(['add', 'update', 'delete', 'noop'])

function normalizeOpSnapshot(value: unknown, field: string): MemoryOpSnapshot {
  if (!value || typeof value !== 'object') throw new Error(`Invalid ${field}`)
  const input = value as Record<string, unknown>
  return {
    title: cleanProposalTitle(input.title),
    body: cleanText(input.body, `${field} body`, 50_000, true)
  }
}

function normalizeOp(value: unknown): MemoryOp | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'object') throw new Error('Invalid proposal op')
  const input = value as Record<string, unknown>
  if (!OP_KINDS.has(input.kind as MemoryOp['kind'])) throw new Error('Invalid proposal op kind')
  const kind = input.kind as MemoryOp['kind']
  const op: MemoryOp = { kind }
  if (input.targetId !== undefined) op.targetId = cleanSlug(input.targetId, 'op targetId')
  if (input.targetRevision !== undefined) {
    const revision = cleanText(input.targetRevision, 'op targetRevision', 64).trim()
    if (!/^[a-f0-9]{64}$/.test(revision)) throw new Error('Invalid op targetRevision')
    op.targetRevision = revision
  }
  if (input.old !== undefined) op.old = normalizeOpSnapshot(input.old, 'op old')
  if (input.next !== undefined) op.next = normalizeOpSnapshot(input.next, 'op next')
  if (input.reason !== undefined) op.reason = cleanText(input.reason, 'op reason', 500).trim()
  if ((kind === 'update' || kind === 'delete') && (!op.targetId || !op.old)) {
    throw new Error(`A ${kind} op requires targetId and old content`)
  }
  return op
}

function normalizeProposal(value: unknown, stateOverride?: MemoryProposal['state']): MemoryProposal {
  if (!value || typeof value !== 'object') throw new Error('Invalid memory proposal')
  const input = value as Record<string, unknown>
  const rawEntry = input.entry
  if (!rawEntry || typeof rawEntry !== 'object') throw new Error('Invalid proposal entry')
  const entry = rawEntry as Record<string, unknown>
  if (!SCOPES.has(entry.scope as MemoryScope)) throw new Error('Invalid proposal scope')
  if (!KINDS.has(entry.kind as MemoryKind)) throw new Error('Invalid proposal kind')
  if (entry.origin !== 'user' && entry.origin !== 'learned') throw new Error('Invalid proposal origin')
  if (typeof entry.enabled !== 'boolean') throw new Error('Invalid proposal enabled state')
  const scope = entry.scope as MemoryScope
  const scopeRef = scope === 'global'
    ? undefined
    : cleanText(entry.scopeRef, 'proposal scopeRef', 2_000)
  const source = entry.source === undefined || entry.source === null || entry.source === ''
    ? undefined
    : cleanText(entry.source, 'proposal source', 32_768).trim()
  const sourceRunId = entry.sourceRunId === undefined || entry.sourceRunId === null || entry.sourceRunId === ''
    ? undefined
    : cleanText(entry.sourceRunId, 'proposal sourceRunId', 200).trim()
  const optionalIso = (field: 'validAt' | 'invalidAt' | 'expiredAt'): string | undefined =>
    entry[field] === undefined || entry[field] === null || entry[field] === ''
      ? undefined
      : cleanIso(entry[field])
  const optionalLink = (field: 'supersedesId' | 'supersededBy'): string | undefined =>
    entry[field] === undefined || entry[field] === null || entry[field] === ''
      ? undefined
      : cleanSlug(entry[field], `proposal ${field}`)
  if (scope === 'global' && entry.scopeRef !== undefined && entry.scopeRef !== null && entry.scopeRef !== '') {
    throw new Error('Global proposal cannot have a scopeRef')
  }
  if (!Array.isArray(input.evidence) || input.evidence.length === 0 || input.evidence.length > 20) {
    throw new Error('A proposal requires 1-20 evidence lines')
  }
  const requestedState = stateOverride ?? input.state
  if (!STATES.has(requestedState as MemoryProposal['state'])) throw new Error('Invalid proposal state')
  return {
    id: cleanSlug(input.id, 'proposal id'),
    entry: {
      id: cleanSlug(entry.id, 'memory id'),
      scope,
      scopeRef,
      kind: entry.kind as MemoryKind,
      title: cleanProposalTitle(entry.title),
      body: cleanText(entry.body, 'proposal body', 50_000, true),
      origin: entry.origin as MemoryEntry['origin'],
      enabled: entry.enabled,
      validAt: optionalIso('validAt'),
      invalidAt: optionalIso('invalidAt'),
      expiredAt: optionalIso('expiredAt'),
      sourceRunId,
      source,
      supersedesId: optionalLink('supersedesId'),
      supersededBy: optionalLink('supersededBy')
    },
    evidence: input.evidence.map((line) => cleanText(line, 'proposal evidence', 1_000).trim()),
    ts: cleanIso(input.ts),
    state: requestedState as MemoryProposal['state'],
    op: normalizeOp(input.op)
  }
}

function proposalRoot(): string {
  return join(app.getPath('appData'), 'Morz', 'memory', 'proposals')
}

function proposalPath(id: string): string {
  return join(proposalRoot(), `${cleanSlug(id, 'proposal id')}.md`)
}

function serializeStoredProposal(stored: StoredProposal): string {
  const { proposal, applied } = stored
  const fields: [string, unknown][] = [
    ['id', proposal.id],
    ['entry', proposal.entry],
    ['evidence', proposal.evidence],
    ['ts', proposal.ts],
    ['state', proposal.state],
    ...(proposal.op ? ([['op', proposal.op]] as [string, unknown][]) : []),
    ['applied', applied]
  ]
  const frontmatter = fields.map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join('\n')
  const evidence = proposal.evidence.map((line) => `- ${line}`).join('\n')
  return `---\n${frontmatter}\n---\n# ${proposal.entry.title}\n\n${proposal.entry.body}\n\n## Evidence\n\n${evidence}`
}

function writeStoredProposal(stored: StoredProposal): void {
  const target = proposalPath(stored.proposal.id)
  mkdirSync(dirname(target), { recursive: true })
  const temporary = join(dirname(target), `.${stored.proposal.id}.${randomUUID()}.tmp`)
  try {
    writeFileSync(temporary, serializeStoredProposal(stored), { encoding: 'utf8', flag: 'wx' })
    renameSync(temporary, target)
  } finally {
    rmSync(temporary, { force: true })
  }
}

function parseScalar(value: string): unknown {
  try {
    return JSON.parse(value)
  } catch {
    return value.trim()
  }
}

function parseStoredProposal(path: string): StoredProposal {
  const source = readFileSync(path, 'utf8')
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(source)
  if (!match) throw new Error('Missing proposal frontmatter')
  const metadata: Record<string, unknown> = Object.create(null) as Record<string, unknown>
  const allowed = new Set(['id', 'entry', 'evidence', 'ts', 'state', 'op', 'applied'])
  for (const line of match[1].split(/\r?\n/)) {
    const separator = line.indexOf(':')
    if (separator <= 0) throw new Error('Invalid proposal frontmatter')
    const key = line.slice(0, separator).trim()
    if (!allowed.has(key)) continue
    metadata[key] = parseScalar(line.slice(separator + 1).trim())
  }
  const proposal = normalizeProposal(metadata)
  if (basename(path) !== `${proposal.id}.md`) throw new Error('Proposal filename does not match its id')
  if (typeof metadata.applied !== 'boolean') throw new Error('Invalid proposal applied marker')
  return { proposal, applied: metadata.applied }
}

function readStoredProposals(reportInvalid = false): StoredProposal[] {
  mkdirSync(proposalRoot(), { recursive: true })
  const proposals: StoredProposal[] = []
  let invalid = 0
  for (const file of readdirSync(proposalRoot(), { withFileTypes: true })) {
    if (!file.isFile() || !file.name.endsWith('.md')) continue
    try {
      proposals.push(parseStoredProposal(join(proposalRoot(), file.name)))
    } catch (error) {
      invalid += 1
      console.warn('[morz] skipped invalid memory proposal:', file.name, error)
    }
  }
  if (reportInvalid && invalid > 0) {
    notify({
      id: 'app:memory-proposals',
      level: 'warning',
      source: 'app',
      title: 'Some memory proposals could not be read',
      detail: `${invalid} invalid proposal file${invalid === 1 ? '' : 's'} remain on disk and were skipped.`
    })
  }
  return proposals.sort((a, b) =>
    b.proposal.ts.localeCompare(a.proposal.ts) || a.proposal.id.localeCompare(b.proposal.id))
}

function applyApprovedProposal(
  proposal: MemoryProposal,
  markApplied: () => void,
  isRetry = false
): MemoryEntry | null {
  return applyApprovedMemoryProposal(proposal, {
    getMemory,
    writeEntries: writeMemoryEntries,
    indexEntries: indexMemoryEntries,
    recordAudit: (input) => recordMemoryOpAudit(memoryDatabase(), input),
    markApplied,
    now: () => new Date().toISOString(),
    isRetry
  })
}

function initializeProposalStore(): void {
  if (proposalsInitialized || proposalsInitializing) return
  proposalsInitializing = true
  try {
    for (const stored of readStoredProposals(true)) {
      if (stored.proposal.state !== 'approved' || stored.applied) continue
      try {
        // The only retry path: this exact proposal was approved and persisted
        // before the process died, so it may adopt its own materialized result.
        applyApprovedProposal(
          stored.proposal,
          () => writeStoredProposal({ ...stored, applied: true }),
          true
        )
      } catch (error) {
        // A pre-revision proposal (or one whose target moved on) can no longer
        // pass the CAS. It stays approved+unapplied and touches nothing rather
        // than failing memory startup for every other proposal.
        console.warn('[morz] skipped unapplied memory proposal:', stored.proposal.id, error)
      }
    }
    proposalsInitialized = true
  } finally {
    proposalsInitializing = false
  }
}

function reportFailure(action: string, error: unknown): void {
  console.error(`[morz] memory ${action} failed:`, error)
  notify({
    id: `app:memory-${action}`,
    level: 'error',
    source: 'app',
    title: `Memory ${action} failed`,
    detail: 'The local memory store could not complete this action. Your existing Markdown files were left in place.'
  })
}

function guarded<T>(action: string, operation: () => T): T {
  try {
    return operation()
  } catch (error) {
    reportFailure(action, error)
    throw error
  }
}

function trustedGuarded<T>(
  event: IpcMainInvokeEvent,
  action: string,
  operation: () => T
): T {
  assertTrustedMemorySender(event)
  return guarded(action, operation)
}

async function trustedGuardedAsync<T>(
  event: IpcMainInvokeEvent,
  action: string,
  operation: () => Promise<T>
): Promise<T> {
  assertTrustedMemorySender(event)
  try {
    return await operation()
  } catch (error) {
    reportFailure(action, error)
    throw error
  }
}

export function listMemoryProposals(): MemoryProposal[] {
  initializeProposalStore()
  return readStoredProposals().map((stored) => stored.proposal)
}

function proposeMemoryUnsafe(value: unknown): MemoryProposal {
  initializeProposalStore()
  const proposal = normalizeProposal(value, 'pending')
  writeStoredProposal({ proposal, applied: false })
  emitMemoryChanged()
  return proposal
}

/** Main-process learning entry point. Renderer calls to MemoryApi.propose are rejected. */
export function proposeMemory(value: unknown): MemoryProposal {
  return guarded('propose', () => proposeMemoryUnsafe(value))
}

let opClassifierOverride: OpClassifier | null | undefined

/** Test seam. `null` forces the deterministic heuristic; undefined = default. */
export function setMemoryOpClassifier(classifier: OpClassifier | null | undefined): void {
  opClassifierOverride = classifier
}

function defaultOpClassifier(): OpClassifier | null {
  if (opClassifierOverride !== undefined) return opClassifierOverride
  // No LLM under e2e or when explicitly disabled — reconcileCandidate falls
  // back to the deterministic heuristic (and on any classifier failure).
  if (process.env.MORZ_E2E === '1' || process.env.MORZ_MEMORY_CLASSIFIER === 'off') return null
  return classifyOpWithClaude
}

function activeSameScope(candidate: MemoryCandidate): MemoryEntry[] {
  return listMemory(candidate.scope, candidate.scopeRef)
    .filter((entry) => !entry.expiredAt)
}

function ftsNeighbors(candidate: MemoryCandidate): MemoryEntry[] {
  // OR-ranked retrieval that already excludes soft-expired rows.
  return searchMemoryNeighbors(`${candidate.title} ${candidate.body.slice(0, 300)}`, 10)
    .filter((entry) => entry.scope === candidate.scope && entry.scopeRef === candidate.scopeRef)
}

/*
 * w15/memory-opset — the reconciled write path for every candidate memory
 * (learner proposals, manual adds). Candidate → exact-hash pre-dedup → top-k
 * same-scope FTS retrieval → ADD/UPDATE/DELETE/NOOP (one batched LLM call max,
 * never on a lane-launch path). NOOP returns state 'rejected' WITHOUT writing
 * a proposal card; everything else stages a pending card carrying the op.
 */
export async function previewMemoryReconciled(value: unknown): Promise<MemoryProposal> {
  initializeProposalStore()
  const proposal = normalizeProposal(value, 'pending')
  // Freeze the reconciliation view before any async classifier work. The
  // target hash and displayed old snapshot must describe the same revision.
  const scoped = activeSameScope(proposal.entry)
  const neighbors = ftsNeighbors(proposal.entry)
  const op = await reconcileCandidate(proposal.entry, {
    sameScope: () => scoped,
    neighbors: () => neighbors,
    classify: defaultOpClassifier()
  })
  if ((op.kind === 'update' || op.kind === 'delete') && op.targetId) {
    const target = neighbors.find((entry) => entry.id === op.targetId)
      ?? scoped.find((entry) => entry.id === op.targetId)
    if (target) op.targetRevision = memoryRevision(target)
  }
  if (op.kind === 'noop') {
    return { ...proposal, op, state: 'rejected' }
  }
  return { ...proposal, op }
}

export async function proposeMemoryReconciled(value: unknown): Promise<MemoryProposal> {
  const preview = await previewMemoryReconciled(value)
  if (preview.op?.kind === 'noop') return preview
  return guarded('propose', () => {
    writeStoredProposal({ proposal: preview, applied: false })
    emitMemoryChanged()
    return preview
  })
}

export function resolveMemoryProposal(idValue: unknown, approvedValue: unknown): MemoryProposal {
  initializeProposalStore()
  const id = cleanSlug(idValue, 'proposal id')
  if (typeof approvedValue !== 'boolean') throw new Error('approved must be a boolean')
  const path = proposalPath(id)
  let stored: StoredProposal
  try {
    stored = parseStoredProposal(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('Memory proposal not found')
    throw error
  }
  if (stored.proposal.state !== 'pending') return stored.proposal

  const state: MemoryProposal['state'] = approvedValue ? 'approved' : 'rejected'
  const resolved: MemoryProposal = { ...stored.proposal, state }
  if (!approvedValue) {
    writeStoredProposal({ proposal: resolved, applied: true })
    emitMemoryChanged()
    return resolved
  }

  // Reject deterministic stale approvals before persisting approval intent so
  // the proposal remains pending and its card can surface the re-propose error.
  assertMemoryProposalCurrent(resolved, getMemory)
  // Persist intent first. If the process exits before materialization, startup
  // sees approved+unapplied and completes the same apply path.
  writeStoredProposal({ proposal: resolved, applied: false })
  // Never roll approval intent back on an ambiguous storage failure. The
  // ordered apply path leaves approved+unapplied for idempotent startup retry.
  applyApprovedProposal(resolved, () =>
    writeStoredProposal({ proposal: resolved, applied: true }))
  emitMemoryChanged()
  return resolved
}

function normalizeBootstrapSpaces(value: unknown): MemoryBootstrapSpace[] {
  if (!Array.isArray(value) || value.length > 100) throw new Error('Invalid memory bootstrap spaces')
  const roots = new Set<string>()
  return value.map((raw) => {
    if (!raw || typeof raw !== 'object') throw new Error('Invalid memory bootstrap space')
    const input = raw as Record<string, unknown>
    const space = {
      id: cleanText(input.id, 'bootstrap space id', 200).trim(),
      name: cleanText(input.name, 'bootstrap space name', 500).trim(),
      root: cleanText(input.root, 'bootstrap space root', 32_768).trim()
    }
    const key = process.platform === 'win32' ? space.root.toLowerCase() : space.root
    if (roots.has(key)) throw new Error('Duplicate memory bootstrap space root')
    roots.add(key)
    return space
  })
}

export async function buildMemoryBootstrapReview(value: unknown): Promise<MemoryBootstrapReview> {
  const spaces = normalizeBootstrapSpaces(value)
  const scan = await scanBootstrapMarkdown(spaces)
  const allCandidates = scan.documents.flatMap((document) =>
    splitMarkdownCandidates(document).map((candidate) => ({
      candidate,
      sourceFile: document.path
    }))
  )
  const truncations = [...scan.truncations]
  const candidates = allCandidates.slice(0, 1_000)
  if (allCandidates.length > candidates.length) {
    truncations.push(`${allCandidates.length - candidates.length} sections skipped after the 1000-candidate cap`)
  }

  const ts = new Date().toISOString()
  const items: MemoryBootstrapReviewItem[] = []
  for (const { candidate, sourceFile } of candidates) {
    const proposal = await previewMemoryReconciled({
      id: `bootstrap-${candidate.id}`,
      entry: candidate,
      evidence: [`Imported from ${candidate.source ?? 'unknown source'}`],
      ts,
      state: 'pending'
    })
    items.push({
      id: proposal.id,
      sourceFile,
      source: candidate.source ?? 'Unknown source',
      proposal
    })
  }

  const grouped = new Map<string, MemoryBootstrapReviewItem[]>()
  for (const item of items) {
    const group = grouped.get(item.sourceFile) ?? []
    group.push(item)
    grouped.set(item.sourceFile, group)
  }
  const review: MemoryBootstrapReview = {
    reviewId: randomUUID(),
    counts: {
      filesScanned: scan.filesScanned,
      filesRead: scan.filesRead,
      candidates: items.length,
      adds: items.filter((item) => item.proposal.op?.kind === 'add').length,
      updates: items.filter((item) => item.proposal.op?.kind === 'update').length,
      deletes: items.filter((item) => item.proposal.op?.kind === 'delete').length,
      noops: items.filter((item) => item.proposal.op?.kind === 'noop').length
    },
    groups: [...grouped.entries()].map(([source, groupItems]) => ({
      source,
      items: groupItems
    })),
    truncations
  }
  activeBootstrapReview = {
    review,
    items: new Map(items.map((item) => [item.id, item])),
    appliedIds: new Set()
  }
  return review
}

export function applyMemoryBootstrap(
  reviewIdValue: unknown,
  selectedIdsValue: unknown
): MemoryBootstrapApplyResult {
  const reviewId = cleanText(reviewIdValue, 'bootstrap review id', 200).trim()
  if (!Array.isArray(selectedIdsValue) || selectedIdsValue.length > 1_000) {
    throw new Error('Invalid memory bootstrap selection')
  }
  const active = activeBootstrapReview
  if (!active || active.review.reviewId !== reviewId) {
    throw new Error('Memory bootstrap review is no longer active')
  }
  const selectedIds = [...new Set(selectedIdsValue.map((id) => cleanSlug(id, 'bootstrap item id')))]
  const selected = selectedIds.map((id) => {
    const item = active.items.get(id)
    if (!item) throw new Error('Memory bootstrap selection contains an unknown item')
    return item
  })

  let applied = 0
  let skipped = 0
  for (const item of selected) {
    if (item.proposal.op?.kind === 'noop' || active.appliedIds.has(item.id)) {
      skipped += 1
      continue
    }
    const staged = proposeMemory(item.proposal)
    resolveMemoryProposal(staged.id, true)
    active.appliedIds.add(item.id)
    applied += 1
  }
  activeBootstrapReview = null
  return { applied, skipped }
}

async function saveMemoryReconciled(value: unknown): Promise<MemoryEntry> {
  if (!value || typeof value !== 'object') throw new Error('Invalid memory entry')
  const input = value as Record<string, unknown>
  const preview = await previewMemoryReconciled({
    id: `manual-${randomUUID()}`,
    entry: input,
    evidence: ['Saved directly from Memory settings.'],
    ts: new Date().toISOString(),
    state: 'pending'
  })
  if (preview.op?.kind === 'noop') {
    const duplicate = preview.op.targetId ? getMemory(preview.op.targetId) : null
    if (!duplicate) throw new Error('Reconciled memory duplicate is missing')
    return duplicate
  }
  const approved: MemoryProposal = { ...preview, state: 'approved' }
  assertMemoryProposalCurrent(approved, getMemory)
  writeStoredProposal({ proposal: approved, applied: false })
  const saved = applyApprovedProposal(approved, () =>
    writeStoredProposal({ proposal: approved, applied: true }))
  if (!saved) throw new Error('Memory save produced no entry')
  emitMemoryChanged()
  return saved
}

function removeMemoryReconciled(idValue: unknown): void {
  const id = cleanSlug(idValue, 'memory id')
  const target = getMemory(id)
  if (!target) return
  const { createdAt: _createdAt, updatedAt: _updatedAt, ...candidate } = target
  const proposal: MemoryProposal = {
    id: `manual-${randomUUID()}`,
    entry: candidate,
    evidence: ['Deleted directly from Memory settings.'],
    ts: new Date().toISOString(),
    state: 'approved',
    op: {
      kind: 'delete',
      targetId: target.id,
      targetRevision: memoryRevision(target),
      old: { title: target.title, body: target.body },
      reason: 'Deleted from Memory settings'
    }
  }
  assertMemoryProposalCurrent(proposal, getMemory)
  writeStoredProposal({ proposal, applied: false })
  applyApprovedProposal(proposal, () =>
    writeStoredProposal({ proposal, applied: true }))
  emitMemoryChanged()
}

export function registerMemoryIpc(): void {
  if (registered) return
  try {
    initializeMemoryStore()
    initializeProposalStore()
  } catch (error) {
    reportFailure('startup', error)
    throw error
  }

  ipcMain.handle(MemoryApi.list, (event, scope?: MemoryScope, scopeRef?: string) =>
    trustedGuarded(event, 'list', () => listMemory(scope, scopeRef)))
  ipcMain.handle(MemoryApi.get, (event, id: unknown) =>
    trustedGuarded(event, 'get', () => getMemory(id)))
  ipcMain.handle(MemoryApi.save, (event, entry: unknown) =>
    trustedGuardedAsync(event, 'save', () => saveMemoryReconciled(entry)))
  ipcMain.handle(MemoryApi.remove, (event, id: unknown) =>
    trustedGuarded(event, 'remove', () => removeMemoryReconciled(id)))
  ipcMain.handle(MemoryApi.setEnabled, (event, payload: unknown) => trustedGuarded(event, 'set-enabled', () => {
    if (!payload || typeof payload !== 'object') throw new Error('Invalid enabled payload')
    const { id, enabled } = payload as Record<string, unknown>
    return setMemoryEnabled(id, enabled)
  }))
  ipcMain.handle(MemoryApi.search, (event, query: unknown, limit?: unknown) =>
    trustedGuarded(event, 'search', () => searchMemory(query, limit)))
  ipcMain.handle(MemoryApi.proposals, (event) =>
    trustedGuarded(event, 'proposals', listMemoryProposals))
  ipcMain.handle(MemoryApi.propose, (event) => {
    assertTrustedMemorySender(event)
    throw new Error('Memory proposals can only be created by main-process learners')
  })
  ipcMain.handle(MemoryApi.resolveProposal, (event, payload: unknown) =>
    trustedGuarded(event, 'resolve-proposal', () => {
      if (!payload || typeof payload !== 'object') throw new Error('Invalid proposal resolution')
      const { id, approved } = payload as Record<string, unknown>
      return resolveMemoryProposal(id, approved)
    }))
  ipcMain.handle(MemoryApi.restore, (event, id: unknown) => trustedGuarded(event, 'restore', () => {
    const restored = restoreMemory(id)
    recordMemoryOpAudit(memoryDatabase(), {
      op: 'restore',
      memoryId: restored.id,
      next: { title: restored.title, body: restored.body },
      source: 'settings',
      ts: new Date().toISOString(),
      idempotencyKey: `restore-${randomUUID()}`
    })
    return restored
  }))
  ipcMain.handle(MemoryApi.bootstrap, (event, spaces: unknown) =>
    trustedGuarded(event, 'bootstrap', () => buildMemoryBootstrapReview(spaces)))
  ipcMain.handle(MemoryApi.applyBootstrap, (event, payload: unknown) =>
    trustedGuarded(event, 'apply-bootstrap', () => {
      if (!payload || typeof payload !== 'object') throw new Error('Invalid memory bootstrap apply payload')
      const input = payload as Record<string, unknown>
      return applyMemoryBootstrap(input.reviewId, input.selectedIds)
    }))
  ipcMain.handle(MemoryApi.eventLogStats, (event) => {
    assertTrustedEventLogSender(event)
    return eventLogStats()
  })
  ipcMain.handle(MemoryApi.clearEventLog, async (event) => {
    assertTrustedEventLogSender(event)
    await clearEventLog()
  })
  ipcMain.handle(MemoryApi.setEventLogMode, (event, mode: unknown) => {
    assertTrustedEventLogSender(event)
    return setMemoryEventMode(mode)
  })

  if (process.env.MORZ_E2E === '1') {
    ipcMain.handle(MEMORY_E2E_PROPOSE, (event, proposal: unknown) =>
      trustedGuarded(event, 'e2e-propose', () => proposeMemory(proposal)))
    ipcMain.handle(MEMORY_E2E_RECONCILE, (event, proposal: unknown) =>
      trustedGuardedAsync(event, 'e2e-reconcile', () => proposeMemoryReconciled(proposal)))
    ipcMain.handle(MEMORY_E2E_AUDIT, (event) =>
      trustedGuarded(event, 'e2e-audit', () => listMemoryOpAudit(memoryDatabase())))
    if (process.env.MORZ_E2E_MEMORY_EVENT_LOG === '1') {
      // w17/event-log — same sender trust guard as every other memory handler.
      ipcMain.handle(MEMORY_E2E_EVENT_LOG, (event, value: unknown) =>
        trustedGuardedAsync(event, 'e2e-event-log', () => logMemoryEvent(value as MemoryInvocationEvent)))
    }
    ipcMain.handle(MEMORY_E2E_RENDER, (event, opts: unknown) => trustedGuarded(event, 'e2e-render', () => {
      if (!opts || typeof opts !== 'object') throw new Error('Invalid render options')
      const input = opts as Record<string, unknown>
      for (const key of ['projectRoot', 'spaceId', 'agentId']) {
        if (input[key] !== undefined && typeof input[key] !== 'string') throw new Error('Invalid render option')
      }
      return MemoryInjection.render(input as { projectRoot?: string; spaceId?: string; agentId?: string })
    }))
  }
  registered = true
}
