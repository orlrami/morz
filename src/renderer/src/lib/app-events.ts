/*
 * Renderer-only event bus (mitt) — the seam between terminal, explorer, reviewer,
 * and the IDE pane / shell layout. Contract types in shared/ipc.ts. Exposes BOTH
 * the mitt instance (`appEvents`) and the `emit`/`on`/`off` helpers.
 */
import mitt from 'mitt'
import type { OpenFileEvent } from '@shared/ipc'

export type AppEvents = {
  /** Terminal link / reviewer / explorer → IDE pane. */
  'open-file': OpenFileEvent
  /** Ask the shell to focus a specific pane. */
  'focus-pane': { paneId: string }
  /** Pane header (or shortcut) → shell removes this pane. */
  'close-pane': { paneId: string }
  /** Pane header (or shortcut) → shell splits this pane. */
  'split-pane': { paneId: string; dir: 'right' | 'down' }
}

export const appEvents = mitt<AppEvents>()

export const emit = appEvents.emit
export const on = appEvents.on
export const off = appEvents.off
