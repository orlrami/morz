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
  setMode(mode: MorzMode): void
}

function syncEventLogMode(mode: MorzMode): void {
  if (typeof window === 'undefined') return
  const morz = window.morz as typeof window.morz & { memory?: MorzMemoryApi }
  void morz.memory?.setEventLogMode(mode).catch((error: unknown) => {
    console.warn('[morz-mode] main-process mode sync failed:', error)
  })
}

export const useModeStore = create<ModeState>()(
  persist(
    (set) => ({
      mode: 'manual',
      setMode: (mode) => {
        if (mode === 'orchestrated' && !ORCHESTRATED_AVAILABLE) return
        syncEventLogMode(mode)
        set({ mode })
      }
    }),
    { name: MODE_STORAGE_KEY, version: 1 }
  )
)

queueMicrotask(() => syncEventLogMode(useModeStore.getState().mode))

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
