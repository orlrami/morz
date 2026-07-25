import { createHash, randomUUID } from 'node:crypto'
import {
  copyFile,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  stat,
  unlink
} from 'node:fs/promises'
import { constants, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import type { IpcMain } from 'electron'
import { createTwoFilesPatch } from 'diff'
import { applyEdits, modify, parse as parseJsonc, type ParseError } from 'jsonc-parser'
import { parse as parseToml, stringify as stringifyToml, type TomlTable } from 'smol-toml'
import { ConfigWriterApi } from '../../shared/ipc'
// w15/model-choice — persistent model default proposals ride the same
// diff-first machinery (stableRead → proposal → mtime-guarded apply).
import { isSafeModelId } from '../../shared/model-choice'

export type ConfigTarget = 'claude' | 'codex' | 'opencode'
export type ConfigWriterPaths = Record<ConfigTarget, string>

export interface InstallSpec {
  name: string
  command: string
  args: string[]
  env: Record<string, string>
}

export interface DetectedConfig {
  target: ConfigTarget
  path: string
}

export interface ConfigProposal {
  proposalId: string
  hash: string
  target: ConfigTarget
  path: string
  unifiedDiff: string
}

export interface ApplyResult {
  target: ConfigTarget
  path: string
  backupPath: string
}

export interface FileProposal {
  proposalId: string
  hash: string
  path: string
  label: string
  unifiedDiff: string
}

export interface FileApplyResult {
  path: string
  backupPath: string | null
  created: boolean
}

export type ConfigWriterErrorCode =
  | 'CONFIG_CHANGED'
  | 'CONFIG_INVALID'
  | 'CONFIG_NOT_FOUND'
  | 'INVALID_INSTALL_SPEC'
  | 'PROPOSAL_NOT_FOUND'

export class ConfigWriterError extends Error {
  constructor(
    public readonly code: ConfigWriterErrorCode,
    message: string
  ) {
    super(message)
    this.name = 'ConfigWriterError'
  }
}

interface StoredProposal extends ConfigProposal {
  oldContent: string
  newContent: string
  oldHash: string
  mtimeMs: number
}

interface StableFile {
  content: string
  mtimeMs: number
  hash: string
}

interface StoredFileProposal extends FileProposal {
  oldContent: string
  newContent: string
  oldHash: string
  mtimeMs: number
  existed: boolean
  root: string | null
}

interface ConfigWriterOptions {
  paths?: ConfigWriterPaths
  /** w15/model-choice — where each CLI's MODEL default lives (claude's model
   * key is in ~/.claude/settings.json, not the MCP file). Test override. */
  modelPaths?: ConfigWriterPaths
  projectDir?: string
  homeDir?: string
  appDataDir?: string
  now?: () => Date
}

export interface ConfigWriter {
  detect(): Promise<DetectedConfig[]>
  propose(spec: InstallSpec, targets: ConfigTarget[]): Promise<ConfigProposal[]>
  /** w15/model-choice — diff-first proposal setting the CLI's persistent
   * default model key. NEVER writes; apply() is the only write path. */
  proposeModel(target: ConfigTarget, model: string): Promise<ConfigProposal>
  apply(proposalId: string): Promise<ApplyResult>
  proposeFile(
    path: string,
    newContent: string,
    label: string,
    expectedContent?: string,
    root?: string
  ): Promise<FileProposal>
  applyFile(proposalId: string): Promise<FileApplyResult>
}

const TARGETS: ConfigTarget[] = ['claude', 'codex', 'opencode']
const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor'])
const MAX_PROPOSALS = 100

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function firstExisting(candidates: string[]): string {
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0]
}

/** w15/model-choice — MORZ_CONFIG_HOME lets the e2e suite point every config
 * path at a fixture directory instead of the developer's real home. */
function resolveHomeDir(options: ConfigWriterOptions): string {
  return options.homeDir ?? process.env.MORZ_CONFIG_HOME ?? homedir()
}

