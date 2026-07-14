import { create } from 'zustand'
import type { CostBreach, CostBridge, CostSnapshot } from '@shared/ipc'

interface CostState {
  snapshot: CostSnapshot | null
  breach: CostBreach | null
  start(): void
  resume(): Promise<void>
  stop(): Promise<void>
}

let started = false

function bridge(): CostBridge | null {
  const value = (window as unknown as { morzCost?: CostBridge }).morzCost
  return value && typeof value.snapshot === 'function' ? value : null
}

function breachFrom(snapshot: CostSnapshot): CostBreach | null {
  return snapshot.activeRun?.breach ?? null
}

export const useCostStore = create<CostState>((set, get) => ({
  snapshot: null,
  breach: null,
  start: () => {
    if (started) return
    const api = bridge()
    if (!api) return
    started = true
    api.onUpdated((snapshot) => set({ snapshot, breach: breachFrom(snapshot) }))
    api.onBreach((breach) => set({ breach }))
    void api.snapshot().then((snapshot) => set({ snapshot, breach: breachFrom(snapshot) }))
  },
  resume: async () => {
    const api = bridge()
    const runId = get().breach?.runId
    if (!api || !runId) return
    const snapshot = await api.resume(runId)
    set({ snapshot, breach: breachFrom(snapshot) })
  },
  stop: async () => {
    const api = bridge()
    const runId = get().breach?.runId
    if (!api || !runId) return
    const snapshot = await api.stop(runId)
    set({ snapshot, breach: breachFrom(snapshot) })
  }
}))
