import { create } from 'zustand'
import type {
  PulseBrief,
  PulseBridge,
  PulseMode,
  PulseSnapshot
} from '@shared/ipc'
import type { MorzNotifyApi, NotifyItem } from '@shared/notify'
import { useModeStore } from './modeStore'
import { selectActiveSpaceRoot, useSpaceStore } from './spaceStore'

interface PulseState {
  snapshot: PulseSnapshot | null
  loading: boolean
  running: boolean
  error: string | null
  noticeTitle: string | null
  viewerOpen: boolean
  initialize(): Promise<void>
  refresh(): Promise<void>
  configure(enabled: boolean, time: string): Promise<void>
  runNow(): Promise<void>
  setViewerOpen(open: boolean): void
}

function bridge(): PulseBridge {
  const api = (window as unknown as { morzPulse?: PulseBridge }).morzPulse
  if (!api) throw new Error('Daily Pulse bridge is unavailable')
  return api
}

function notifyBridge(): MorzNotifyApi | undefined {
  return (window as unknown as { morz?: { notify?: MorzNotifyApi } }).morz?.notify
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '')
}

function currentContext(): { mode: PulseMode; spaceRoot: string } {
  return {
    mode: useModeStore.getState().mode,
    spaceRoot: selectActiveSpaceRoot(useSpaceStore.getState())
  }
}

async function handoffNotice(api: PulseBridge, item: NotifyItem): Promise<void> {
  const notify = notifyBridge()
  if (!notify) return
  notify.emit(item)
  try {
    const stored = await notify.list()
    if (stored.some((notice) => notice.id === item.id)) await api.ackNotice(item.id)
  } catch {
    // Keep the Pulse copy pending so it can be replayed after notify recovers.
  }
}

function openPulseSurface(brief?: PulseBrief): void {
  usePulseStore.setState((state) => ({
    snapshot:
      brief && state.snapshot
        ? {
            ...state.snapshot,
            briefs: [brief, ...state.snapshot.briefs.filter((item) => item.id !== brief.id)].slice(0, 14)
          }
        : state.snapshot,
    viewerOpen: true
  }))
  document.querySelector<HTMLButtonElement>('button[aria-label="Settings"]')?.click()
  requestAnimationFrame(() => {
    const control = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent?.trim() === 'Notifications'
    )
    control?.click()
  })
}

let listenersReady = false
let syncing = false
let syncPending = false

export const usePulseStore = create<PulseState>((set, get) => ({
  snapshot: null,
  loading: false,
  running: false,
  error: null,
  noticeTitle: null,
  viewerOpen: false,
  initialize: async () => {
    if (!listenersReady) {
      listenersReady = true
      const api = bridge()
      api.onReady(({ brief, notice }) => {
        set((state) => ({
          snapshot: state.snapshot
            ? { ...state.snapshot, briefs: [brief, ...state.snapshot.briefs.filter((item) => item.id !== brief.id)].slice(0, 14), running: false }
            : state.snapshot,
          running: false,
          noticeTitle: notice.title,
          viewerOpen: true
        }))
      })
      api.onNotice((notice) => {
        void handoffNotice(api, notice)
        if (notice.level === 'error') set({ error: notice.detail ?? notice.title })
      })
      api.onOpen((brief) => {
        openPulseSurface(brief)
      })
      notifyBridge()?.onAction(({ actionId }) => {
        if (actionId === 'open-pulse') openPulseSurface()
      })
    }
    await get().refresh()
    await syncContext()
  },
  refresh: async () => {
    set({ loading: true, error: null })
    try {
      const api = bridge()
      const next = await api.snapshot()
      set({ snapshot: next, loading: false })
      for (const notice of next.pendingNotices) {
        void handoffNotice(api, notice)
      }
    } catch (error) {
      set({ loading: false, error: errorMessage(error) })
    }
  },
  configure: async (enabled, time) => {
    set({ loading: true, error: null })
    try {
      const next = await bridge().configure({ enabled, time, ...currentContext() })
      set({ snapshot: next, loading: false })
    } catch (error) {
      set({ loading: false, error: errorMessage(error) })
    }
  },
  runNow: async () => {
    set({ running: true, error: null, noticeTitle: null })
    try {
      const brief = await bridge().runNow(currentContext())
      set((state) => ({
        snapshot: state.snapshot
          ? { ...state.snapshot, briefs: [brief, ...state.snapshot.briefs.filter((item) => item.id !== brief.id)].slice(0, 14), running: false }
          : state.snapshot,
        running: false,
        viewerOpen: true
      }))
    } catch (error) {
      set({ running: false, error: errorMessage(error) })
    }
  },
  setViewerOpen: (viewerOpen) => set({ viewerOpen })
}))

async function syncContext(): Promise<void> {
  if (syncing) {
    syncPending = true
    return
  }
  const state = usePulseStore.getState()
  const settings = state.snapshot?.settings
  if (!settings) return
  const context = currentContext()
  if (!context.spaceRoot && !settings.enabled) return
  if (settings.mode === context.mode && settings.spaceRoot === context.spaceRoot) return
  syncing = true
  try {
    const next = await bridge().configure({
      enabled: context.spaceRoot ? settings.enabled : false,
      time: settings.time,
      ...context
    })
    usePulseStore.setState({ snapshot: next, error: null })
  } catch (error) {
    usePulseStore.setState({ error: errorMessage(error) })
  } finally {
    syncing = false
    if (syncPending) {
      syncPending = false
      void syncContext()
    }
  }
}

useModeStore.subscribe(() => void syncContext())
useSpaceStore.subscribe((state, previous) => {
  if (selectActiveSpaceRoot(state) !== selectActiveSpaceRoot(previous)) void syncContext()
})

queueMicrotask(() => void usePulseStore.getState().initialize())

export function latestPulseBrief(snapshot: PulseSnapshot | null): PulseBrief | null {
  return snapshot?.briefs[0] ?? null
}
