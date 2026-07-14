import { execFile } from 'child_process'
import { createHash } from 'crypto'
import { readFile } from 'fs/promises'
import { promisify } from 'util'
import { basename, dirname, extname, join, posix } from 'path'
import { organizerAudit, listTree } from './audit'
import { resolveOrganizerRoot, resolveRules } from './rules'

const execFileAsync = promisify(execFile)

export type OrganizerInverseOperation =
  | { kind: 'move'; from: string; to: string }
  | { kind: 'delete'; to: string }

export type OrganizerOperation =
  | { kind: 'move'; from: string; to: string; inverse: OrganizerInverseOperation }
  | { kind: 'create'; to: string; content: string; inverse: OrganizerInverseOperation }

export interface OrganizerPlan {
  version: 1
  root: string
  baseCommit: string | null
  operations: OrganizerOperation[]
  beforeTree: string[]
  afterTree: string[]
  planHash: string
}

const lastProposals = new Map<string, OrganizerPlan>()

function kebabSourcePath(path: string): string {
  const name = basename(path)
  const extension = extname(name)
  let stem = name.slice(0, -extension.length)
  let suffix = ''
  for (const candidate of ['.test', '.spec', '.d']) {
    if (stem.endsWith(candidate)) {
      stem = stem.slice(0, -candidate.length)
      suffix = candidate
      break
    }
  }
  const kebab = stem
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
  return posix.join(dirname(path).split('\\').join('/'), `${kebab}${suffix}${extension}`)
}

function createOperation(to: string, content: string): OrganizerOperation {
  return { kind: 'create', to, content, inverse: { kind: 'delete', to } }
}

function buildOperations(
  violations: Awaited<ReturnType<typeof organizerAudit>>,
  beforeTree: string[],
  referencedSources: Set<string>,
  allowNamingMoves: boolean
): OrganizerOperation[] {
  const operations: OrganizerOperation[] = []
  const occupied = new Set(beforeTree)
  const targets = new Set<string>()
  const add = (operation: OrganizerOperation): void => {
    if (targets.has(operation.to)) return
    targets.add(operation.to)
    operations.push(operation)
  }

  for (const violation of violations) {
    if (violation.rule === 'required-file/readme') {
      add(createOperation('README.md', '# Project\n\nDescribe the project, setup, usage, and support paths here.\n'))
    } else if (violation.rule === 'required-file/gitignore') {
      add(createOperation('.gitignore', 'node_modules/\nout/\ndist/\nbuild/\n.env\n.env.*\n'))
    } else if (violation.rule === 'docs/diataxis') {
      const bucket = violation.path.replace(/^docs\//, '')
      const title = `${bucket.charAt(0).toUpperCase()}${bucket.slice(1)}`
      add(createOperation(
        `docs/${bucket}/README.md`,
        `# ${title}\n\nAdd ${bucket} documentation here.\n`
      ))
    } else if (violation.rule === 'adr/madr-log') {
      add(createOperation(
        'docs/decisions/README.md',
        '# Architecture decisions\n\nRecord decisions as `NNNN-title.md` using the MADR template.\n'
      ))
    } else if (violation.rule === 'naming/kebab-case') {
      if (!allowNamingMoves) continue
      if (!occupied.has(violation.path)) continue
      if (referencedSources.has(violation.path)) continue
      const to = kebabSourcePath(violation.path)
      if (to !== violation.path && !occupied.has(to) && !targets.has(to)) {
        occupied.delete(violation.path)
        occupied.add(to)
        add({
          kind: 'move',
          from: violation.path,
          to,
          inverse: { kind: 'move', from: to, to: violation.path }
        })
      }
    }
  }
  return operations.sort((left, right) => left.to.localeCompare(right.to))
}

async function readProposalFile(root: string, path: string, baseCommit: string | null): Promise<string> {
  if (!baseCommit) return readFile(join(root, ...path.split('/')), 'utf8')
  const { stdout } = await execFileAsync('git', ['show', `${baseCommit}:${path}`], {
    cwd: root,
    windowsHide: true,
    encoding: 'utf8',
    maxBuffer: 5 * 1024 * 1024
  })
  return stdout
}

async function findReferencedSources(
  root: string,
  tree: string[],
  baseCommit: string | null
): Promise<Set<string>> {
  const sourcePaths = tree.filter((path) => /\.(?:[cm]?[jt]sx?)$/i.test(path))
  const searchablePaths = tree.filter((path) =>
    /\.(?:[cm]?[jt]sx?|jsonc?|ya?ml|toml|md|vue|svelte|astro)$/i.test(path) ||
    /(?:^|\/)(?:Dockerfile|Makefile)$/i.test(path)
  )
  const contents = await Promise.all(searchablePaths.map(async (path) => ({
    path,
    content: await readProposalFile(root, path, baseCommit)
  })))
  const referenced = new Set<string>()
  for (const candidate of sourcePaths) {
    const filename = basename(candidate)
    const stem = filename.slice(0, -extname(filename).length)
    const lowerFilename = filename.toLowerCase()
    const lowerStem = stem.toLowerCase()
    if (contents.some((source) => source.path !== candidate &&
      (source.content.toLowerCase().includes(lowerFilename) ||
        source.content.toLowerCase().includes(lowerStem)))) {
      referenced.add(candidate)
    }
  }
  return referenced
}

function simulateTree(beforeTree: string[], operations: OrganizerOperation[]): string[] {
  const after = new Set(beforeTree)
  for (const operation of operations) {
    if (operation.kind === 'move') after.delete(operation.from)
    after.add(operation.to)
  }
  return [...after].sort()
}

async function findBaseCommit(root: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], {
      cwd: root,
      windowsHide: true,
      encoding: 'utf8'
    })
    return stdout.trim()
  } catch {
    return null
  }
}

