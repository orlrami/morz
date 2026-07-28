import { execFile } from 'node:child_process'
import { lstat, readFile, realpath, stat } from 'node:fs/promises'
import { isAbsolute, join, normalize, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import { CONTEXT_MEMORY_KINDS, ContextHubApi } from '../../shared/context-hub'
import type {
  ContextApplyResult,
  ContextFileKind,
  ContextFileState,
  ContextMatrix,
  ContextMemoryBlockInput,
  ContextMemoryKind,
  ContextProjectType,
  ContextProposal,
  ContextSharedBlockInput,
  ContextSpaceInput,
  ContextSpaceMatrix,
  ContextStatusBlockInput,
  ContextTemplateInput
} from '../../shared/context-hub'
import type { RunSummary } from '../../shared/ipc'
import type { MemoryEntry } from '../../shared/memory'
// w17/renderer-core — the ONE memory renderer (agent A). Selection, budget, and
// marker escaping all live there; this service only decides WHERE it lands.
import { escapeMorzMarkers, renderMemoryBlock } from '../memory/render'
import {
  createConfigWriter,
  type ConfigWriter,
  type FileProposal
} from './config-writer'

const execFileAsync = promisify(execFile)

interface KnownFile {
  kind: ContextFileKind
  label: string
  candidates: readonly string[]
}

const KNOWN_FILES: readonly KnownFile[] = [
  { kind: 'claude', label: 'CLAUDE.md', candidates: ['CLAUDE.md', '.claude/CLAUDE.md', 'docs/CLAUDE.md'] },
  { kind: 'agents', label: 'AGENTS.md', candidates: ['AGENTS.md', '.claude/AGENTS.md', 'docs/AGENTS.md'] },
  { kind: 'gemini', label: 'GEMINI.md', candidates: ['GEMINI.md', '.claude/GEMINI.md', 'docs/GEMINI.md'] },
  { kind: 'status', label: 'STATUS.md', candidates: ['STATUS.md', '.claude/STATUS.md', 'docs/STATUS.md'] },
  { kind: 'readme', label: 'README.md', candidates: ['README.md', '.claude/README.md', 'docs/README.md'] },
  { kind: 'claude-settings', label: '.claude/settings.json', candidates: ['.claude/settings.json'] },
  { kind: 'mcp', label: '.mcp.json', candidates: ['.mcp.json'] },
  { kind: 'codex-config', label: 'config.toml', candidates: ['config.toml'] },
  { kind: 'opencode', label: 'opencode.json', candidates: ['opencode.json'] }
] as const

function normalizeRelativePath(value: string): string {
  return value.replace(/\\/g, '/')
}

function validateText(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > max) {
    throw new Error(`${field} is invalid`)
  }
  return value.trim()
}

/*
 * w16 — space-store roots are the authority (every space was user-picked); the
 * scan path validates each root structurally, the same way fs:list does:
 * absolute, no '..' traversal, exists, is a directory. Symlink and containment
 * guards on individual context files stay (assertKnownPathSafe).
 */
async function validateSpace(input: ContextSpaceInput): Promise<ContextSpaceInput> {
  if (!input || typeof input !== 'object') throw new Error('Space is invalid')
  const id = validateText(input.id, 'Space id', 200)
  const name = validateText(input.name, 'Space name', 500)
  const rootInput = validateText(input.root, 'Space root', 32_768)
  // w16 integration — D's shared validator (also used by the memory bootstrap)
  // carries A's decision: structural validation only, no per-root authority.
  const root = await validateContextRoot(rootInput)
  return { id, name, root }
}

/** Shared scanner boundary for context-hub and memory bootstrap. */
export async function validateContextRoot(rootInput: string): Promise<string> {
  if (!isAbsolute(rootInput)) throw new Error('Space root must be absolute')
  if (normalize(rootInput).split(sep).includes('..')) {
    throw new Error('Space root must not contain traversal segments')
  }
  let root: string
  try {
    root = await realpath(rootInput)
  } catch {
    // Deliberate message contract (w16): callers and specs match on this text
    // instead of a raw ENOENT with the probed filesystem path.
    throw new Error('Space root does not exist')
  }
  const info = await stat(root)
  if (!info.isDirectory()) throw new Error('Space root must be a directory')
  return root
}

