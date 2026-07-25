/*
 * Wave-15 module registry contract. This local copy mirrors Agent 1's shared
 * seam and adds the Context module required by slice 9. Reconcile this file
 * with w15/modules-core during integration rather than keeping two registries.
 */
export type ModuleId =
  | 'sessions'
  | 'orchestration'
  | 'commit'
  | 'review'
  | 'browser'
  | 'organizer'
  | 'workshop'
  | 'pulse'
  | 'voice'
  | 'obsidian'
  | 'context'

export interface ModuleDef {
  id: ModuleId
  label: string
  defaultOn: boolean
  requires?: ModuleId[]
}

export const MODULES: readonly ModuleDef[] = [
  { id: 'sessions', label: 'Sessions', defaultOn: true },
  { id: 'orchestration', label: 'Orchestration', defaultOn: false },
  { id: 'commit', label: 'Commit', defaultOn: false },
  { id: 'review', label: 'Review', defaultOn: false },
  { id: 'browser', label: 'Browser', defaultOn: false },
  { id: 'organizer', label: 'Organizer', defaultOn: false },
  { id: 'workshop', label: 'Workshop', defaultOn: false },
  { id: 'pulse', label: 'Daily Pulse', defaultOn: false },
  { id: 'voice', label: 'Voice', defaultOn: false },
  { id: 'obsidian', label: 'Obsidian', defaultOn: false },
  { id: 'context', label: 'Context', defaultOn: false }
]

export function isModuleId(value: unknown): value is ModuleId {
  return MODULES.some((def) => def.id === value)
}

export function defaultModulesEnabled(): Record<ModuleId, boolean> {
  return Object.fromEntries(MODULES.map((def) => [def.id, def.defaultOn])) as Record<
    ModuleId,
    boolean
  >
}

export const ModulesApi = {
  get: 'modules:get',
  set: 'modules:set'
} as const

export interface ModulesBridge {
  get(): Promise<Record<ModuleId, boolean>>
  set(id: ModuleId, on: boolean): Promise<Record<ModuleId, boolean>>
}
