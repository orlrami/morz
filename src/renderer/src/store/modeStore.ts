/*
 * Mode store (Slice 6) — the control dial, real. "Assist, don't take over."
 * Manual is the default and provably inert: components must gate EVERY
 * window.morz.claude access on mode !== 'manual' so the adapter is never
 * instantiated or called (zero LLM calls — CI network-trace asserts this).
 * Orchestrated is available in 0.0.3, but every team remains hash-approval gated.
 */
import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { MorzMemoryApi } from '../../../shared/memory'

export type MorzMode = 'manual' | 'assisted' | 'orchestrated'

export const ORCHESTRATED_AVAILABLE = true
const MODE_STORAGE_KEY = 'morz.mode'

/** Single gate for every Claude affordance (lane mount, start button, palette entry). */
export const claudeAllowed = (mode: MorzMode): boolean => mode === 'assisted'

interface ModeState {
  mode: MorzMode
  setMode(mode: MorzMode): Promise<boolean>
}

async function syncEventLogMode(mode: MorzMode): Promise<void> {
  if (typeof window === 'undefined') return
  const morz = window.morz as typeof window.morz & { memory?: MorzMemoryApi }
  if (!morz.memory) throw new Error('Memory bridge unavailable')
  await morz.memory.setEventLogMode(mode)
}

export const useModeStore = create<ModeState>()(
  persist(
    (set) => ({
      mode: 'manual',
      setMode: async (mode) => {
        if (mode === 'orchestrated' && !ORCHESTRATED_AVAILABLE) return false
        try {
          await syncEventLogMode(mode)
          set({ mode })
          return true
        } catch (error) {
          console.warn('[morz-mode] main-process mode sync failed:', error)
          return false
        }
      }
    }),
    { name: MODE_STORAGE_KEY, version: 1 }
  )
)

queueMicrotask(() => {
  void useModeStore.getState().setMode(useModeStore.getState().mode)
})

if (import.meta.env.DEV && typeof localStorage !== 'undefined') {
  useModeStore.subscribe(() => {
    queueMicrotask(() => {
      try {
        const mode = useModeStore.getState().mode
        const raw = localStorage.getItem(MODE_STORAGE_KEY)
        const persisted = raw
          ? (JSON.parse(raw) as { state?: { mode?: unknown } }).state?.mode
          : undefined
        console.assert(
          persisted === mode,
          `[morz-mode] persistence mismatch: store=${mode}, persisted=${String(persisted)}`
        )
      } catch (error) {
        console.assert(false, '[morz-mode] persisted mode could not be verified', error)
      }
    })
  })
}
