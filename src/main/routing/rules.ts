import Database from 'better-sqlite3'
import { app, ipcMain } from 'electron'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  RoutingApi,
  type RouteDecision,
  type RouteOptions,
  type RoutingRule,
  type RoutingSnapshot,
  type RoutingTarget
} from '../../shared/ipc'
import { notify } from '../services/notify-center'
import {
  LocalModelDetector,
  claudeLocalEnv,
  firstAvailableLocalModel,
  type LocalModelDetectorOptions
} from './local-models'

const MAX_RULES = 64
const MAX_KEYWORDS = 64
const MAX_TEXT = 20_000
const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/
const TARGETS = new Set<RoutingTarget>(['agy', 'codex', 'claude', 'local'])

export const DEFAULT_ROUTING_RULES: readonly RoutingRule[] = [
  {
    id: 'math',
    label: 'Math and proofs',
    match: {
      keywords: ['math', 'mathematics', 'theorem', 'proof', 'prove', 'equation', 'calculus'],
      regex: ['\\b(solve|derive)\\b.{0,40}\\b(equation|formula|integral|derivative)\\b']
    },
    target: 'agy',
    reason: 'Antigravity is the preferred brain for mathematical reasoning.',
    enabled: true
  },
  {
    id: 'design-critique',
    label: 'Design critique',
    match: {
      keywords: ['design critique', 'critique this design', 'ux critique', 'ui critique'],
      regex: ['\\b(review|audit|critique)\\b.{0,30}\\b(design|ui|ux|interface)\\b']
    },
    target: 'agy',
    reason: 'Antigravity is the preferred brain for visual and interaction critique.',
    enabled: true
  },
  {
    id: 'review',
    label: 'Review and audit',
    match: {
      keywords: ['review', 'audit', 'inspect', 'security check', 'diff review'],
      regex: ['\\b(review|audit)\\b.{0,40}\\b(diff|code|change|patch|security)\\b']
    },
    target: 'codex',
    reason: 'Codex is the preferred brain for code review and audits.',
    enabled: true
  },
  {
    id: 'build',
    label: 'Build and code',
    match: {
      keywords: ['build', 'implement', 'code', 'develop', 'fix', 'refactor'],
      regex: ['\\b(add|create|write)\\b.{0,30}\\b(component|function|feature|test|api)\\b']
    },
    target: 'claude',
    reason: 'Claude is the default brain for implementation work.',
    enabled: true
  }
]

const PRIVATE_RULE: RoutingRule = {
  id: 'private-space',
  label: 'Private space',
  match: { keywords: [], regex: [] },
  target: 'local',
  reason: 'Private spaces stay on a detected local model.',
  enabled: true
}

const FALLBACK_RULE: RoutingRule = {
  id: 'fallback',
  label: 'Default',
  match: { keywords: [], regex: [] },
  target: 'claude',
  reason: 'No routing rule matched, so Claude remains the default brain.',
  enabled: true
}

export interface RouteContext {
  spacePrivate: boolean
  localAvailable?: boolean
}

function cloneRule(rule: RoutingRule): RoutingRule {
  return {
    ...rule,
    match: { keywords: [...rule.match.keywords], regex: [...rule.match.regex] }
  }
}

function isSafeRegex(source: string): boolean {
  if (!source || source.length > 200 || /\\[1-9]/.test(source)) return false
  if (/\([^)]*[+*][^)]*\)[+*{]/.test(source)) return false
  try {
    new RegExp(source, 'i')
    return true
  } catch {
    return false
  }
}

function cleanList(value: unknown, kind: 'keyword' | 'regex'): string[] {
  if (!Array.isArray(value) || value.length > MAX_KEYWORDS) {
    throw new Error(`A routing rule may contain at most ${MAX_KEYWORDS} ${kind} entries`)
  }
  const result: string[] = []
  for (const raw of value) {
    if (typeof raw !== 'string') throw new Error(`Routing ${kind} entries must be strings`)
    const item = raw.trim()
    if (!item || item.length > 200) throw new Error(`Routing ${kind} entries must be 1-200 characters`)
    if (kind === 'regex' && !isSafeRegex(item)) throw new Error(`Unsafe routing regex: ${item.slice(0, 40)}`)
    if (!result.includes(item)) result.push(item)
  }
  return result
}