function candidatePath(root: string, relativePath: string): string {
  const path = join(root, ...relativePath.split('/'))
  const fromRoot = relative(root, path)
  if (!fromRoot || fromRoot.startsWith('..') || isAbsolute(fromRoot)) {
    if (!fromRoot) return path
    throw new Error('Context path escaped its space root')
  }
  return path
}

function isContained(root: string, path: string): boolean {
  const fromRoot = relative(root, path)
  return fromRoot === '' || (!fromRoot.startsWith('..') && !isAbsolute(fromRoot))
}

export async function assertKnownPathSafe(root: string, pathInput: string): Promise<void> {
  const path = resolve(pathInput)
  if (!isContained(root, path) || path === root) {
    throw new Error('Context path escaped its Space root')
  }
  let current = root
  for (const segment of relative(root, path).split(/[\\/]/).filter(Boolean)) {
    current = join(current, segment)
    try {
      const info = await lstat(current)
      if (info.isSymbolicLink()) {
        throw new Error(`Context path crosses a symbolic link or junction: ${current}`)
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') break
      throw error
    }
  }
  try {
    const canonical = await realpath(path)
    if (!isContained(root, canonical)) throw new Error('Context path escaped its Space root')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

async function projectType(root: string): Promise<ContextProjectType> {
  const exists = async (relativePath: string): Promise<boolean> => {
    try {
      const path = candidatePath(root, relativePath)
      await assertKnownPathSafe(root, path)
      return (await stat(path)).isFile()
    } catch {
      return false
    }
  }
  // Root Cargo.toml/go.mod outranks package.json: rust/go repos often carry a
  // JS sidecar (docs site, wasm bindings) but the reverse is rare.
  if (await exists('Cargo.toml')) return 'rust'
  if (await exists('go.mod')) return 'go'
  if (await exists('package.json')) return 'node'
  if (
    await exists('pyproject.toml') ||
    await exists('requirements.txt') ||
    await exists('setup.py')
  ) {
    return 'python'
  }
  return 'generic'
}

async function staleCutoff(root: string): Promise<number | null> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['log', '-20', '--format=%ct', '--', 'src'],
      { cwd: root, windowsHide: true, maxBuffer: 128 * 1024 }
    )
    const timestamps = stdout
      .split(/\r?\n/)
      .map((line) => Number(line.trim()) * 1000)
      .filter((value) => Number.isFinite(value) && value > 0)
    return timestamps.length > 0 ? Math.min(...timestamps) : null
  } catch {
    return null
  }
}

