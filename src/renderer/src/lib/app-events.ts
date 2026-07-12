/*
 * Renderer-only event bus (mitt) — the seam between terminal, reviewer, and the IDE pane.
 * Contract types in shared/ipc.ts. Exposes BOTH the mitt instance (`appEvents`)
 * and the `emit`/`on`/`off` helpers so every consumer style works.
 */
import mitt from 'mitt'
import type { OpenFileEvent } from '@shared/ipc'

export type AppEvents = {
  /** Terminal link / reviewer → IDE pane. */
  'open-file': OpenFileEvent
  /** Ask the shell to focus a specific pane. */
  'focus-pane': { paneId: string }
}

export const appEvents = mitt<AppEvents>()

export const emit = appEvents.emit
export const on = appEvents.on
export const off = appEvents.off
