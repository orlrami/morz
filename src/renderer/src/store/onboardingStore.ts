import { create } from 'zustand'
import {
  minimalOnboardingSnapshot,
  type OnboardingDetection,
  type OnboardingSnapshot
} from '@shared/onboarding'
import { useModeStore } from './modeStore'
// w15 integration — first-run module picks must land in the canonical registry
// store (w15/modules-core); the onboarding snapshot is the wizard's view of it,
// never a second source of truth for gating.
import { useModulesStore } from './modulesStore'
import { isModuleId } from '@shared/modules'

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

/** Push the wizard's module picks into the registry store, one persisted toggle each. */
async function applyModules(modules: Record<string, boolean>): Promise<void> {
  const store = useModulesStore.getState()
  for (const [id, on] of Object.entries(modules)) {
    if (!isModuleId(id) || store.enabled[id] === on) continue
    await store.setEnabled(id, on)
  }
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
        window.morzOnboarding.detect().catch(() => [] as OnboardingDetection[]),
        // The registry is the source of truth for what is enabled; the wizard
        // shows it rather than a parallel default map (w15 integration).
        useModulesStore.getState().hydrate()
      ])
      // Setup CHOOSES the dial once (save/skip below); it must never re-apply
      // that choice on later boots — the dial persists on its own, and moving
      // it in the status bar is the user's decision, not setup's.
      if (!snapshot.completed) useModeStore.getState().setMode(snapshot.autonomy)
      set({
        status: 'ready',
        snapshot: { ...snapshot, modules: { ...useModulesStore.getState().enabled } },
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
    await applyModules(saved.modules)
    set({ snapshot: saved, setupOpen: false, error: null })
  },
  skip: async () => {
    const saved = await window.morzOnboarding.save(minimalOnboardingSnapshot(true))
    useModeStore.getState().setMode('manual')
    await applyModules(saved.modules)
    set({ snapshot: saved, setupOpen: false, error: null })
  },
  /* Re-running setup must show what the app is actually running: the registry
   * store is the source of truth, so seed the wizard from it rather than from a
   * snapshot that predates any drawer/palette toggle. */
  openSetup: () =>
    set((state) => ({
      setupOpen: true,
      error: null,
      snapshot: { ...state.snapshot, modules: { ...useModulesStore.getState().enabled } }
    }))
}))
