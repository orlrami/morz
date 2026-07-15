import { create } from 'zustand'
import type {
  LocalModelStatus,
  RouteDecision,
  RouteOptions,
  RoutingBridge,
  RoutingRule
} from '@shared/ipc'

export function getRoutingBridge(): RoutingBridge | undefined {
  return (window as unknown as { morzRouting?: RoutingBridge }).morzRouting
}

interface RoutingState {
  rules: RoutingRule[]
  localModels: LocalModelStatus[]
  spaceRoot: string
  spacePrivate: boolean
  loading: boolean
  saving: boolean
  message: string
  error: string
  load(spaceRoot: string): Promise<void>
  updateRule(id: string, update: Partial<Pick<RoutingRule, 'target' | 'reason' | 'enabled'>> & {
    keywords?: string[]
    regex?: string[]
  }): void
  saveRules(): Promise<void>
  setSpacePrivate(spaceRoot: string, value: boolean): Promise<void>
  refreshLocalModels(): Promise<void>
  routeTask(taskText: string, options?: RouteOptions): Promise<RouteDecision | null>
}

function errorText(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}

export const useRoutingStore = create<RoutingState>((set, get) => ({
  rules: [],
  localModels: [],
  spaceRoot: '',
  spacePrivate: false,
  loading: false,
  saving: false,
  message: '',
  error: '',

  load: async (spaceRoot) => {
    const bridge = getRoutingBridge()
    if (!bridge) return
    set({ loading: true, error: '', message: '', spaceRoot })
    try {
      const snapshot = await bridge.snapshot(spaceRoot)
      set({
        rules: snapshot.rules,
        localModels: snapshot.localModels,
        spacePrivate: snapshot.spacePrivate
      })
    } catch (error) {
      set({ error: errorText(error) })
    } finally {
      set({ loading: false })
    }
  },

  updateRule: (id, update) => {
    set((state) => ({
      message: '',
      rules: state.rules.map((rule) =>
        rule.id === id
          ? {
              ...rule,
              ...update,
              match: {
                keywords: update.keywords ?? rule.match.keywords,
                regex: update.regex ?? rule.match.regex
              }
            }
          : rule
      )
    }))
  },

  saveRules: async () => {
    const bridge = getRoutingBridge()
    if (!bridge) return
    set({ saving: true, error: '', message: '' })
    try {
      const rules = await bridge.saveRules(get().rules)
      set({ rules, message: 'Routing rules saved' })
    } catch (error) {
      set({ error: errorText(error) })
    } finally {
      set({ saving: false })
    }
  },

  setSpacePrivate: async (spaceRoot, value) => {
    const bridge = getRoutingBridge()
    if (!bridge || !spaceRoot) return
    set({ error: '', message: '' })
    try {
      const spacePrivate = await bridge.setSpacePrivate(spaceRoot, value)
      set({ spacePrivate, message: spacePrivate ? 'Private routing enabled' : 'Private routing disabled' })
    } catch (error) {
      set({ error: errorText(error) })
    }
  },

  refreshLocalModels: async () => {
    const bridge = getRoutingBridge()
    if (!bridge) return
    set({ loading: true, error: '', message: '' })
    try {
      set({ localModels: await bridge.refreshLocalModels() })
    } catch (error) {
      set({ error: errorText(error) })
    } finally {
      set({ loading: false })
    }
  },

  routeTask: async (taskText, options = {}) => {
    const bridge = getRoutingBridge()
    if (!bridge) return null
    try {
      return await bridge.route(taskText, options)
    } catch (error) {
      set({ error: errorText(error) })
      return null
    }
  }
}))