async function listGitTree(root: string, commit: string): Promise<string[]> {
  const { stdout } = await execFileAsync('git', ['ls-tree', '-r', '--name-only', '-z', commit], {
    cwd: root,
    windowsHide: true,
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024
  })
  return stdout.split('\0').filter(Boolean).sort()
}

function hashPlan(plan: Omit<OrganizerPlan, 'planHash'>): string {
  return createHash('sha256').update(JSON.stringify(plan)).digest('hex')
}

export async function organizerPropose(inputRoot: string): Promise<OrganizerPlan> {
  const root = await resolveOrganizerRoot(inputRoot)
  const [violations, baseCommit, rules] = await Promise.all([
    organizerAudit(root),
    findBaseCommit(root),
    resolveRules(root)
  ])
  const beforeTree = baseCommit ? await listGitTree(root, baseCommit) : await listTree(root)
  const referencedSources = await findReferencedSources(root, beforeTree, baseCommit)
  const allowNamingMoves = rules.some((rule) =>
    rule.id === 'naming/kebab-case' && rule.enabled && rule.autoFix
  )
  const operations = buildOperations(violations, beforeTree, referencedSources, allowNamingMoves)
  const unsigned: Omit<OrganizerPlan, 'planHash'> = {
    version: 1,
    root,
    baseCommit,
    operations,
    beforeTree,
    afterTree: simulateTree(beforeTree, operations)
  }
  const plan = { ...unsigned, planHash: hashPlan(unsigned) }
  lastProposals.set(root, plan)
  return plan
}

export function getApprovedProposal(root: string, planHash: string): OrganizerPlan {
  const plan = lastProposals.get(root)
  if (!plan) throw new Error('No active Organizer proposal exists for this root.')
  if (!/^[a-f0-9]{64}$/.test(planHash) || plan.planHash !== planHash) {
    throw new Error('Organizer plan hash does not match the last proposal.')
  }
  const { planHash: _storedHash, ...unsigned } = plan
  if (hashPlan(unsigned) !== planHash) throw new Error('Stored Organizer proposal failed hash verification.')
  return plan
}

export function consumeProposal(root: string, planHash: string): void {
  const plan = lastProposals.get(root)
  if (plan?.planHash === planHash) lastProposals.delete(root)
}