function defaultPaths(options: ConfigWriterOptions): ConfigWriterPaths {
  const projectDir = options.projectDir ?? process.cwd()
  const homeDir = resolveHomeDir(options)
  const appDataDir = options.appDataDir ?? process.env.APPDATA ?? join(homeDir, 'AppData', 'Roaming')
  const explicitOpenCode = process.env.OPENCODE_CONFIG

  return {
    claude: firstExisting([join(projectDir, '.mcp.json'), join(homeDir, '.claude.json')]),
    codex: join(homeDir, '.codex', 'config.toml'),
    opencode: firstExisting([
      ...(explicitOpenCode ? [explicitOpenCode] : []),
      join(projectDir, 'opencode.json'),
      join(projectDir, 'opencode.jsonc'),
      join(homeDir, '.config', 'opencode', 'opencode.json'),
      join(appDataDir, 'opencode', 'opencode.json')
    ])
  }
}

function validateInstallSpec(value: InstallSpec): InstallSpec {
  if (!value || typeof value !== 'object') {
    throw new ConfigWriterError('INVALID_INSTALL_SPEC', 'Install spec must be an object')
  }
  if (
    typeof value.name !== 'string' ||
    value.name.trim().length === 0 ||
    value.name.length > 128 ||
    FORBIDDEN_KEYS.has(value.name)
  ) {
    throw new ConfigWriterError('INVALID_INSTALL_SPEC', 'Server name is invalid')
  }
  if (typeof value.command !== 'string' || value.command.trim().length === 0 || value.command.length > 4096) {
    throw new ConfigWriterError('INVALID_INSTALL_SPEC', 'Command is invalid')
  }
  if (!Array.isArray(value.args) || value.args.some((arg) => typeof arg !== 'string' || arg.length > 16_384)) {
    throw new ConfigWriterError('INVALID_INSTALL_SPEC', 'Arguments must be strings')
  }
  if (!value.env || typeof value.env !== 'object' || Array.isArray(value.env)) {
    throw new ConfigWriterError('INVALID_INSTALL_SPEC', 'Environment must be a string map')
  }
  for (const [key, envValue] of Object.entries(value.env)) {
    if (!key || FORBIDDEN_KEYS.has(key) || typeof envValue !== 'string' || envValue.length > 65_536) {
      throw new ConfigWriterError('INVALID_INSTALL_SPEC', 'Environment contains an invalid entry')
    }
  }
  return {
    name: value.name,
    command: value.command,
    args: [...value.args],
    env: { ...value.env }
  }
}

function parseJsonConfig(content: string, path: string): unknown {
  const errors: ParseError[] = []
  const parsed = parseJsonc(content, errors, { allowTrailingComma: true, disallowComments: false })
  if (errors.length > 0 || !parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ConfigWriterError('CONFIG_INVALID', `Cannot parse config: ${path}`)
  }
  return parsed
}

