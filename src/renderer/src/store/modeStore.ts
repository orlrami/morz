/*
 * Mode store (Slice 6) — the control dial, real. "Assist, don't take over."
 * Manual is the default and provably inert: components must gate EVERY
 * window.morz.claude access on mode !== 'manual' so the adapter is never
 * instantiated or called (zero LLM calls — CI network-trace asserts this).
 * Orchestrated is a visible but disabled dial position until 0.0.3.
 */
import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export type MorzMode = 'manual' | 'assisted' | 'orchestrated'

export const ORCHESTRATED_AVAILABLE = false // ships in 0.0.3

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
