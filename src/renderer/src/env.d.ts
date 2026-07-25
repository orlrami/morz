/// <reference types="vite/client" />

import type { MorzApi } from '@shared/ipc'
import type { SlotsBridge, SlotsTestBridge } from '@shared/slots'
import type { ModulesBridge } from '@shared/modules'

export {}

declare global {
  interface Window {
    /** Published by the preload (owner: Agent 1). Undefined in renderer-only dev. */
    morz: MorzApi
    morzSlots: SlotsBridge
    morzSlotsTest?: SlotsTestBridge
    /** w15/modules-core module registry bridge. */
    morzModules?: ModulesBridge
    /** E2E-only synchronous module seam. Never published in production. */
    morzContextE2eEnabled?: boolean
  }
}
