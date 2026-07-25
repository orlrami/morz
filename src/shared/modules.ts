/*
 * Module registry contract (0.0.5, wave-15 slice 1) â€” THE shared contract of
 * the wave: shell rail, drawer, onboarding, settings, and gating all derive
 * from this file. Core surfaces (terminals, explorer, ide-overlay, spaces,
 * settings) are always on and intentionally NOT listed here.
 *
 * Gating is REAL: a disabled module renders no tab/icon, mounts no component,
 * and registers no sync/notifications. ADDITIVE changes only during the wave.
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

/** Registry order is display order (drawer, rail). Defaults: sessions ON, rest OFF. */
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

/** Fresh enabled-map from registry defaults (also the pre-hydration renderer state). */
export function defaultModulesEnabled(): Record<ModuleId, boolean> {
  return Object.fromEntries(MODULES.map((def) => [def.id, def.defaultOn])) as Record<
    ModuleId,
    boolean
  >
}

export const ModulesApi = {
  get: 'modules:get', // () => Promise<Record<ModuleId, boolean>>
  set: 'modules:set' // ({id, on}) => Promise<Record<ModuleId, boolean>>  persisted, returns full map
} as const

/** window.morzModules â€” exposed by the preload. */
export interface ModulesBridge {
  get(): Promise<Record<ModuleId, boolean>>
  set(id: ModuleId, on: boolean): Promise<Record<ModuleId, boolean>>
}

