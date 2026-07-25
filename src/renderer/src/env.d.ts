/// <reference types="vite/client" />

import type { MorzApi } from '@shared/ipc'
import type { ModulesBridge } from '@shared/modules'

export {}

declare global {
  interface Window {
    /** Published by the preload (owner: Agent 1). Undefined in renderer-only dev. */
    morz: MorzApi
    /** Agent 1's module bridge; optional until w15/modules-core is integrated. */
    morzModules?: ModulesBridge
    /** E2E-only synchronous module seam. Never published in production. */
    morzContextE2eEnabled?: boolean
  }
}
