import { create } from 'zustand'
import type {
  SessionHistoryBridge,
  SessionHistoryRecord,
  SessionHistoryStartInput
} from '@shared/ipc'

interface SessionsWindow {
  morzSessions?: SessionHistoryBridge
}

export interface SessionsState {
  spaceRoot: string
  sessions: SessionHistoryRecord[]
  current: SessionHistoryRecord | null
  loading: boolean
  error: string | null
  refresh(spaceRoot: string): Promise<void>
  activate(input: SessionHistoryStartInput): Promise<void>
  endCurrent(): Promise<void>
}

let requestGeneration = 0

function api(): SessionHistoryBridge | undefined {
  return (window as unknown as SessionsWindow).morzSessions
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Session history is unavailable.'
}

export const useSessionsStore = create<SessionsState>((set, get) => ({
  spaceRoot: '',
  sessions: [],
  current: null,
  loading: false,
  error: null,
  refresh: async (spaceRoot) => {
    const bridge = api()
    const generation = ++requestGeneration
    if (!bridge || !spaceRoot) {
      set({ spaceRoot, sessions: [], current: null, loading: false, error: null })
      return
    }
    set({ spaceRoot, loading: true, error: null })
    try {
      const [sessions, current] = await Promise.all([
        bridge.list(spaceRoot),
        bridge.current(spaceRoot)
      ])
      if (generation !== requestGeneration) return
      set({ sessions, current, loading: false })
    } catch (error) {
      if (generation !== requestGeneration) return
      set({ sessions: [], current: null, loading: false, error: errorMessage(error) })
    }
  },
  activate: async (input) => {
    const bridge = api()
    const generation = ++requestGeneration
    if (!bridge) return
    set({ spaceRoot: input.spaceRoot, loading: true, error: null })
    try {
      const current = await bridge.start(input)
      const sessions = await bridge.list(input.spaceRoot)
      if (generation !== requestGeneration) return
      set({ sessions, current, loading: false })
    } catch (error) {
      if (generation !== requestGeneration) return
      set({ loading: false, error: errorMessage(error) })
    }
  },
  endCurrent: async () => {
    const bridge = api()
    const current = get().current
    if (!bridge || !current) return
    try {
      await bridge.end(current.id)
      await get().refresh(get().spaceRoot)
    } catch (error) {
      set({ error: errorMessage(error) })
    }
  }
}))