export function normalizeRoutingRules(value: unknown): RoutingRule[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_RULES) {
    throw new Error(`Routing rules must contain 1-${MAX_RULES} entries`)
  }
  const seen = new Set<string>()
  return value.map((raw) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Routing rules must be objects')
    const rule = raw as Record<string, unknown>
    const id = typeof rule.id === 'string' ? rule.id.trim() : ''
    const label = typeof rule.label === 'string' ? rule.label.trim() : ''
    const reason = typeof rule.reason === 'string' ? rule.reason.trim() : ''
    if (!ID_PATTERN.test(id) || seen.has(id)) throw new Error('Routing rule ids must be unique safe slugs')
    if (!label || label.length > 100) throw new Error('Routing rule labels must be 1-100 characters')
    if (!reason || reason.length > 300) throw new Error('Routing rule reasons must be 1-300 characters')
    if (!TARGETS.has(rule.target as RoutingTarget)) throw new Error('Routing rule target is invalid')
    if (typeof rule.enabled !== 'boolean') throw new Error('Routing rule enabled must be boolean')
    if (!rule.match || typeof rule.match !== 'object' || Array.isArray(rule.match)) {
      throw new Error('Routing rule match must be an object')
    }
    seen.add(id)
    const match = rule.match as Record<string, unknown>
    return {
      id,
      label,
      reason,
      target: rule.target as RoutingTarget,
      enabled: rule.enabled,
      match: {
        keywords: cleanList(match.keywords, 'keyword'),
        regex: cleanList(match.regex, 'regex')
      }
    }
  })
}

function ruleMatches(rule: RoutingRule, text: string): boolean {
  const lower = text.toLocaleLowerCase()
  if (rule.match.keywords.some((keyword) => lower.includes(keyword.toLocaleLowerCase()))) return true
  return rule.match.regex.some((source) => new RegExp(source, 'i').test(text))
}

/** Pure, ordered rule evaluation. Callers supply local availability explicitly. */
export function route(
  taskText: string,
  context: RouteContext,
  rules: readonly RoutingRule[] = DEFAULT_ROUTING_RULES
): RouteDecision {
  const text = taskText.trim().slice(0, MAX_TEXT)
  if (context.spacePrivate) {
    if (context.localAvailable !== false) {
      return { target: 'local', reason: PRIVATE_RULE.reason, rule: cloneRule(PRIVATE_RULE) }
    }
    return {
      target: 'claude',
      reason: 'No compatible local model is available, so the private route cannot be enforced.',
      rule: cloneRule(PRIVATE_RULE),
      warning: 'Private space requested local routing, but no compatible local model was detected.'
    }
  }
  for (const rule of rules) {
    if (rule.enabled && ruleMatches(rule, text)) {
      return { target: rule.target, reason: rule.reason, rule: cloneRule(rule) }
    }
  }
  return { target: 'claude', reason: FALLBACK_RULE.reason, rule: cloneRule(FALLBACK_RULE) }
}

interface RuleRow {
  json: string
}

export class RoutingRuleStore {
  private readonly db: Database.Database

