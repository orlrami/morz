import { execFile } from 'child_process'
import { createHash, randomBytes } from 'crypto'
import { lstat, mkdir, mkdtemp, readdir, realpath, rename, rm, writeFile } from 'fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'path'
import { tmpdir } from 'os'
import { promisify } from 'util'
import {
  consumeProposal,
  getApprovedProposal,
  type OrganizerOperation,
  type OrganizerPlan
} from './propose'
import { resolveOrganizerRoot } from './rules'

const execFileAsync = promisify(execFile)
const activeApplies = new Set<string>()
const nullDevice = process.platform === 'win32' ? 'NUL' : '/dev/null'

export interface OrganizerApplyResult {
  runTag: string
  branch: string
  commit: string
  worktreePath: string
  journalPath: string
  diff: string
}

interface OrganizerJournal {
  runTag: string
  root: string
  planHash: string
  branch: string
  baseCommit: string
  worktreePath: string
  status: 'starting' | 'applying' | 'committed' | 'failed'
  operations: OrganizerOperation[]
  commit?: string
  diff?: string
  error?: string
}

interface GitIndexEntry {
  mode: string
  hash: string
}

/*
 * The hardened env below neutralizes the user's global/system git config
 * (hook, filter, and fsmonitor attack surface) — but that also drops
 * core.autocrlf/core.eol, silently changing EOL semantics: on a Windows
 * autocrlf=true repo every CRLF-checked-out file reads as "modified" once its
 * stat cache is cold, and the clean-worktree gate refuses to apply. Capture
 * the user's EFFECTIVE eol settings once and re-inject them explicitly.
 * (`git config --get` never runs filters/hooks — safe to call unhardened.)
 */
let eolConfigArgs: string[] | null = null
async function effectiveEolConfig(cwd: string): Promise<string[]> {
  if (eolConfigArgs) return eolConfigArgs
  const read = async (key: string): Promise<string | null> => {
    try {
      const { stdout } = await execFileAsync('git', ['config', '--get', key], {
        cwd,
        windowsHide: true,
        encoding: 'utf8'
      })
      return stdout.trim() || null
    } catch {
      return null // unset
    }
  }
  const args: string[] = []
  const autocrlf = await read('core.autocrlf')
  if (autocrlf) args.push('-c', `core.autocrlf=${autocrlf}`)
  const eol = await read('core.eol')
  if (eol) args.push('-c', `core.eol=${eol}`)
  eolConfigArgs = args
  return args
}

async function git(cwd: string, args: string[], hooksPath: string): Promise<string> {
  try {
    const safeArgs = [
      '-c', `core.hooksPath=${hooksPath}`,
      '-c', 'core.fsmonitor=false',
      '-c', `core.attributesFile=${nullDevice}`,
      '-c', 'commit.gpgSign=false',
      ...(await effectiveEolConfig(cwd)),
      ...args
    ]
    const { stdout } = await execFileAsync('git', safeArgs, {
      cwd,
      windowsHide: true,
      encoding: 'utf8',
      maxBuffer: 20 * 1024 * 1024,
      env: {
        ...process.env,
        GIT_ATTR_NOSYSTEM: '1',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: nullDevice,
        GIT_TERMINAL_PROMPT: '0'
      }
    })
    return stdout.trim()
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr?.trim()
    throw new Error(`git ${args[0]} failed${stderr ? `: ${stderr}` : ''}`)
  }
}

function parseTreeEntries(output: string): Map<string, GitIndexEntry> {
  const entries = new Map<string, GitIndexEntry>()
  for (const record of output.split('\0').filter(Boolean)) {
    const tab = record.indexOf('\t')
    if (tab < 0) throw new Error('Git returned an invalid tree entry')
    const [mode, _type, hash] = record.slice(0, tab).split(' ')
    entries.set(record.slice(tab + 1), { mode, hash })
  }
  return entries
}

