import { create } from 'zustand'
import type {
  AssistantBridge,
  AssistantConnectionStatus,
  AssistantProvider,
  PlannerBridge,
  StoredSpawnPlan
} from '@shared/ipc'
import type { SpawnPlan } from '@shared/spawn-plan'
import { useModeStore } from './modeStore'

interface AssistantStoreState {
  providers: AssistantProvider[]
  selectedProviderId: string
  status: AssistantConnectionStatus
  record: StoredSpawnPlan | null
  busy: boolean
  statusText: string
  error: string
  activate(): Promise<void>
  deactivate(): void
  selectProvider(providerId: string): void
  connect(): Promise<void>
  disconnect(): Promise<void>
  propose(goal: string, spaceRoot: string): Promise<void>
  /** True only when Main accepted the edit (w17). */
  updatePlan(plan: SpawnPlan, expectedHash: string): Promise<boolean>
  approvePlan(planHash: string): Promise<void>
  discardPlan(planHash: string): Promise<void>
}

function assistantBridge(): AssistantBridge | undefined {
  return (window as unknown as { morzAssistant?: AssistantBridge }).morzAssistant
}

function plannerBridge(): PlannerBridge | undefined {
  return (window as unknown as { morzPlanner?: PlannerBridge }).morzPlanner
}

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason)
}

function notifyFailure(operation: 'connect' | 'propose' | 'approval', detail: string): void {
  const notify = (window as unknown as {
    morz?: {
      notify?: {
        emit(item: {
          id: string
          level: 'error'
          source: 'assistant'
          title: string
          detail: string
        }): void
      }
    }
  }).morz?.notify
  notify?.emit({
    id: `assistant-${operation}-failure`,
    level: 'error',
    source: 'assistant',
    title:
      operation === 'connect'
        ? 'Assistant connection failed'
        : operation === 'approval'
          ? 'Assistant approval failed'
          : 'Assistant proposal failed',
    detail
  })
}

const DISCONNECTED: AssistantConnectionStatus = { state: 'disconnected', providerId: null }

export const useAssistantStore = create<AssistantStoreState>((set, get) => ({
  providers: [],
  selectedProviderId: '',
  status: DISCONNECTED,
  record: null,
  busy: false,
  statusText: '',
  error: '',

  activate: async () => {
    const bridge = assistantBridge()
    if (!bridge) return
    set({ error: '' })
    try {
      await bridge.setEnabled(true)
      const [providers, status] = await Promise.all([bridge.listProviders(), bridge.status()])
      const selectedProviderId =
        status.providerId || get().selectedProviderId || providers[0]?.id || ''
      set({ providers, status, selectedProviderId })
    } catch (reason) {
      const detail = errorMessage(reason)
      set({ error: detail })
      notifyFailure('connect', detail)
    }
  },

  deactivate: () => {
    set({ busy: false, statusText: '', error: '' })
    void assistantBridge()?.setEnabled(false).catch((reason: unknown) => {
      const detail = errorMessage(reason)
      set({ error: detail })
      notifyFailure('connect', detail)
    })
  },

  selectProvider: (selectedProviderId) => set({ selectedProviderId, error: '' }),

  connect: async () => {
    const bridge = assistantBridge()
    const providerId = get().selectedProviderId
    if (!bridge || !providerId) return
    set({ busy: true, error: '', status: { state: 'connecting', providerId } })
    try {
      set({ status: await bridge.connect(providerId) })
    } catch (reason) {
      const detail = errorMessage(reason)
      set({ status: { state: 'error', providerId, detail }, error: detail })
      notifyFailure('connect', detail)
    } finally {
      set({ busy: false })
    }
  },

  disconnect: async () => {
    const bridge = assistantBridge()
    if (!bridge) return
    set({ busy: true, error: '' })
    try {
      set({ status: await bridge.disconnect() })
    } catch (reason) {
      const detail = errorMessage(reason)
      set({ error: detail })
      notifyFailure('connect', detail)
    } finally {
      set({ busy: false })
    }
  },

  propose: async (goal, spaceRoot) => {
    const bridge = assistantBridge()
    if (!bridge) return
    set({ busy: true, statusText: 'Asking assistant…', error: '' })
    try {
      const record = await bridge.propose(goal, spaceRoot)
      set({ record, statusText: '' })
    } catch (reason) {
      const detail = errorMessage(reason)
      set({ statusText: '', error: detail })
      notifyFailure('propose', detail)
    } finally {
      set({ busy: false })
    }
  },

  updatePlan: async (plan, expectedHash) => {
    const planner = plannerBridge()
    if (!planner) return false
    set({ busy: true, error: '' })
    try {
      set({ record: await planner.update(plan, expectedHash) })
      return true
    } catch (reason) {
      const detail = errorMessage(reason)
      set({ error: detail })
      notifyFailure('approval', detail)
      return false
    } finally {
      set({ busy: false })
    }
  },

  approvePlan: async (planHash) => {
    const planner = plannerBridge()
    if (!planner) return
    set({ busy: true, error: '' })
    try {
      const result = await planner.approveAndRun(planHash)
      set({ record: result.record, statusText: `Run ${result.runId}` })
    } catch (reason) {
      const detail = errorMessage(reason)
      set({ error: detail })
      notifyFailure('approval', detail)
    } finally {
      set({ busy: false })
    }
  },

  discardPlan: async (planHash) => {
    const planner = plannerBridge()
    if (!planner) return
    set({ busy: true, error: '' })
    try {
      await planner.discard(planHash)
      set({ record: null, statusText: '' })
    } catch (reason) {
      const detail = errorMessage(reason)
      set({ error: detail })
      notifyFailure('approval', detail)
    } finally {
      set({ busy: false })
    }
  }
}))

// Keep Main's fail-closed gate synchronized even when the Settings view is unmounted.
function syncAssistantMode(mode: ReturnType<typeof useModeStore.getState>['mode']): void {
  if (mode === 'orchestrated') void useAssistantStore.getState().activate()
  else useAssistantStore.getState().deactivate()
}

useModeStore.subscribe((state, previous) => {
  if (state.mode !== previous.mode) syncAssistantMode(state.mode)
})
queueMicrotask(() => syncAssistantMode(useModeStore.getState().mode))
