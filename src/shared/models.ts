import type { CliId } from './connections'
import { isSafeModelId } from './model-choice'

export interface PlannerModelCatalogEntry {
  models: readonly string[]
  strength: string
  /** OpenCode accepts any safe provider/model identifier exposed by its providers. */
  passthrough?: boolean
}

/** Models the planner may assign without guessing. Keep this list deliberately small. */
export const PLANNER_MODEL_CATALOG: Record<CliId, PlannerModelCatalogEntry> = {
  claude: {
    models: ['sonnet', 'opus', 'fable'],
    strength: 'planning, architecture, system design, code and design review'
  },
  codex: {
    models: ['gpt-5.5', 'gpt-5.6-sol'],
    strength: 'implementation, builds, tests, and refactors'
  },
  agy: {
    models: ['gemini-3.1-pro'],
    strength: 'math, geometry, algorithms, physics, and timing logic'
  },
  opencode: {
    models: [],
    strength: 'provider-routed specialist work through the user configured in OpenCode',
    passthrough: true
  }
}

export function isPlannerModel(cli: CliId, model: string): boolean {
  const entry = PLANNER_MODEL_CATALOG[cli]
  if (!isSafeModelId(model)) return false
  if (entry.passthrough) return model.includes('/')
  return entry.models.includes(model)
}

export function plannerModelHint(cli: CliId): string {
  const entry = PLANNER_MODEL_CATALOG[cli]
  const models = entry.passthrough ? 'provider/model (passthrough)' : entry.models.join(', ')
  return `${cli}: ${models} — ${entry.strength}`
}
