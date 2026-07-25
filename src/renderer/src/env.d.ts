/// <reference types="vite/client" />

import type { MorzApi } from '@shared/ipc'
import type { MorzOnboardingApi } from '@shared/onboarding'

export {}

declare global {
  interface Window {
    /** Published by the preload (owner: Agent 1). Undefined in renderer-only dev. */
    morz: MorzApi
    morzOnboarding: MorzOnboardingApi
  }
}
