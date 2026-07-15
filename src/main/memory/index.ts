import { app, ipcMain } from 'electron'
import { randomUUID } from 'crypto'
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'fs'
import { basename, dirname, join } from 'path'
import {
  MemoryApi,
  type MemoryEntry,
  type MemoryKind,
  type MemoryProposal,
  type MemoryScope
} from '../../shared/memory'
import { notify } from '../services/notify-center'
import {
  MemoryInjection,
  emitMemoryChanged,
  getMemory,
  initializeMemoryStore,
  listMemory,
  removeMemory,
  saveMemory,
  searchMemory,
  setMemoryEnabled
} from './store'

const MEMORY_E2E_PROPOSE = 'memory:e2e-propose'
const MEMORY_E2E_RENDER = 'memory:e2e-render'
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const SCOPES = new Set<MemoryScope>(['global', 'project', 'space', 'agent'])
const KINDS = new Set<MemoryKind>(['rule', 'skill', 'fact'])
const STATES = new Set<MemoryProposal['state']>(['pending', 'approved', 'rejected'])
let registered = false
let proposalsInitialized = false
let proposalsInitializing = false

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
      enabled: entry.enabled
    },
    evidence: input.evidence.map((line) => cleanText(line, 'proposal evidence', 1_000).trim()),
    ts: cleanIso(input.ts),
    state: requestedState as MemoryProposal['state']
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
  const allowed = new Set(['id', 'entry', 'evidence', 'ts', 'state', 'applied'])
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

function initializeProposalStore(): void {
  if (proposalsInitialized || proposalsInitializing) return
  proposalsInitializing = true
  try {
    for (const stored of readStoredProposals(true)) {
      if (stored.proposal.state !== 'approved' || stored.applied) continue
      const now = new Date().toISOString()
      saveMemory({ ...stored.proposal.entry, createdAt: now, updatedAt: now })
      writeStoredProposal({ ...stored, applied: true })
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

  // Persist intent first. If the process exits before materialization, startup
  // sees approved+unapplied and completes the same saveMemory path.
  writeStoredProposal({ proposal: resolved, applied: false })
  // Never roll approval intent back on an ambiguous failure: saveMemory can
  // fail after its atomic Markdown rename (for example while updating FTS).
  // Leaving approved+unapplied lets startup recovery retry idempotently.
  const now = new Date().toISOString()
  saveMemory({ ...resolved.entry, createdAt: now, updatedAt: now })
  writeStoredProposal({ proposal: resolved, applied: true })
  emitMemoryChanged()
  return resolved
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

  ipcMain.handle(MemoryApi.list, (_event, scope?: MemoryScope, scopeRef?: string) =>
    guarded('list', () => listMemory(scope, scopeRef)))
  ipcMain.handle(MemoryApi.get, (_event, id: unknown) => guarded('get', () => getMemory(id)))
  ipcMain.handle(MemoryApi.save, (_event, entry: unknown) => guarded('save', () => {
    if (!entry || typeof entry !== 'object') throw new Error('Invalid memory entry')
    return saveMemory(entry)
  }))
  ipcMain.handle(MemoryApi.remove, (_event, id: unknown) => guarded('remove', () => removeMemory(id)))
  ipcMain.handle(MemoryApi.setEnabled, (_event, payload: unknown) => guarded('set-enabled', () => {
    if (!payload || typeof payload !== 'object') throw new Error('Invalid enabled payload')
    const { id, enabled } = payload as Record<string, unknown>
    return setMemoryEnabled(id, enabled)
  }))
  ipcMain.handle(MemoryApi.search, (_event, query: unknown, limit?: unknown) =>
    guarded('search', () => searchMemory(query, limit)))
  ipcMain.handle(MemoryApi.proposals, () => guarded('proposals', listMemoryProposals))
  ipcMain.handle(MemoryApi.propose, () => {
    throw new Error('Memory proposals can only be created by main-process learners')
  })
  ipcMain.handle(MemoryApi.resolveProposal, (_event, payload: unknown) =>
    guarded('resolve-proposal', () => {
      if (!payload || typeof payload !== 'object') throw new Error('Invalid proposal resolution')
      const { id, approved } = payload as Record<string, unknown>
      return resolveMemoryProposal(id, approved)
    }))

  if (process.env.MORZ_E2E === '1') {
    ipcMain.handle(MEMORY_E2E_PROPOSE, (_event, proposal: unknown) => proposeMemory(proposal))
    ipcMain.handle(MEMORY_E2E_RENDER, (_event, opts: unknown) => guarded('e2e-render', () => {
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
