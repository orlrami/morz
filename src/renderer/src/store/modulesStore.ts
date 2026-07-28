/*
 * Modules store (w15/modules-core) — renderer truth for which modules are on.
 * Hydrated from the settings DB at boot (window.morzModules); every gate in
 * the shell (tabs, mounts, sync registration, palette actions) reads this.
 *
 * Autonomy interlock: the Orchestrated dial requires the orchestration module.
 * Disabling orchestration while the dial is Orchestrated drops the dial to
 * Manual (winding down lanes exactly like the dial's own Manual switch) and
 * raises a visible notice.
 */
import { create } from 'zustand'
import {
  MODULES,
  defaultModulesEnabled,
  type ModuleId,
  type ModulesBridge
} from '@shared/modules'
import type { MorzNotifyApi } from '@shared/notify'
import { useLaneStore } from './laneStore'
import { useLayoutStore } from './layoutStore'
import { useModeStore } from './modeStore'
import { getMorz } from './spaceStore'

function bridge(): ModulesBridge | undefined {
  return (window as unknown as { morzModules?: ModulesBridge }).morzModules
}

function notifyBridge(): MorzNotifyApi | undefined {
  return (window as unknown as { morz?: { notify?: MorzNotifyApi } }).morz?.notify
}

export const ORCHESTRATION_INTERLOCK_NOTICE_ID = 'modules:orchestration-interlock'

interface ModulesState {
  enabled: Record<ModuleId, boolean>
  hydrated: boolean
  hydrate(): Promise<void>
  setEnabled(id: ModuleId, on: boolean): Promise<void>
}

let hydration: Promise<void> | null = null

/** Drop the dial to Manual only after Main acknowledges the fail-closed gate. */
async function dropDialToManual(): Promise<void> {
  if (!(await useModeStore.getState().setMode('manual'))) {
    throw new Error('Main process did not acknowledge Manual mode')
  }
  const morz = getMorz()
  for (const lane of useLaneStore.getState().lanes) {
    morz?.claude.interrupt(lane.agentId)
    useLayoutStore.getState().removePane(lane.paneId)
    useLaneStore.getState().removeLane(lane.paneId)
  }
}

function notifyOrchestrationInterlock(): void {
  notifyBridge()?.emit({
    id: ORCHESTRATION_INTERLOCK_NOTICE_ID,
    level: 'warning',
    source: 'app',
    title: 'Autonomy dial dropped to Manual',
    detail:
      'The Orchestration module was disabled while the dial was set to Orchestrated. Re-enable the module to use Orchestrated again.'
  })
}

export const useModulesStore = create<ModulesState>((set, get) => ({
  enabled: defaultModulesEnabled(),
  hydrated: false,
  hydrate: () => {
    hydration ??= (async () => {
      const api = bridge()
      if (!api) {
        set({ hydrated: true })
        return
      }
      try {
        set({ enabled: await api.get(), hydrated: true })
      } catch {
        set({ hydrated: true }) // registry defaults stand; toggles will retry the bridge
      }
    })()
    return hydration
  },
  setEnabled: async (id, on) => {
    const api = bridge()
    const dropsOrchestration =
      id === 'orchestration' && !on && useModeStore.getState().mode === 'orchestrated'
    if (dropsOrchestration) await dropDialToManual()

    let next = { ...get().enabled }
    if (on) {
      // Contract: enabling a module brings its prerequisites with it.
      for (const requirement of MODULES.find((def) => def.id === id)?.requires ?? []) {
        next = api ? await api.set(requirement, true) : { ...next, [requirement]: true }
      }
    }
    next = api ? await api.set(id, on) : { ...next, [id]: on }
    set({ enabled: next })
    if (dropsOrchestration) notifyOrchestrationInterlock()
  }
}))

queueMicrotask(() => void useModulesStore.getState().hydrate())