function parseIndexEntries(output: string): Map<string, GitIndexEntry> {
  const entries = new Map<string, GitIndexEntry>()
  for (const record of output.split('\0').filter(Boolean)) {
    const tab = record.indexOf('\t')
    if (tab < 0) throw new Error('Git returned an invalid index entry')
    const [mode, hash, stage] = record.slice(0, tab).split(' ')
    if (stage !== '0') throw new Error('Organizer apply cannot commit an unmerged Git index')
    entries.set(record.slice(tab + 1), { mode, hash })
  }
  return entries
}

function assertSameIndex(
  actual: Map<string, GitIndexEntry>,
  expected: Map<string, GitIndexEntry>
): void {
  if (actual.size !== expected.size) throw new Error('Organizer staged tree does not match the hashed plan')
  for (const [path, entry] of expected) {
    const staged = actual.get(path)
    if (!staged || staged.mode !== entry.mode || staged.hash !== entry.hash) {
      throw new Error(`Organizer staged tree differs from the hashed plan at ${path}`)
    }
  }
}

function hashGitBlob(content: string, objectFormat: string): string {
  if (objectFormat !== 'sha1' && objectFormat !== 'sha256') {
    throw new Error(`Unsupported Git object format: ${objectFormat}`)
  }
  const bytes = Buffer.from(content, 'utf8')
  return createHash(objectFormat).update(`blob ${bytes.length}\0`).update(bytes).digest('hex')
}

async function expectedIndex(
  root: string,
  baseCommit: string,
  operations: OrganizerOperation[],
  hooksPath: string
): Promise<Map<string, GitIndexEntry>> {
  const expected = parseTreeEntries(await git(root, ['ls-tree', '-r', '-z', baseCommit], hooksPath))
  const objectFormat = await git(root, ['rev-parse', '--show-object-format'], hooksPath)
  for (const operation of operations) {
    if (operation.kind === 'move') {
      const source = expected.get(operation.from)
      if (!source) throw new Error(`Organizer move source is not tracked at the approved commit: ${operation.from}`)
      expected.delete(operation.from)
      expected.set(operation.to, source)
    } else {
      if (expected.has(operation.to)) throw new Error(`Organizer create target already exists at the approved commit: ${operation.to}`)
      expected.set(operation.to, { mode: '100644', hash: hashGitBlob(operation.content, objectFormat) })
    }
  }
  return expected
}

async function assertNoGitFilters(root: string, paths: string[], hooksPath: string): Promise<void> {
  for (let offset = 0; offset < paths.length; offset += 200) {
    const output = await git(
      root,
      ['check-attr', '-z', 'filter', '--', ...paths.slice(offset, offset + 200)],
      hooksPath
    )
    const fields = output.split('\0').filter(Boolean)
    for (let index = 0; index < fields.length; index += 3) {
      const [path, attribute, value] = fields.slice(index, index + 3)
      if (attribute !== 'filter' || (value !== 'unspecified' && value !== 'unset')) {
        throw new Error(`Organizer apply refuses Git filters on ${path}; approved bytes must remain deterministic.`)
      }
    }
  }
}

function isInside(root: string, candidate: string): boolean {
  const projectRelative = relative(root, candidate)
  return projectRelative === '' || (!projectRelative.startsWith(`..${sep}`) && projectRelative !== '..' && !isAbsolute(projectRelative))
}

function resolveOperationPath(root: string, projectPath: string): string {
  if (typeof projectPath !== 'string' || projectPath === '' || projectPath.includes('\0') || isAbsolute(projectPath)) {
    throw new Error(`Unsafe Organizer operation path: ${String(projectPath)}`)
  }
  const parts = projectPath.split('/')
  if (parts.some((part) => part === '' || part === '.' || part === '..' || part.includes('\\'))) {
    throw new Error(`Unsafe Organizer operation path: ${projectPath}`)
  }
  const target = resolve(root, ...parts)
  if (!isInside(root, target)) throw new Error(`Organizer operation escapes worktree: ${projectPath}`)
  return target
}

