import { create } from 'zustand'
import type { MorzApi } from '@shared/ipc'
import type { MorzNotifyApi, NotifyItem } from '@shared/notify'

const TOAST_THROTTLE_MS = 30_000
const lastToastAt = new Map<string, number>()
let started = false

function notifyApi(): MorzNotifyApi | null {
  const morz = (window as unknown as { morz?: Partial<MorzApi> }).morz
  return morz?.notify && typeof morz.notify.list === 'function' ? morz.notify : null
}

function newestFirst(items: NotifyItem[]): NotifyItem[] {
  return [...items].sort((left, right) => (right.ts ?? 0) - (left.ts ?? 0))
}

function upsert(items: NotifyItem[], item: NotifyItem): NotifyItem[] {
  const existing = items.find((candidate) => candidate.id === item.id)
  if (existing && (existing.ts ?? 0) >= (item.ts ?? 0)) return items
  return newestFirst([item, ...items.filter((candidate) => candidate.id !== item.id)])
}

interface NotifyState {
  items: NotifyItem[]
  toast: NotifyItem | null
  bridgeAvailable: boolean
  start(): void
  markAllRead(): void
  dismiss(id: string): void
  runAction(id: string, actionId: string): void
  clearToast(): void
}

export const useNotifyStore = create<NotifyState>((set) => ({
  items: [],
  toast: null,
  bridgeAvailable: true,
  start: () => {
    if (started) return
    started = true
    const api = notifyApi()
    if (!api) {
      set({ bridgeAvailable: false })
      return
    }
    api.onPushed((item) => {
      const now = Date.now()
      const lastToast = lastToastAt.get(item.id) ?? 0
      const showToast = item.level === 'error' && now - lastToast >= TOAST_THROTTLE_MS
      if (showToast) lastToastAt.set(item.id, now)
      set((state) => ({
        items: upsert(state.items, item),
        toast: showToast ? item : state.toast
      }))
    })
    void api.list()
      .then((items) => set((state) => ({ items: newestFirst(items.reduce(upsert, state.items)) })))
      .catch(() => set({ bridgeAvailable: false }))
  },
  markAllRead: () => {
    notifyApi()?.markRead('*')
    set((state) => ({ items: state.items.map((item) => ({ ...item, read: true })) }))
  },
  dismiss: (id) => {
    notifyApi()?.dismiss(id)
    set((state) => ({ items: state.items.filter((item) => item.id !== id) }))
  },
  runAction: (id, actionId) => {
    notifyApi()?.action(id, actionId)
  },
  clearToast: () => set({ toast: null })
}))
