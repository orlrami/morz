/*
 * w15/modules-core CONTRACT (Agent 1 owns this file; Agent 2 codes against it).
 * MERGE POINT: if Agent 1's branch lands first, take his version verbatim —
 * the shapes below are the agreed wave-15 contract and must not drift.
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

export const ModulesApi = { get: 'modules:get', set: 'modules:set' } as const

export interface ModulesBridge {
  get(): Promise<Record<ModuleId, boolean>>
  set(id: ModuleId, on: boolean): Promise<Record<ModuleId, boolean>>
}
