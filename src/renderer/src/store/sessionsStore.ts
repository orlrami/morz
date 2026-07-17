import { create } from 'zustand'
import type {
  SessionHistoryBridge,
  SessionHistoryRecord,
  SessionResumeBridge,
  SessionHistoryStartInput
} from '@shared/ipc'
import { newPaneId, useLayoutStore } from '@/store/layoutStore'
import { useLaneStore } from '@/store/laneStore'
import { useModeStore } from '@/store/modeStore'

interface SessionsWindow {
  morzSessions?: SessionHistoryBridge
  morzSessionsResume?: SessionResumeBridge
}

export interface SessionsState {
  spaceRoot: string
  sessions: SessionHistoryRecord[]
  current: SessionHistoryRecord | null
  loading: boolean
  error: string | null
  busyId: string | null
  refresh(spaceRoot: string): Promise<void>
  activate(input: SessionHistoryStartInput): Promise<void>
  endCurrent(): Promise<void>
  pin(id: string, pinned: boolean): Promise<void>
  resume(id: string): Promise<void>
}

let requestGeneration = 0

function api(): SessionHistoryBridge | undefined {
  return (window as unknown as SessionsWindow).morzSessions
}

function resumeApi(): SessionResumeBridge | undefined {
  return (window as unknown as SessionsWindow).morzSessionsResume
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
  busyId: null,
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
  },
  pin: async (id, pinned) => {
    const bridge = resumeApi()
    if (!bridge) return
    const spaceRoot = get().spaceRoot
    set({ busyId: id, error: null })
    try {
      await bridge.pin(id, pinned)
      const sessions = await api()?.list(spaceRoot)
      if (sessions && get().spaceRoot === spaceRoot) set({ sessions })
    } catch (error) {
      set({ error: errorMessage(error) })
    } finally {
      set({ busyId: null })
    }
  },
  resume: async (id) => {
    const bridge = resumeApi()
    if (!bridge) return
    set({ busyId: id, error: null })
    let createdPaneId: string | null = null
    try {
      const info = await bridge.resumeInfo(id)
      if (!info) throw new Error('This session is not available to resume.')

      useModeStore.getState().setMode('assisted')
      const lanes = useLaneStore.getState()
      const existing = lanes.lanes.find(
        (lane) =>
          lane.cwd.replace(/\\/g, '/').toLocaleLowerCase() ===
          info.cwd.replace(/\\/g, '/').toLocaleLowerCase()
      )
      const paneId = existing?.paneId ?? newPaneId('lane')
      const agentId = existing?.agentId ?? `${info.cli}-${paneId}`

      lanes.setSessionId(agentId, info.sessionId)
      if (existing) {
        useLayoutStore.getState().setActivePane(paneId)
      } else {
        createdPaneId = paneId
        lanes.addLane({ paneId, agentId, cwd: info.cwd })
        useLayoutStore.getState().addPane({
          paneId,
          kind: 'claude',
          cwd: info.cwd,
          shell: '',
          agentId
        })
      }

      await bridge.startLane({ id, agentId })
    } catch (error) {
      if (createdPaneId) {
        useLaneStore.getState().removeLane(createdPaneId)
        useLayoutStore.getState().removePane(createdPaneId)
      }
      set({ error: errorMessage(error) })
    } finally {
      set({ busyId: null })
    }
  }
}))