async function scanKnownFile(
  root: string,
  known: KnownFile,
  cutoffMs: number | null
): Promise<ContextFileState> {
  for (const relativePath of known.candidates) {
    const path = candidatePath(root, relativePath)
    try {
      await assertKnownPathSafe(root, path)
      const info = await stat(path)
      if (!info.isFile()) continue
      const stale = cutoffMs !== null && info.mtimeMs < cutoffMs
      return {
        kind: known.kind,
        label: known.label,
        state: stale ? 'stale' : 'present',
        relativePath,
        path,
        lastTouchedAt: new Date(info.mtimeMs).toISOString()
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  const relativePath = known.candidates[0]
  return {
    kind: known.kind,
    label: known.label,
    state: 'missing',
    relativePath,
    path: candidatePath(root, relativePath),
    lastTouchedAt: null
  }
}

async function scanSpace(rawSpace: ContextSpaceInput): Promise<ContextSpaceMatrix> {
  const space = await validateSpace(rawSpace)
  const cutoffMs = await staleCutoff(space.root)
  return {
    ...space,
    projectType: await projectType(space.root),
    staleCutoffAt: cutoffMs === null ? null : new Date(cutoffMs).toISOString(),
    files: await Promise.all(KNOWN_FILES.map((known) => scanKnownFile(space.root, known, cutoffMs)))
  }
}

export interface ContextHubService {
  scan(spaces: ContextSpaceInput[]): Promise<ContextMatrix>
  proposeTemplate(input: ContextTemplateInput): Promise<ContextProposal>
  proposeSharedBlock(input: ContextSharedBlockInput): Promise<ContextProposal[]>
  proposeMemoryBlock(input: ContextMemoryBlockInput): Promise<ContextProposal[]>
  proposeStatusBlock(input: ContextStatusBlockInput): Promise<ContextProposal[]>
  applyProposal(proposalId: string): Promise<ContextApplyResult>
}

export interface ContextStatusSnapshot {
  branch: string
  recentRuns: Pick<RunSummary, 'runId' | 'goal' | 'state' | 'createdAt'>[]
  e2eState: string
}

export interface ContextHubServiceOptions {
  writer?: ConfigWriter
  templatesRoot?: string
  listMemories?: (space: ContextSpaceMatrix) => MemoryEntry[]
  statusSnapshot?: (space: ContextSpaceMatrix) => ContextStatusSnapshot | Promise<ContextStatusSnapshot>
}

const TEMPLATE_FILES: Record<ContextTemplateInput['kind'], string> = {
  claude: 'CLAUDE.md',
  agents: 'AGENTS.md',
  status: 'STATUS.md'
}

const MANAGED_KINDS = new Set<ContextSharedBlockInput['kind']>([
  'claude',
  'agents',
  'gemini',
  'status',
  'readme'
])

function occurrences(content: string, marker: string): number {
  return content.split(marker).length - 1
}

function normalizedDocument(content: string): string {
  return content.replace(/\r\n/g, '\n').replace(/\s*$/, '\n')
}

interface ManagedRange {
  openMarker: string
  start: number
  end: number
}

function sharedBlockRanges(source: string): ManagedRange[] {
  const openPattern = /<!-- morz:block:[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])? -->/g
  const closeMarker = '<!-- /morz:block -->'
  const ranges: ManagedRange[] = []
  let cursor = 0
  while (cursor < source.length) {
    openPattern.lastIndex = cursor
    const open = openPattern.exec(source)
    const strayClose = source.indexOf(closeMarker, cursor)
    if (!open) {
      if (strayClose >= 0 || source.indexOf('<!-- morz:block:', cursor) >= 0) {
        throw new Error('Managed block markers are malformed')
      }
      break
    }
    if (strayClose >= 0 && strayClose < open.index) {
      throw new Error('Managed block markers are out of order')
    }
    const close = source.indexOf(closeMarker, open.index + open[0].length)
    if (close < 0) throw new Error('Managed block is missing its closing marker')
    openPattern.lastIndex = open.index + open[0].length
    const nested = openPattern.exec(source)
    if (nested && nested.index < close) throw new Error('Managed blocks cannot be nested')
    ranges.push({
      openMarker: open[0],
      start: open.index,
      end: close + closeMarker.length
    })
    cursor = close + closeMarker.length
  }
  return ranges
}

function replaceManagedBlock(
  source: string,
  openMarker: string,
  closeMarker: string,
  body: string
): string {
  // An empty body is the marker pair alone. Padding it with a blank line makes
  // the "empty block" three lines, which overruns the renderer's line budget.
  const content = body.trim()
  const block = content
    ? `${openMarker}\n${content}\n${closeMarker}`
    : `${openMarker}\n${closeMarker}`
  if (openMarker.startsWith('<!-- morz:block:')) {
    const matches = sharedBlockRanges(source).filter((range) => range.openMarker === openMarker)
    if (matches.length > 1) throw new Error('Managed block marker is duplicated')
    if (matches.length === 0) {
      const prefix = source.trimEnd()
      return `${prefix}${prefix ? '\n\n' : ''}${block}\n`
    }
    const [match] = matches
    return `${source.slice(0, match.start)}${block}${source.slice(match.end)}`
  }

  const openCount = occurrences(source, openMarker)
  const closeCount = occurrences(source, closeMarker)
  if (openCount !== closeCount || openCount > 1) {
    throw new Error('Managed block markers are malformed or duplicated')
  }
  if (openCount === 0) {
    const prefix = source.trimEnd()
    return `${prefix}${prefix ? '\n\n' : ''}${block}\n`
  }
  const start = source.indexOf(openMarker)
  const end = source.indexOf(closeMarker, start + openMarker.length)
  if (end < start) throw new Error('Managed block markers are out of order')
  return `${source.slice(0, start)}${block}${source.slice(end + closeMarker.length)}`
}

function safeMemoryText(value: string): string {
  return value
    .replace(/<!--\s*\/?morz:/gi, (marker) => marker.replace('<!--', '&lt;!--'))
}

const MEMORY_OPEN_MARKER = '<!-- morz:memory -->'
const MEMORY_CLOSE_MARKER = '<!-- /morz:memory -->'
/*
 * w17/context-blocks — a user who writes `<!-- morz:memory read-only -->` owns
 * that block: Morz reads it, never rewrites it. The lock lives in the file
 * itself so it survives a reinstall and is visible where the block is.
 */
const MEMORY_READ_ONLY_MARKER = /<!--\s*morz:memory\s+read-only\s*-->/i

function assertMemoryBlockWritable(source: string, label: string): void {
  if (MEMORY_READ_ONLY_MARKER.test(source)) {
    throw new Error(
      `${label} has a read-only Morz memory block — replace its marker with ${MEMORY_OPEN_MARKER} to let Morz manage it`
    )
  }
}

function validateMemoryKinds(value: unknown): ContextMemoryKind[] {
  if (value === undefined) return ['claude']
  if (!Array.isArray(value) || value.length === 0) throw new Error('Memory target files are invalid')
  const kinds = value.map((kind) => {
    if (!CONTEXT_MEMORY_KINDS.includes(kind as ContextMemoryKind)) {
      throw new Error('Memory target files are invalid')
    }
    return kind as ContextMemoryKind
  })
  return CONTEXT_MEMORY_KINDS.filter((kind) => kinds.includes(kind))
}

function renderStatus(snapshot: ContextStatusSnapshot): string {
  const branch = escapeMorzMarkers(snapshot.branch).trim() || '(detached or unavailable)'
  const runs = snapshot.recentRuns.slice(0, 5)
  return [
    '## Morz status',
    '',
    `- Branch: \`${branch.replaceAll('`', '\\`')}\``,
    `- E2E: ${escapeMorzMarkers(snapshot.e2eState).trim() || 'No recorded E2E run'}`,
    '',
    '### Recent Morz runs',
    '',
    ...(runs.length > 0
      ? runs.map((run) =>
          `- ${run.createdAt.slice(0, 10)} · ${run.state} · ${escapeMorzMarkers(run.goal).replace(/\s+/g, ' ').trim()}`
        )
      : ['- No recorded runs for this Space.'])
  ].join('\n')
}

function validateSpaceIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 100) {
    throw new Error('Selected spaces are invalid')
  }
  const ids = value.map((id) => validateText(id, 'Space id', 200))
  return [...new Set(ids)]
}

