import { readFile, realpath, stat } from 'fs/promises'
import { isAbsolute, join, resolve } from 'path'
import { globalRules } from './rulesets/global'
import { typescriptElectronRules } from './rulesets/typescript-electron'

export type RuleSource = 'global' | 'typescript-electron'

export interface RuleDefinition {
  id: string
  source: RuleSource
  cite: string
  explanation: string
}

export interface ResolvedRule extends RuleDefinition {
  enabled: boolean
  autoFix: boolean
}

interface ProjectRuleConfig {
  enabled?: boolean
  autoFix?: boolean
}

interface OrganizerProjectConfig {
  stack?: 'auto' | 'none' | 'typescript-electron'
  rules?: Record<string, boolean | ProjectRuleConfig>
}

const catalog = new Map(
  [...globalRules, ...typescriptElectronRules].map((rule) => [rule.id, rule] as const)
)

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8')) as unknown
}

async function readProjectConfig(root: string): Promise<OrganizerProjectConfig> {
  const paths = [
    join(root, '.morz', 'organizer.config'),
    join(root, '.morz', 'organizer.config.json')
  ]
  let parsed: unknown = undefined
  let selectedPath = ''
  for (const path of paths) {
    try {
      const candidate = await readJson(path)
      if (selectedPath) throw new Error(`Multiple Organizer config files found: ${selectedPath} and ${path}`)
      parsed = candidate
      selectedPath = path
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      if ((error as Error).message.startsWith('Multiple Organizer config files')) throw error
      if ((error as NodeJS.ErrnoException).code) {
        throw new Error(`Organizer could not read its config at ${path}.`)
      }
      throw new Error(`Invalid Organizer config at ${path}: ${(error as Error).message}`)
    }
  }
  if (!selectedPath) return {}
  if (!isRecord(parsed)) throw new Error(`Invalid Organizer config at ${selectedPath}: expected an object`)
  for (const key of Object.keys(parsed)) {
    if (key !== 'stack' && key !== 'rules') throw new Error(`Invalid Organizer config key: ${key}`)
  }
  const stack = parsed.stack
  if (stack !== undefined && stack !== 'auto' && stack !== 'none' && stack !== 'typescript-electron') {
    throw new Error(`Invalid Organizer stack: ${String(stack)}`)
  }
  const rawRules = parsed.rules
  if (rawRules !== undefined && !isRecord(rawRules)) {
    throw new Error('Invalid Organizer rules: expected an object')
  }
  const rules: OrganizerProjectConfig['rules'] = {}
  for (const [id, value] of Object.entries(rawRules ?? {})) {
    if (!catalog.has(id)) throw new Error(`Unknown Organizer rule: ${id}`)
    if (typeof value === 'boolean') rules[id] = value
    else if (isRecord(value) &&
      (value.enabled === undefined || typeof value.enabled === 'boolean') &&
      (value.autoFix === undefined || typeof value.autoFix === 'boolean')) {
      for (const key of Object.keys(value)) {
        if (key !== 'enabled' && key !== 'autoFix') {
          throw new Error(`Invalid option for Organizer rule ${id}: ${key}`)
        }
      }
      rules[id] = {
        enabled: value.enabled as boolean | undefined,
        autoFix: value.autoFix as boolean | undefined
      }
    } else throw new Error(`Invalid configuration for Organizer rule: ${id}`)
  }
  return { stack: stack as OrganizerProjectConfig['stack'], rules }
}

async function detectTypeScriptElectron(root: string): Promise<boolean> {
  try {
    const parsed = await readJson(join(root, 'package.json'))
    if (!isRecord(parsed)) throw new Error('package.json must contain an object')
    const dependencies = isRecord(parsed.dependencies) ? parsed.dependencies : {}
    const devDependencies = isRecord(parsed.devDependencies) ? parsed.devDependencies : {}
    return (typeof dependencies.electron === 'string' || typeof devDependencies.electron === 'string') &&
      (typeof dependencies.typescript === 'string' || typeof devDependencies.typescript === 'string')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    if ((error as NodeJS.ErrnoException).code) {
      throw new Error('Organizer could not read package.json while detecting the project stack.')
    }
    throw new Error(`Cannot detect Organizer stack from package.json: ${(error as Error).message}`)
  }
}

export async function resolveOrganizerRoot(input: string): Promise<string> {
  if (typeof input !== 'string' || input.trim() === '') throw new Error('Organizer root is required')
  if (!isAbsolute(input)) throw new Error('Organizer root must be absolute')
  const candidate = resolve(input)
  let metadata
  try {
    metadata = await stat(candidate)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`Organizer root does not exist: ${candidate}`)
    }
    throw new Error(`Organizer could not inspect this root: ${candidate}`)
  }
  if (!metadata.isDirectory()) throw new Error(`Organizer root is not a directory: ${candidate}`)
  try {
    return await realpath(candidate)
  } catch {
    throw new Error(`Organizer could not resolve this root: ${candidate}`)
  }
}

export async function resolveRules(root: string): Promise<ResolvedRule[]> {
  const config = await readProjectConfig(root)
  const useStack = config.stack === 'typescript-electron' ||
    (config.stack !== 'none' && await detectTypeScriptElectron(root))
  const layered = [...globalRules, ...(useStack ? typescriptElectronRules : [])]
  return layered.map((rule) => {
    const override = config.rules?.[rule.id]
    const enabled = typeof override === 'boolean' ? override : override?.enabled ?? true
    const autoFix = typeof override === 'object' ? override.autoFix ?? false : false
    return { ...rule, enabled, autoFix }
  })
}

export function explainRule(ruleId: string): RuleDefinition {
  if (typeof ruleId !== 'string') throw new Error('Organizer rule id is required')
  const rule = catalog.get(ruleId)
  if (!rule) throw new Error(`Unknown Organizer rule: ${ruleId}`)
  return rule
}
