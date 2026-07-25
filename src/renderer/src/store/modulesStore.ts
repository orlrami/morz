/*
 * w15/shell-layout — enabled-modules store the icon rail renders from.
 * Agent 1 (w15/modules-core) owns the real persistence: main-process settings
 * DB behind window.morzModules. Until his branch merges, that bridge is absent
 * and this store falls back to ALL module surfaces enabled so every existing
 * view stays reachable (real gating + contract defaults arrive with Agent 1).
 * MERGE POINT: keep the bridge path, drop the all-on fallback for MODULES
 * defaultOn once modules-core lands.
 */
import { create } from 'zustand'
import { MODULES, type ModuleId, type ModulesBridge } from '@shared/modules'

function getModulesBridge(): ModulesBridge | undefined {
  return (window as unknown as { morzModules?: ModulesBridge }).morzModules
}

function fallbackEnabled(): Record<ModuleId, boolean> {
  const map = {} as Record<ModuleId, boolean>
  for (const def of MODULES) map[def.id] = true // interim all-on (see header)
  return map
}

interface ModulesState {
  enabled: Record<ModuleId, boolean>
  hydrated: boolean
  hydrate(): Promise<void>
  toggle(id: ModuleId): void
}

export const useModulesStore = create<ModulesState>((set, get) => ({
  enabled: fallbackEnabled(),
  hydrated: false,
  hydrate: async () => {
    if (get().hydrated) return
    const bridge = getModulesBridge()
    if (!bridge) {
      set({ hydrated: true })
      return
    }
    try {
      set({ enabled: await bridge.get(), hydrated: true })
    } catch {
      set({ hydrated: true }) // keep fallback; bridge errors stay non-fatal
    }
  },
  toggle: (id) => {
    const next = { ...get().enabled, [id]: !get().enabled[id] }
    set({ enabled: next })
    const bridge = getModulesBridge()
    if (bridge) {
      void bridge.set(id, next[id]).then(
        (persisted) => set({ enabled: persisted }),
        () => {} // persistence failure keeps the optimistic local state
      )
    }
  }
}))
