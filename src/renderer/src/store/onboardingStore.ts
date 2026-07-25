import { create } from 'zustand'
import {
  minimalOnboardingSnapshot,
  type OnboardingDetection,
  type OnboardingSnapshot
} from '@shared/onboarding'
import { useModeStore } from './modeStore'

type OnboardingStatus = 'idle' | 'loading' | 'ready' | 'error'

interface OnboardingState {
  status: OnboardingStatus
  snapshot: OnboardingSnapshot
  detections: OnboardingDetection[]
  setupOpen: boolean
  error: string | null
  hydrate(): Promise<void>
  save(snapshot: OnboardingSnapshot): Promise<void>
  skip(): Promise<void>
  openSetup(): void
}

function safeMessage(error: unknown): string {
  return error instanceof Error && /onboarding/i.test(error.message)
    ? 'Setup could not be saved. Try again.'
    : 'Morz could not load setup. Restart the app to retry.'
}

export const useOnboardingStore = create<OnboardingState>((set, get) => ({
  status: 'idle',
  snapshot: minimalOnboardingSnapshot(false),
  detections: [],
  setupOpen: false,
  error: null,
  hydrate: async () => {
    if (get().status === 'loading' || get().status === 'ready') return
    set({ status: 'loading', error: null })
    try {
      const [snapshot, detections] = await Promise.all([
        window.morzOnboarding.get(),
        window.morzOnboarding.detect().catch(() => [] as OnboardingDetection[])
      ])
      useModeStore.getState().setMode(snapshot.autonomy)
      set({
        status: 'ready',
        snapshot,
        detections,
        setupOpen: !snapshot.completed,
        error: null
      })
    } catch (error) {
      set({ status: 'error', error: safeMessage(error) })
    }
  },
  save: async (snapshot) => {
    const saved = await window.morzOnboarding.save({ ...snapshot, completed: true })
    useModeStore.getState().setMode(saved.autonomy)
    set({ snapshot: saved, setupOpen: false, error: null })
  },
  skip: async () => {
    const saved = await window.morzOnboarding.save(minimalOnboardingSnapshot(true))
    useModeStore.getState().setMode('manual')
    set({ snapshot: saved, setupOpen: false, error: null })
  },
  openSetup: () => set({ setupOpen: true, error: null })
}))