async function assertSafeParent(root: string, target: string): Promise<void> {
  let current = dirname(target)
  for (;;) {
    try {
      const actual = await realpath(current)
      if (!isInside(root, actual)) throw new Error(`Organizer operation follows a link outside its worktree: ${target}`)
      return
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      const parent = dirname(current)
      if (parent === current) throw new Error(`Cannot resolve Organizer operation parent: ${target}`)
      current = parent
    }
  }
}

async function assertMissing(path: string): Promise<void> {
  try {
    await lstat(path)
    throw new Error(`Organizer target already exists: ${path}`)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

async function applyOperation(root: string, operation: OrganizerOperation): Promise<void> {
  const target = resolveOperationPath(root, operation.to)
  await assertSafeParent(root, target)
  await mkdir(dirname(target), { recursive: true })
  if (operation.kind === 'move') {
    const source = resolveOperationPath(root, operation.from)
    await assertSafeParent(root, source)
    await lstat(source)
    const caseOnlyRename = source !== target && source.toLowerCase() === target.toLowerCase()
    if (caseOnlyRename) {
      const temporary = `${source}.morz-${randomBytes(6).toString('hex')}`
      await assertMissing(temporary)
      await rename(source, temporary)
      await rename(temporary, target)
    } else {
      await assertMissing(target)
      await rename(source, target)
    }
  } else {
    await assertMissing(target)
    await writeFile(target, operation.content, { encoding: 'utf8', flag: 'wx' })
  }
}

async function writeJournal(path: string, journal: OrganizerJournal): Promise<void> {
  const temporary = `${path}.tmp`
  await writeFile(temporary, `${JSON.stringify(journal, null, 2)}\n`, 'utf8')
  await rename(temporary, path)
}

async function cleanupFailedWorktree(
  root: string,
  worktreePath: string,
  branch: string,
  hooksPath: string
): Promise<void> {
  try {
    await git(root, ['worktree', 'remove', '--force', worktreePath], hooksPath)
  } catch {
    await rm(worktreePath, { recursive: true, force: true }).catch(() => undefined)
  }
  await git(root, ['branch', '-D', branch], hooksPath).catch(() => undefined)
}

export async function organizerApply(
  inputRoot: string,
  planHash: string
): Promise<OrganizerApplyResult> {
  const root = await resolveOrganizerRoot(inputRoot)
  if (activeApplies.has(root)) throw new Error('An Organizer apply is already in progress for this root.')
  activeApplies.add(root)
  try {
    const plan = getApprovedProposal(root, planHash)
    if (!plan.baseCommit) throw new Error('Organizer apply requires a Git repository proposal.')
    const runTag = `organizer-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${randomBytes(4).toString('hex')}`
    const runDirectory = await mkdtemp(join(tmpdir(), `${runTag}-`))
    const hooksPath = join(runDirectory, 'empty-hooks')
    await mkdir(hooksPath)
    const hooksMetadata = await lstat(hooksPath)
    if (!hooksMetadata.isDirectory() || hooksMetadata.isSymbolicLink() || (await readdir(hooksPath)).length !== 0) {
      throw new Error('Organizer could not create a private empty hooks directory.')
    }
    try {
      return await applyApprovedProposal(root, plan, runTag, runDirectory, hooksPath)
    } finally {
      await rm(hooksPath, { recursive: true, force: true }).catch(() => undefined)
    }
  } finally {
    activeApplies.delete(root)
  }
}

async function applyApprovedProposal(
  root: string,
  plan: OrganizerPlan,
  runTag: string,
  runDirectory: string,
  hooksPath: string
): Promise<OrganizerApplyResult> {
  const branch = `morz-organizer/${runTag}`
  const worktreePath = join(runDirectory, 'worktree')
  const journalPath = join(runDirectory, 'journal.json')
  const journal: OrganizerJournal = {
    runTag,
    root,
    planHash: plan.planHash,
    branch,
    baseCommit: plan.baseCommit!,
    worktreePath,
    status: 'starting',
    operations: plan.operations
  }
  await writeJournal(journalPath, journal)

  let createdWorktree = false
  try {
    const baseCommit = plan.baseCommit!
    const topLevel = await realpath(await git(root, ['rev-parse', '--show-toplevel'], hooksPath))
    if (topLevel !== root) throw new Error('Organizer apply root must be the Git repository top level.')
    const currentCommit = await git(root, ['rev-parse', 'HEAD'], hooksPath)
    if (currentCommit !== baseCommit) throw new Error('Organizer proposal base commit is stale; propose again.')

    const expected = await expectedIndex(root, baseCommit, plan.operations, hooksPath)
    const expectedTree = [...expected.keys()].sort()
    if (JSON.stringify(expectedTree) !== JSON.stringify(plan.afterTree)) {
      throw new Error('Organizer Git tree does not match the hashed after-tree.')
    }
    const filterPaths = new Set<string>(expected.keys())
    for (const operation of plan.operations) {
      filterPaths.add(operation.to)
      if (operation.kind === 'move') filterPaths.add(operation.from)
    }
    await assertNoGitFilters(root, [...filterPaths], hooksPath)

    const status = await git(root, ['status', '--porcelain', '--untracked-files=all'], hooksPath)
    if (status !== '')
      throw new Error(
        `Organizer apply requires a clean live worktree; no files were changed. Dirty: ${status.slice(0, 200)}`
      )

    await git(root, ['worktree', 'add', '-b', branch, worktreePath, baseCommit], hooksPath)
    createdWorktree = true
    journal.status = 'applying'
    await writeJournal(journalPath, journal)
    for (const operation of plan.operations) await applyOperation(worktreePath, operation)

    const removedPaths = plan.operations.flatMap((operation) =>
      operation.kind === 'move' ? [operation.from] : []
    )
    const targetPaths = [...new Set(plan.operations.map((operation) => operation.to))]
    if (removedPaths.length > 0) {
      await git(worktreePath, ['update-index', '--force-remove', '--', ...removedPaths], hooksPath)
    }
    await git(worktreePath, ['add', '--', ...targetPaths], hooksPath)
    const staged = parseIndexEntries(await git(worktreePath, ['ls-files', '-s', '-z'], hooksPath))
    assertSameIndex(staged, expected)
    const diff = await git(worktreePath, [
      'diff', '--cached', '--binary', '--no-ext-diff', '--no-textconv', baseCommit, '--'
    ], hooksPath)
    if (diff === '') throw new Error('Organizer proposal produced no staged diff.')
    await git(worktreePath, [
      '-c', 'user.name=Morz Organizer',
      '-c', 'user.email=organizer@morz.invalid',
      'commit', '-m', `chore(organizer): apply plan ${plan.planHash.slice(0, 12)}`
    ], hooksPath)
    const commit = await git(worktreePath, ['rev-parse', 'HEAD'], hooksPath)
    const parent = await git(worktreePath, ['rev-parse', 'HEAD^'], hooksPath)
    if (parent !== baseCommit) throw new Error('Organizer commit is not based on the approved commit.')
    const committed = parseTreeEntries(await git(worktreePath, ['ls-tree', '-r', '-z', commit], hooksPath))
    assertSameIndex(committed, expected)
    const finalStatus = await git(
      worktreePath,
      ['status', '--porcelain', '--untracked-files=all'],
      hooksPath
    )
    if (finalStatus !== '') throw new Error('Organizer worktree is not clean after its sandbox commit.')
    journal.status = 'committed'
    journal.commit = commit
    journal.diff = diff
    await writeJournal(journalPath, journal)
    consumeProposal(root, plan.planHash)
    return { runTag, branch, commit, worktreePath, journalPath, diff }
  } catch (error) {
    journal.status = 'failed'
    journal.error = (error as Error).message
    await writeJournal(journalPath, journal).catch(() => undefined)
    if (createdWorktree) await cleanupFailedWorktree(root, worktreePath, branch, hooksPath)
    throw error
  }
}
