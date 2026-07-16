import { create } from 'zustand'
import type {
  MorzReportApi,
  ReportEngineConfig,
  ReportProvider,
  ReportResult
} from '@shared/report'

interface ReportState {
  config: ReportEngineConfig | null
  busy: boolean
  error: string
  testResult: ReportResult | null
  initialize(): Promise<void>
  selectProvider(provider: ReportProvider): Promise<void>
  saveModel(model: string): Promise<void>
  saveKey(provider: ReportProvider, key: string): Promise<void>
  clearKey(provider: ReportProvider): Promise<void>
  testProvider(): Promise<void>
}

let initialized = false

function bridge(): MorzReportApi | undefined {
  return (window.morz as typeof window.morz & { report?: MorzReportApi }).report
}

function messageOf(reason: unknown): string {
  const message = reason instanceof Error ? reason.message : String(reason)
  return message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '')
}

export const useReportStore = create<ReportState>((set, get) => ({
  config: null,
  busy: false,
  error: '',
  testResult: null,

  initialize: async () => {
    if (initialized) return
    const api = bridge()
    if (!api) {
      set({ error: 'Report AI bridge is unavailable.' })
      return
    }
    initialized = true
    try {
      set({ config: await api.config(), error: '' })
    } catch (reason) {
      initialized = false
      set({ error: messageOf(reason) })
    }
  },

  selectProvider: async (provider) => {
    const api = bridge()
    if (!api) return
    set({ busy: true, error: '', testResult: null })
    try {
      set({ config: await api.setProvider(provider) })
    } catch (reason) {
      set({ error: messageOf(reason) })
    } finally {
      set({ busy: false })
    }
  },

  saveModel: async (model) => {
    const api = bridge()
    const provider = get().config?.provider
    if (!api || !provider || provider === 'claude-cli') return
    set({ busy: true, error: '', testResult: null })
    try {
      set({ config: await api.setProvider(provider, model) })
    } catch (reason) {
      set({ error: messageOf(reason) })
    } finally {
      set({ busy: false })
    }
  },

  saveKey: async (provider, key) => {
    const api = bridge()
    if (!api) return
    set({ busy: true, error: '', testResult: null })
    try {
      set({ config: await api.setKey(provider, key) })
    } catch (reason) {
      set({ error: messageOf(reason) })
    } finally {
      set({ busy: false })
    }
  },

  clearKey: async (provider) => {
    const api = bridge()
    if (!api) return
    set({ busy: true, error: '', testResult: null })
    try {
      set({ config: await api.clearKey(provider) })
    } catch (reason) {
      set({ error: messageOf(reason) })
    } finally {
      set({ busy: false })
    }
  },

  testProvider: async () => {
    const api = bridge()
    if (!api) return
    set({ busy: true, error: '', testResult: null })
    try {
      set({ testResult: await api.test() })
    } catch (reason) {
      set({ error: messageOf(reason) })
    } finally {
      set({ busy: false })
    }
  }
}))
