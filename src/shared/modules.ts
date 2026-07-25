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
  { id: 'pulse', label: 'Pulse', defaultOn: false },
  { id: 'voice', label: 'Voice', defaultOn: false },
  { id: 'obsidian', label: 'Obsidian', defaultOn: false }
]

export function defaultModules(): Record<ModuleId, boolean> {
  return Object.fromEntries(MODULES.map((module) => [module.id, module.defaultOn])) as Record<
    ModuleId,
    boolean
  >
}