async function readCurrent(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''
    throw error
  }
}

export function createContextHubService(options: ContextHubServiceOptions = {}): ContextHubService {
  const writer = options.writer ?? createConfigWriter()
  const templatesRoot = options.templatesRoot ?? join(process.cwd(), 'resources', 'context-templates')
  const scannedSpaces = new Map<string, ContextSpaceMatrix>()
  const proposals = new Map<string, { space: ContextSpaceMatrix; file: ContextFileState }>()

  const requireSpace = (spaceId: unknown): ContextSpaceMatrix => {
    const id = validateText(spaceId, 'Space id', 200)
    const space = scannedSpaces.get(id)
    if (!space) throw new Error('Space must be scanned before proposing context changes')
    return space
  }

  const requireFile = (space: ContextSpaceMatrix, kind: ContextFileKind): ContextFileState => {
    const file = space.files.find((candidate) => candidate.kind === kind)
    if (!file) throw new Error('Context file kind is unavailable')
    const fromRoot = relative(space.root, file.path)
    if (!fromRoot || fromRoot.startsWith('..') || isAbsolute(fromRoot)) {
      if (!fromRoot) return file
      throw new Error('Context path escaped its scanned space')
    }
    return file
  }

  const wrapProposal = (
    space: ContextSpaceMatrix,
    file: ContextFileState,
    proposal: FileProposal
  ): ContextProposal => {
    proposals.set(proposal.proposalId, { space, file })
    return {
      ...proposal,
      spaceId: space.id,
      spaceName: space.name,
      relativePath: file.relativePath
    }
  }

  const proposeContent = async (
    space: ContextSpaceMatrix,
    file: ContextFileState,
    content: string,
    label: string,
    expectedContent: string
  ): Promise<ContextProposal> => {
    await assertKnownPathSafe(space.root, file.path)
    const proposal = await writer.proposeFile(
      file.path,
      content,
      label,
      expectedContent,
      space.root
    )
    return wrapProposal(space, file, proposal)
  }

  return {
    async scan(inputs): Promise<ContextMatrix> {
      if (!Array.isArray(inputs) || inputs.length > 200) throw new Error('Spaces are invalid')
      const scanned = await Promise.all(inputs.map((space) => scanSpace(space)))
      const uniqueIds = new Set<string>()
      for (const space of scanned) {
        if (uniqueIds.has(space.id)) throw new Error('Space ids must be unique')
        uniqueIds.add(space.id)
      }
      const matrix = {
        scannedAt: new Date().toISOString(),
        spaces: scanned
      }
      scannedSpaces.clear()
      for (const space of scanned) scannedSpaces.set(space.id, space)
      return matrix
    },

    async proposeTemplate(input): Promise<ContextProposal> {
      if (!input || typeof input !== 'object' || !(input.kind in TEMPLATE_FILES)) {
        throw new Error('Template request is invalid')
      }
      const space = requireSpace(input.spaceId)
      const file = requireFile(space, input.kind)
      if (file.state !== 'missing') throw new Error('Templates can only create missing context files')
      const templatePath = join(templatesRoot, space.projectType, TEMPLATE_FILES[input.kind])
      const template = await readFile(templatePath, 'utf8')
      const content = normalizedDocument(template.replaceAll('{{projectName}}', space.name))
      return proposeContent(space, file, content, `${space.name} / ${file.label}`, '')
    },

    async proposeSharedBlock(input): Promise<ContextProposal[]> {
      if (!input || typeof input !== 'object' || !MANAGED_KINDS.has(input.kind)) {
        throw new Error('Shared block request is invalid')
      }
      const name = validateText(input.name, 'Block name', 64)
      if (!/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(name)) {
        throw new Error('Block name must use lowercase letters, numbers, and hyphens')
      }
      const content = validateText(input.content, 'Block content', 100_000)
      if (/<!--\s*\/?morz:/i.test(content)) {
        throw new Error('Block content cannot contain Morz managed markers')
      }
      const selected = validateSpaceIds(input.spaceIds).map(requireSpace)
      return Promise.all(selected.map(async (space) => {
        const file = requireFile(space, input.kind)
        const source = await readCurrent(file.path)
        const next = replaceManagedBlock(
          source,
          `<!-- morz:block:${name} -->`,
          '<!-- /morz:block -->',
          content
        )
        return proposeContent(space, file, next, `${space.name} / ${file.label} / ${name}`, source)
      }))
    },

    /*
     * One proposal per space × target file, batched into one review surface.
     * Every target of a space renders the SAME body from the same selection —
     * a space-scoped fact is one team block, not per-file copies that drift.
     */
    async proposeMemoryBlock(input): Promise<ContextProposal[]> {
      if (!input || typeof input !== 'object') throw new Error('Memory export request is invalid')
      const kinds = validateMemoryKinds(input.kinds)
      const selected = validateSpaceIds(input.spaceIds).map(requireSpace)
      const work = selected.flatMap((space) => {
        const body = renderMemoryBlock(options.listMemories?.(space) ?? [])
        return kinds.map((kind) => ({ space, kind, body }))
      })
      return Promise.all(work.map(async ({ space, kind, body }) => {
        const file = requireFile(space, kind)
        const source = await readCurrent(file.path)
        assertMemoryBlockWritable(source, `${space.name} / ${file.label}`)
        const next = replaceManagedBlock(
          source,
          MEMORY_OPEN_MARKER,
          MEMORY_CLOSE_MARKER,
          body
        )
        return proposeContent(space, file, next, `${space.name} / ${file.label} / memory`, source)
      }))
    },

    async proposeStatusBlock(input): Promise<ContextProposal[]> {
      if (!input || typeof input !== 'object') throw new Error('Status upkeep request is invalid')
      if (!options.statusSnapshot) throw new Error('Status upkeep data is unavailable')
      const selected = validateSpaceIds(input.spaceIds).map(requireSpace)
      return Promise.all(selected.map(async (space) => {
        const file = requireFile(space, 'status')
        const source = await readCurrent(file.path)
        const snapshot = await options.statusSnapshot!(space)
        const next = replaceManagedBlock(
          source,
          '<!-- morz:status -->',
          '<!-- /morz:status -->',
          renderStatus(snapshot)
        )
        return proposeContent(space, file, next, `${space.name} / STATUS.md / Morz status`, source)
      }))
    },

    async applyProposal(proposalId): Promise<ContextApplyResult> {
      const id = validateText(proposalId, 'Proposal id', 200)
      const proposal = proposals.get(id)
      if (!proposal) throw new Error('Context proposal is missing or expired')
      await assertKnownPathSafe(proposal.space.root, proposal.file.path)
      const result = await writer.applyFile(id)
      proposals.delete(id)
      return result
    }
  }
}

