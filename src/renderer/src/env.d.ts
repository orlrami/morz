/// <reference types="vite/client" />

import type { MorzApi } from '@shared/ipc'
import type { SlotsBridge, SlotsTestBridge } from '@shared/slots'

export {}

declare global {
  interface Window {
    /** Published by the preload (owner: Agent 1). Undefined in renderer-only dev. */
    morz: MorzApi
    morzSlots: SlotsBridge
    morzSlotsTest?: SlotsTestBridge
  }
}
