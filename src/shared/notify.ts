/*
 * In-app notification / error-surface contract (0.0.3, wave-6 seam).
 * Background work (catalog sync, Daily Pulse, dispatch, adapters) must NEVER
 * fail silently to console — every failure/notice flows through here so the
 * user sees it in the app (toast + a persistent Notification Center). Owner:
 * the wave-6 `errors` agent implements the center; every other producer emits
 * into it. ADDITIVE changes only during the wave.
 */

export type NotifyLevel = 'info' | 'success' | 'warning' | 'error'

/** Where a notice came from — groups + dedupes the Notification Center. */
export type NotifySource =
  | 'catalog' // Workshop registry/stars/benchmarks background sync
  | 'pulse' // Daily Pulse
  | 'dispatch' // orchestration run lifecycle
  | 'adapter' // a CLI adapter (claude/codex/agy)
  | 'assistant' // bring-your-own-assistant bridge
  | 'organizer'
  | 'app' // generic / uncategorized

export interface NotifyAction {
  /** Stable id the renderer maps to a handler (e.g. 'retry-sync', 'open-settings'). */
  id: string
  label: string
}

export interface NotifyItem {
  /** Stable id — re-emitting the same id UPDATES the notice (no duplicate spam). */
  id: string
  level: NotifyLevel
  source: NotifySource
  title: string
  /** Longer human detail (an error message, a hint). Shortest decisive line — not a stack dump. */
  detail?: string
  /** Epoch ms — stamped by Main on ingest (producers may omit). */
  ts?: number
  /** Optional actionable buttons (retry, open settings, dismiss is implicit). */
  actions?: NotifyAction[]
  /** True once the user has seen/cleared it (Center state, set by Main). */
  read?: boolean
}

export const NotifyApi = {
  /** producer → Main: raise/update a notice (id-keyed upsert). */
  emit: 'notify:emit', // (NotifyItem)  ts stamped by Main
  /** Main → renderer: one notice pushed (toast + Center). */
  pushed: 'notify:pushed', // → NotifyItem
  /** renderer → Main: fetch the full Center list (persisted, newest first). */
  list: 'notify:list', // () => Promise<NotifyItem[]>
  /** renderer → Main: mark read / dismiss. */
  markRead: 'notify:mark-read', // (id | '*')
  dismiss: 'notify:dismiss', // (id | '*')
  /** renderer → Main: a producer action button was clicked. */
  action: 'notify:action' // ({ id, actionId })
} as const

/** window.morz.notify — exposed by the preload (owner: errors agent). */
export interface MorzNotifyApi {
  emit(item: NotifyItem): void
  list(): Promise<NotifyItem[]>
  markRead(id: string): void
  dismiss(id: string): void
  onPushed(cb: (item: NotifyItem) => void): () => void
  onAction(cb: (payload: { id: string; actionId: string }) => void): () => void
}
