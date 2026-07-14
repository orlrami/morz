/*
 * Mode store (Slice 6) — the control dial, real. "Assist, don't take over."
 * Manual is the default and provably inert: components must gate EVERY
 * window.morz.claude access on mode !== 'manual' so the adapter is never
 * instantiated or called (zero LLM calls — CI network-trace asserts this).
 * Orchestrated is available in 0.0.3, but every team remains hash-approval gated.
 */
import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export type MorzMode = 'manual' | 'assisted' | 'orchestrated'

export const ORCHESTRATED_AVAILABLE = true

/** Single gate for every Claude affordance (lane mount, start button, palette entry). */
export const claudeAllowed = (mode: MorzMode): boolean => mode === 'assisted'

interface ModeState {
  mode: MorzMode
  setMode(mode: MorzMode): void
}

export const useModeStore = create<ModeState>()(
  persist(
    (set) => ({
      mode: 'manual',
      setMode: (mode) => {
        if (mode === 'orchestrated' && !ORCHESTRATED_AVAILABLE) return
        set({ mode })
      }
    }),
    { name: 'morz.mode', version: 1 }
  )
)