  constructor(dbPath: string) {
    this.db = new Database(dbPath)
    this.db.pragma('journal_mode = WAL')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS routing_rules (
        position INTEGER PRIMARY KEY,
        json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS routing_private_spaces (
        space_root TEXT PRIMARY KEY,
        private INTEGER NOT NULL CHECK (private IN (0, 1)),
        updated_at INTEGER NOT NULL
      );
    `)
  }

  listRules(): RoutingRule[] {
    const rows = this.db.prepare('SELECT json FROM routing_rules ORDER BY position').all() as RuleRow[]
    if (rows.length === 0) return DEFAULT_ROUTING_RULES.map(cloneRule)
    try {
      return normalizeRoutingRules(rows.map((row) => JSON.parse(row.json) as unknown))
    } catch {
      return DEFAULT_ROUTING_RULES.map(cloneRule)
    }
  }

  saveRules(value: unknown): RoutingRule[] {
    const rules = normalizeRoutingRules(value)
    const replace = this.db.transaction((next: RoutingRule[]) => {
      this.db.prepare('DELETE FROM routing_rules').run()
      const insert = this.db.prepare('INSERT INTO routing_rules (position, json) VALUES (?, ?)')
      next.forEach((rule, index) => insert.run(index, JSON.stringify(rule)))
    })
    replace(rules)
    return rules.map(cloneRule)
  }

  isSpacePrivate(spaceRoot: string): boolean {
    if (!spaceRoot) return false
    const row = this.db
      .prepare('SELECT private FROM routing_private_spaces WHERE space_root = ?')
      .get(spaceRoot) as { private: number } | undefined
    return row?.private === 1
  }

  setSpacePrivate(spaceRoot: string, value: boolean): boolean {
    const root = spaceRoot.trim()
    if (!root || root.length > 2_000) throw new Error('Space root must be 1-2000 characters')
    this.db
      .prepare(
        `INSERT INTO routing_private_spaces (space_root, private, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(space_root) DO UPDATE SET private = excluded.private, updated_at = excluded.updated_at`
      )
      .run(root, value ? 1 : 0, Date.now())
    return value
  }

  close(): void {
    this.db.close()
  }
}

let registered = false

export function registerRoutingIpc(detectorOptions: LocalModelDetectorOptions = {}): void {
  if (registered) return
  registered = true
  const dir = join(app.getPath('appData'), 'Morz')
  mkdirSync(dir, { recursive: true })
  const store = new RoutingRuleStore(join(dir, 'morz.db'))
  const detector = new LocalModelDetector(detectorOptions)
  void detector.refresh()

  ipcMain.handle(RoutingApi.snapshot, (_event, spaceRoot: unknown): RoutingSnapshot => ({
    rules: store.listRules(),
    localModels: detector.snapshot(),
    spacePrivate: typeof spaceRoot === 'string' && store.isSpacePrivate(spaceRoot)
  }))
  ipcMain.handle(RoutingApi.saveRules, (_event, rules: unknown) => store.saveRules(rules))
  ipcMain.handle(
    RoutingApi.setSpacePrivate,
    (_event, input: unknown) => {
      if (!input || typeof input !== 'object') throw new Error('Invalid private-space request')
      const { spaceRoot, value } = input as Record<string, unknown>
      if (typeof spaceRoot !== 'string' || typeof value !== 'boolean') {
        throw new Error('Invalid private-space request')
      }
      return store.setSpacePrivate(spaceRoot, value)
    }
  )
  ipcMain.handle(RoutingApi.refreshLocalModels, () => detector.refresh())
  ipcMain.handle(
    RoutingApi.route,
    (_event, input: unknown): RouteDecision => {
      if (!input || typeof input !== 'object') throw new Error('Invalid route request')
      const { taskText, options } = input as { taskText?: unknown; options?: RouteOptions }
      if (typeof taskText !== 'string' || !taskText.trim() || taskText.length > MAX_TEXT) {
        throw new Error(`Task text must be 1-${MAX_TEXT} characters`)
      }
      const routeOptions = options && typeof options === 'object' ? options : {}
      const spaceRoot = typeof routeOptions.spaceRoot === 'string' ? routeOptions.spaceRoot : ''
      const spacePrivate = typeof routeOptions.spacePrivate === 'boolean'
        ? routeOptions.spacePrivate
        : store.isSpacePrivate(spaceRoot)
      const localModel = firstAvailableLocalModel(detector.snapshot())
      const decision = route(taskText, { spacePrivate, localAvailable: Boolean(localModel) }, store.listRules())
      if (decision.warning) {
        notify({
          id: 'routing:private-local-unavailable',
          level: 'warning',
          source: 'dispatch',
          title: 'Private route could not stay local',
          detail: decision.warning
        })
      }
      if (decision.target === 'local' && localModel) {
        return { ...decision, localModel, claudeEnv: claudeLocalEnv(localModel) }
      }
      return decision
    }
  )
  app.once('before-quit', () => store.close())
}
