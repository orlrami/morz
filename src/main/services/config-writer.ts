import { createHash, randomUUID } from 'node:crypto'
import {
  copyFile,
  mkdir,
  open,
  readFile,
  stat,
  unlink
} from 'node:fs/promises'
import { constants, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { IpcMain } from 'electron'
import { createTwoFilesPatch } from 'diff'
import { applyEdits, modify, parse as parseJsonc, type ParseError } from 'jsonc-parser'
import { parse as parseToml, stringify as stringifyToml, type TomlTable } from 'smol-toml'
import { ConfigWriterApi } from '../../shared/ipc'

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

interface ConfigWriterOptions {
  paths?: ConfigWriterPaths
  projectDir?: string
  homeDir?: string
  appDataDir?: string
  now?: () => Date
}

export interface ConfigWriter {
  detect(): Promise<DetectedConfig[]>
  propose(spec: InstallSpec, targets: ConfigTarget[]): Promise<ConfigProposal[]>
  apply(proposalId: string): Promise<ApplyResult>
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

function defaultPaths(options: ConfigWriterOptions): ConfigWriterPaths {
  const projectDir = options.projectDir ?? process.cwd()
  const homeDir = options.homeDir ?? homedir()
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

function timestamp(date: Date): string {
  return date.toISOString().replace(/[-:.]/g, '')
}

async function atomicReplace(path: string, content: string, mode: number): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
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

export function createConfigWriter(options: ConfigWriterOptions = {}): ConfigWriter {
  const paths = options.paths ?? defaultPaths(options)
  const now = options.now ?? (() => new Date())
  const proposals = new Map<string, StoredProposal>()

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
          const hash = sha256(`${target}\0${paths[target]}\0${source.hash}\0${newContent}`)
          const proposalId = randomUUID()
          const proposal: StoredProposal = {
            proposalId,
            hash,
            target,
            path: paths[target],
            unifiedDiff: createTwoFilesPatch(paths[target], paths[target], source.content, newContent, 'before', 'after'),
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
        })
      )
    },

    async apply(proposalId: string): Promise<ApplyResult> {
      const proposal = proposals.get(proposalId)
      if (!proposal) {
        throw new ConfigWriterError('PROPOSAL_NOT_FOUND', 'Proposal is missing or was already applied')
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
    }
  }
}

let defaultWriter: ConfigWriter | null = null

export function registerConfigWriterIpc(ipcMain: IpcMain): void {
  defaultWriter ??= createConfigWriter()
  ipcMain.handle(ConfigWriterApi.detect, () => defaultWriter!.detect())
  ipcMain.handle(ConfigWriterApi.propose, (_event, spec: InstallSpec, targets: ConfigTarget[]) =>
    defaultWriter!.propose(spec, targets)
  )
  ipcMain.handle(ConfigWriterApi.apply, (_event, proposalId: string) => defaultWriter!.apply(proposalId))
}
