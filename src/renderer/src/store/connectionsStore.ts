import { create } from 'zustand'
import type { CliConnection, MorzConnectionsApi } from '@shared/connections'

interface ConnectionsState {
  connections: CliConnection[]
  loading: boolean
  refreshing: boolean
  error: string | null
  start(): void
  refresh(): Promise<void>
}

type ConnectionsWindow = {
  morz?: { connections?: MorzConnectionsApi }
  morzConnections?: MorzConnectionsApi
}

let started = false

function bridge(): MorzConnectionsApi {
  const target = window as unknown as ConnectionsWindow
  const connections = target.morz?.connections ?? target.morzConnections
  if (!connections || typeof connections.list !== 'function') {
    throw new Error('Connections bridge is unavailable')
  }
  return connections
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export const useConnectionsStore = create<ConnectionsState>((set) => ({
  connections: [],
  loading: false,
  refreshing: false,
  error: null,
  start: () => {
    if (started) return
    started = true
    let api: MorzConnectionsApi
    try {
      api = bridge()
      api.onChanged((connections) => set({ connections, error: null }))
    } catch (error) {
      set({ error: errorMessage(error) })
      return
    }
    set({ loading: true, error: null })
    void api.list()
      .then((connections) => set({ connections, loading: false }))
      .catch((error) => set({ loading: false, error: errorMessage(error) }))
  },
  refresh: async () => {
    set({ refreshing: true, error: null })
    try {
      const connections = await bridge().refresh()
      set({ connections })
    } catch (error) {
      set({ error: errorMessage(error) })
    } finally {
      set({ refreshing: false })
    }
  }
}))
