import { create } from 'zustand'
import {
  DEFAULT_SLOT_CHOICES,
  type SlotAvailability,
  type SlotChoices,
  type SlotId,
  type SlotsBridge
} from '@shared/slots'

interface SlotsState {
  choices: SlotChoices
  availability: SlotAvailability
  hydrated: boolean
  loading: boolean
  error: string | null
  hydrate(): Promise<void>
  choose(id: SlotId, providerId: string): Promise<SlotChoices>
}

let hydration: Promise<void> | null = null

function bridge(): SlotsBridge | null {
  const api = (window as unknown as { morzSlots?: SlotsBridge }).morzSlots
  return api && typeof api.get === 'function' ? api : null
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export const useSlotsStore = create<SlotsState>((set, get) => ({
  choices: { ...DEFAULT_SLOT_CHOICES },
  availability: {},
  hydrated: false,
  loading: false,
  error: null,
  hydrate: async () => {
    if (get().hydrated) return
    if (hydration) return hydration
    const api = bridge()
    if (!api) {
      set({ hydrated: true })
      return
    }
    set({ loading: true, error: null })
    hydration = Promise.all([api.get(), api.availability()])
      .then(([choices, availability]) => {
        set({ choices, availability, hydrated: true, loading: false })
      })
      .catch((error) => {
        set({ error: errorMessage(error), hydrated: true, loading: false })
      })
      .finally(() => {
        hydration = null
      })
    return hydration
  },
  choose: async (id, providerId) => {
    const api = bridge()
    if (!api) throw new Error('Integration slots bridge is unavailable')
    const choices = await api.set(id, providerId)
    set({ choices, error: null })
    return choices
  }
}))

export function slotsBridge(): SlotsBridge | null {
  return bridge()
}