function formattingOptions(content: string): { insertSpaces: boolean; tabSize: number; eol: string } {
  const eol = content.includes('\r\n') ? '\r\n' : '\n'
  const indented = content.split(/\r?\n/).find((line) => /^\s+["}]/.test(line))
  const whitespace = indented?.match(/^\s+/)?.[0] ?? '  '
  return whitespace.includes('\t')
    ? { insertSpaces: false, tabSize: 1, eol }
    : { insertSpaces: true, tabSize: Math.max(1, whitespace.length), eol }
}

function jsonMerge(
  content: string,
  path: string,
  property: 'mcpServers' | 'mcp',
  name: string,
  entry: Record<string, unknown>
): string {
  const parsed = parseJsonConfig(content, path) as Record<string, unknown>
  const container = parsed[property]
  if (container !== undefined && (typeof container !== 'object' || container === null || Array.isArray(container))) {
    throw new ConfigWriterError('CONFIG_INVALID', `${property} is not an object: ${path}`)
  }
  return applyEdits(
    content,
    modify(content, [property, name], entry, {
      formattingOptions: formattingOptions(content),
      getInsertionIndex: undefined,
      isArrayInsertion: false
    })
  )
}

function mergeConfig(target: ConfigTarget, path: string, content: string, spec: InstallSpec): string {
  if (target === 'claude') {
    return jsonMerge(content, path, 'mcpServers', spec.name, {
      command: spec.command,
      args: spec.args,
      env: spec.env
    })
  }

  if (target === 'opencode') {
    return jsonMerge(content, path, 'mcp', spec.name, {
      type: 'local',
      command: [spec.command, ...spec.args],
      enabled: true,
      environment: spec.env
    })
  }

  let parsed: TomlTable
  try {
    parsed = parseToml(content)
  } catch {
    throw new ConfigWriterError('CONFIG_INVALID', `Cannot parse config: ${path}`)
  }
  const servers = parsed.mcp_servers
  if (servers !== undefined && (typeof servers !== 'object' || Array.isArray(servers) || servers === null)) {
    throw new ConfigWriterError('CONFIG_INVALID', `mcp_servers is not a table: ${path}`)
  }
  const mcpServers = (servers ?? {}) as TomlTable
  mcpServers[spec.name] = {
    command: spec.command,
    args: spec.args,
    env: spec.env
  }
  parsed.mcp_servers = mcpServers

  // smol-toml is AST-less: it preserves parsed values and unknown tables, but not comments.
  const eol = content.includes('\r\n') ? '\r\n' : '\n'
  return `${stringifyToml(parsed).replace(/\n/g, eol).replace(new RegExp(`${eol}+$`), '')}${eol}`
}

/* ── w15/model-choice — persistent model-default proposals ── */

function defaultModelPaths(options: ConfigWriterOptions, paths: ConfigWriterPaths): ConfigWriterPaths {
  const homeDir = resolveHomeDir(options)
  return {
    // The model key lives in ~/.claude/settings.json — NOT the MCP file.
    claude: join(homeDir, '.claude', 'settings.json'),
    codex: join(homeDir, '.codex', 'config.toml'),
    opencode: paths.opencode
  }
}

function mergeModelConfig(target: ConfigTarget, path: string, content: string, model: string): string {
  if (target === 'claude' || target === 'opencode') {
    const source = content.trim().length === 0 ? '{}' : content
    parseJsonConfig(source, path) // validate before editing
    return applyEdits(
      source,
      modify(source, ['model'], model, { formattingOptions: formattingOptions(source) })
    )
  }
  let parsed: TomlTable
  try {
    parsed = parseToml(content)
  } catch {
    throw new ConfigWriterError('CONFIG_INVALID', `Cannot parse config: ${path}`)
  }
  parsed.model = model
  const eol = content.includes('\r\n') ? '\r\n' : '\n'
  return `${stringifyToml(parsed).replace(/\n/g, eol).replace(new RegExp(`${eol}+$`), '')}${eol}`
}

/** Sentinel mtime for a proposal that CREATES a missing config file. */
const MISSING_FILE_MTIME = -1

async function stableRead(path: string): Promise<StableFile> {
  let before
  try {
    before = await stat(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new ConfigWriterError('CONFIG_NOT_FOUND', `Config does not exist: ${path}`)
    }
    throw error
  }
  const content = await readFile(path, 'utf8')
  const after = await stat(path)
  if (before.mtimeMs !== after.mtimeMs || before.size !== after.size) {
    throw new ConfigWriterError('CONFIG_CHANGED', `Config changed while reading: ${path}`)
  }
  return { content, mtimeMs: after.mtimeMs, hash: sha256(content) }
}

async function stableReadOptional(path: string): Promise<StableFile & { existed: boolean }> {
  try {
    return { ...(await stableRead(path)), existed: true }
  } catch (error) {
    if (error instanceof ConfigWriterError && error.code === 'CONFIG_NOT_FOUND') {
      return { content: '', mtimeMs: 0, hash: sha256(''), existed: false }
    }
    throw error
  }
}

function timestamp(date: Date): string {
  return date.toISOString().replace(/[-:.]/g, '')
}

function isContained(root: string, path: string): boolean {
  const fromRoot = relative(root, path)
  return fromRoot === '' || (!fromRoot.startsWith('..') && !isAbsolute(fromRoot))
}

/**
 * Generic file proposals are main-process-only, but Context Hub also supplies
 * a Space root so this writer can enforce the filesystem boundary at proposal
 * and apply time. Existing links are rejected instead of followed: otherwise
 * a docs/ junction could redirect a seemingly in-Space write elsewhere.
 */
async function assertSafeFilePath(rootInput: string, pathInput: string): Promise<string> {
  if (!isAbsolute(rootInput)) {
    throw new ConfigWriterError('INVALID_INSTALL_SPEC', 'File proposal root must be absolute')
  }
  const root = await realpath(rootInput)
  const path = resolve(pathInput)
  if (!isContained(root, path) || path === root) {
    throw new ConfigWriterError('INVALID_INSTALL_SPEC', 'File proposal escaped its Space root')
  }

  const fromRoot = relative(root, path)
  let current = root
  for (const segment of fromRoot.split(/[\\/]/).filter(Boolean)) {
    current = join(current, segment)
    try {
      const info = await lstat(current)
      if (info.isSymbolicLink()) {
        throw new ConfigWriterError(
          'INVALID_INSTALL_SPEC',
          `File proposal crosses a symbolic link or junction: ${current}`
        )
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') break
      throw error
    }
  }

  try {
    const canonical = await realpath(path)
    if (!isContained(root, canonical)) {
      throw new ConfigWriterError('INVALID_INSTALL_SPEC', 'File proposal escaped its Space root')
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  return root
}

async function atomicReplace(path: string, content: string, mode: number): Promise<void> {
  const tempPath = `${path}.morz-tmp-${process.pid}-${randomUUID()}`
  const handle = await open(tempPath, 'wx', mode)
  try {
    await handle.writeFile(content, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  try {
    await import('node:fs/promises').then(({ rename }) => rename(tempPath, path))
  } finally {
    await unlink(tempPath).catch(() => undefined)
  }
}

async function atomicCreate(
  path: string,
  content: string,
  mode = 0o600,
  validate?: () => Promise<void>
): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await validate?.()
  const handle = await open(path, 'wx', mode)
  let complete = false
  try {
    await handle.writeFile(content, 'utf8')
    await handle.sync()
    complete = true
  } finally {
    await handle.close()
    if (!complete) await unlink(path).catch(() => undefined)
  }
}

export function createConfigWriter(options: ConfigWriterOptions = {}): ConfigWriter {
  const paths = options.paths ?? defaultPaths(options)
  // w15/model-choice — model keys live in different files than MCP entries.
  const modelPaths = options.modelPaths ?? defaultModelPaths(options, paths)
  const now = options.now ?? (() => new Date())
  const proposals = new Map<string, StoredProposal>()
  const fileProposals = new Map<string, StoredFileProposal>()

  function storeProposal(
    target: ConfigTarget,
    path: string,
    source: StableFile,
    newContent: string
  ): ConfigProposal {
    const hash = sha256(`${target}\0${path}\0${source.hash}\0${newContent}`)
    const proposalId = randomUUID()
    const proposal: StoredProposal = {
      proposalId,
      hash,
      target,
      path,
      unifiedDiff: createTwoFilesPatch(path, path, source.content, newContent, 'before', 'after'),
      oldContent: source.content,
      newContent,
      oldHash: source.hash,
      mtimeMs: source.mtimeMs
    }
    proposals.set(proposalId, proposal)
    while (proposals.size > MAX_PROPOSALS) proposals.delete(proposals.keys().next().value!)
    return {
      proposalId: proposal.proposalId,
      hash: proposal.hash,
      target: proposal.target,
      path: proposal.path,
      unifiedDiff: proposal.unifiedDiff
    }
  }

  return {
    async detect(): Promise<DetectedConfig[]> {
      const detected = await Promise.all(
        TARGETS.map(async (target): Promise<DetectedConfig | null> => {
          try {
            const result = await stat(paths[target])
            return result.isFile() ? { target, path: paths[target] } : null
          } catch {
            return null
          }
        })
      )
      return detected.filter((item): item is DetectedConfig => item !== null)
    },

    async propose(rawSpec: InstallSpec, rawTargets: ConfigTarget[]): Promise<ConfigProposal[]> {
      const spec = validateInstallSpec(rawSpec)
      if (!Array.isArray(rawTargets) || rawTargets.some((target) => !TARGETS.includes(target))) {
        throw new ConfigWriterError('INVALID_INSTALL_SPEC', 'Targets contain an unsupported CLI')
      }

      const uniqueTargets = [...new Set(rawTargets)]
      return Promise.all(
        uniqueTargets.map(async (target): Promise<ConfigProposal> => {
          const source = await stableRead(paths[target])
          const newContent = mergeConfig(target, paths[target], source.content, spec)
          return storeProposal(target, paths[target], source, newContent)
        })
      )
    },

    // w15/model-choice — diff-first persistent model default. A missing file
    // (fresh ~/.claude/settings.json) becomes a CREATE proposal.
    async proposeModel(target: ConfigTarget, model: string): Promise<ConfigProposal> {
      if (!TARGETS.includes(target)) {
        throw new ConfigWriterError('INVALID_INSTALL_SPEC', 'Unsupported CLI for a model write')
      }
      if (typeof model !== 'string' || !isSafeModelId(model)) {
        throw new ConfigWriterError('INVALID_INSTALL_SPEC', 'Model id has an unsupported shape')
      }
      const path = modelPaths[target]
      let source: StableFile
      try {
        source = await stableRead(path)
      } catch (error) {
        if (!(error instanceof ConfigWriterError) || error.code !== 'CONFIG_NOT_FOUND') throw error
        source = { content: '', mtimeMs: MISSING_FILE_MTIME, hash: sha256('') }
      }
      const newContent = mergeModelConfig(target, path, source.content, model)
      return storeProposal(target, path, source, newContent)
    },

    async apply(proposalId: string): Promise<ApplyResult> {
      const proposal = proposals.get(proposalId)
      if (!proposal) {
        throw new ConfigWriterError('PROPOSAL_NOT_FOUND', 'Proposal is missing or was already applied')
      }

      // w15/model-choice — a CREATE proposal applies only while the file is
      // still absent; nothing exists to back up.
      if (proposal.mtimeMs === MISSING_FILE_MTIME) {
        const stillMissing = await stat(proposal.path).then(
          () => false,
          (error) => (error as NodeJS.ErrnoException).code === 'ENOENT'
        )
        if (!stillMissing) {
          proposals.delete(proposalId)
          throw new ConfigWriterError(
            'CONFIG_CHANGED',
            `Config appeared after proposal; re-propose before applying: ${proposal.path}`
          )
        }
        await atomicReplace(proposal.path, proposal.newContent, 0o644)
        proposals.delete(proposalId)
        return { target: proposal.target, path: proposal.path, backupPath: '' }
      }

      const source = await stableRead(proposal.path)
      if (source.mtimeMs !== proposal.mtimeMs || source.hash !== proposal.oldHash || source.content !== proposal.oldContent) {
        proposals.delete(proposalId)
        throw new ConfigWriterError('CONFIG_CHANGED', `Config changed after proposal; re-propose before applying: ${proposal.path}`)
      }

      const sourceStat = await stat(proposal.path)
      const backupPath = `${proposal.path}.morz-backup-${timestamp(now())}`
      await copyFile(proposal.path, backupPath, constants.COPYFILE_EXCL)

      const backupHash = sha256(await readFile(backupPath, 'utf8'))
      const finalStat = await stat(proposal.path)
      if (backupHash !== proposal.oldHash || finalStat.mtimeMs !== proposal.mtimeMs) {
        proposals.delete(proposalId)
        throw new ConfigWriterError('CONFIG_CHANGED', `Config changed while backing up; re-propose before applying: ${proposal.path}`)
      }

      await atomicReplace(proposal.path, proposal.newContent, sourceStat.mode)
      proposals.delete(proposalId)
      return { target: proposal.target, path: proposal.path, backupPath }
    },

    async proposeFile(
      path: string,
      newContent: string,
      label: string,
      expectedContent?: string,
      root?: string
    ): Promise<FileProposal> {
      if (!isAbsolute(path) || path.length > 32_768) {
        throw new ConfigWriterError('INVALID_INSTALL_SPEC', 'File proposal path must be absolute')
      }
      if (typeof newContent !== 'string' || newContent.length > 2 * 1024 * 1024) {
        throw new ConfigWriterError('INVALID_INSTALL_SPEC', 'File proposal content is invalid')
      }
      if (typeof label !== 'string' || !label.trim() || label.length > 500) {
        throw new ConfigWriterError('INVALID_INSTALL_SPEC', 'File proposal label is invalid')
      }

      const canonicalRoot = root === undefined ? null : await assertSafeFilePath(root, path)
      const source = await stableReadOptional(path)
      if (expectedContent !== undefined && source.content !== expectedContent) {
        throw new ConfigWriterError(
          'CONFIG_CHANGED',
          `File changed while preparing proposal; refresh before retrying: ${path}`
        )
      }
      const proposalId = randomUUID()
      const hash = sha256(`file\0${path}\0${source.hash}\0${newContent}`)
      const proposal: StoredFileProposal = {
        proposalId,
        hash,
        path,
        label: label.trim(),
        unifiedDiff: createTwoFilesPatch(
          source.existed ? path : '/dev/null',
          path,
          source.content,
          newContent,
          'before',
          'after'
        ),
        oldContent: source.content,
        newContent,
        oldHash: source.hash,
        mtimeMs: source.mtimeMs,
        existed: source.existed,
        root: canonicalRoot
      }
      fileProposals.set(proposalId, proposal)
      while (fileProposals.size > MAX_PROPOSALS) {
        fileProposals.delete(fileProposals.keys().next().value!)
      }
      return {
        proposalId: proposal.proposalId,
        hash: proposal.hash,
        path: proposal.path,
        label: proposal.label,
        unifiedDiff: proposal.unifiedDiff
      }
    },

    async applyFile(proposalId: string): Promise<FileApplyResult> {
      const proposal = fileProposals.get(proposalId)
      if (!proposal) {
        throw new ConfigWriterError('PROPOSAL_NOT_FOUND', 'File proposal is missing or was already applied')
      }

      if (!proposal.existed) {
        if (proposal.root) await assertSafeFilePath(proposal.root, proposal.path)
        try {
          await stat(proposal.path)
          fileProposals.delete(proposalId)
          throw new ConfigWriterError(
            'CONFIG_CHANGED',
            `File appeared after proposal; re-propose before applying: ${proposal.path}`
          )
        } catch (error) {
          if (error instanceof ConfigWriterError) throw error
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        }
        try {
          await atomicCreate(
            proposal.path,
            proposal.newContent,
            0o600,
            proposal.root
              ? async () => {
                  await assertSafeFilePath(proposal.root!, proposal.path)
                }
              : undefined
          )
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
            fileProposals.delete(proposalId)
            throw new ConfigWriterError(
              'CONFIG_CHANGED',
              `File appeared while applying proposal; re-propose before applying: ${proposal.path}`
            )
          }
          throw error
        }
        fileProposals.delete(proposalId)
        return { path: proposal.path, backupPath: null, created: true }
      }

      if (proposal.root) await assertSafeFilePath(proposal.root, proposal.path)
      const source = await stableRead(proposal.path)
      if (
        source.mtimeMs !== proposal.mtimeMs ||
        source.hash !== proposal.oldHash ||
        source.content !== proposal.oldContent
      ) {
        fileProposals.delete(proposalId)
        throw new ConfigWriterError(
          'CONFIG_CHANGED',
          `File changed after proposal; re-propose before applying: ${proposal.path}`
        )
      }

      const sourceStat = await stat(proposal.path)
      const backupPath = `${proposal.path}.morz-backup-${timestamp(now())}`
      if (proposal.root) await assertSafeFilePath(proposal.root, proposal.path)
      await copyFile(proposal.path, backupPath, constants.COPYFILE_EXCL)
      const backupHash = sha256(await readFile(backupPath, 'utf8'))
      const finalStat = await stat(proposal.path)
      if (backupHash !== proposal.oldHash || finalStat.mtimeMs !== proposal.mtimeMs) {
        fileProposals.delete(proposalId)
        throw new ConfigWriterError(
          'CONFIG_CHANGED',
          `File changed while backing up; re-propose before applying: ${proposal.path}`
        )
      }

      if (proposal.root) await assertSafeFilePath(proposal.root, proposal.path)
      await atomicReplace(proposal.path, proposal.newContent, sourceStat.mode)
      fileProposals.delete(proposalId)
      return { path: proposal.path, backupPath, created: false }
    }
  }
}

let defaultWriter: ConfigWriter | null = null

/** w15/model-choice — the ONE shared writer instance: model proposals and MCP
 * proposals live in the same map, so either apply channel can land either. */
export function defaultConfigWriter(): ConfigWriter {
  return (defaultWriter ??= createConfigWriter())
}

export function registerConfigWriterIpc(ipcMain: IpcMain): void {
  defaultWriter ??= createConfigWriter()
  ipcMain.handle(ConfigWriterApi.detect, () => defaultWriter!.detect())
  ipcMain.handle(ConfigWriterApi.propose, (_event, spec: InstallSpec, targets: ConfigTarget[]) =>
    defaultWriter!.propose(spec, targets)
  )
  ipcMain.handle(ConfigWriterApi.apply, (_event, proposalId: string) => defaultWriter!.apply(proposalId))
}