let registered = false

export interface RegisterContextHubOptions extends ContextHubServiceOptions {
  isEnabled?: () => boolean | Promise<boolean>
}

function assertTrustedSender(event: IpcMainInvokeEvent): void {
  if (!event.senderFrame || event.senderFrame !== event.sender.mainFrame) {
    throw new Error('Context Hub rejected an untrusted frame')
  }
  const url = new URL(event.senderFrame.url)
  const localDev =
    (url.protocol === 'http:' || url.protocol === 'https:') &&
    (url.hostname === 'localhost' || url.hostname === '127.0.0.1')
  if (url.protocol !== 'file:' && !localDev) {
    throw new Error('Context Hub rejected an untrusted renderer origin')
  }
}

export function registerContextHubIpc(
  ipcMain: IpcMain,
  options: RegisterContextHubOptions = {}
): void {
  if (registered) return
  const services = new Map<number, ContextHubService>()
  let scans = 0

  const serviceFor = async (event: IpcMainInvokeEvent): Promise<ContextHubService> => {
    assertTrustedSender(event)
    if (!(await (options.isEnabled?.() ?? false))) {
      throw new Error('Context module is disabled')
    }
    let service = services.get(event.sender.id)
    if (!service) {
      service = createContextHubService(options)
      services.set(event.sender.id, service)
      event.sender.once('destroyed', () => services.delete(event.sender.id))
    }
    return service
  }

  ipcMain.handle(ContextHubApi.scan, async (event, spaces: ContextSpaceInput[]) => {
    const service = await serviceFor(event)
    scans += 1
    return service.scan(spaces)
  })
  ipcMain.handle(ContextHubApi.proposeTemplate, async (event, input: ContextTemplateInput) =>
    (await serviceFor(event)).proposeTemplate(input)
  )
  ipcMain.handle(ContextHubApi.proposeSharedBlock, async (event, input: ContextSharedBlockInput) =>
    (await serviceFor(event)).proposeSharedBlock(input)
  )
  ipcMain.handle(ContextHubApi.proposeMemoryBlock, async (event, input: ContextMemoryBlockInput) =>
    (await serviceFor(event)).proposeMemoryBlock(input)
  )
  ipcMain.handle(ContextHubApi.proposeStatusBlock, async (event, input: ContextStatusBlockInput) =>
    (await serviceFor(event)).proposeStatusBlock(input)
  )
  ipcMain.handle(ContextHubApi.applyProposal, async (event, proposalId: string) =>
    (await serviceFor(event)).applyProposal(proposalId)
  )
  if (process.env.MORZ_E2E === '1') {
    ipcMain.handle(ContextHubApi.testStats, () => ({ scans }))
  }
  registered = true
}
