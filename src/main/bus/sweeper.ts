/*
 * Bus v0 (0.0.2) — lease sweeper. Every tick, re-opens expired 'working'
 * tasks back to 'accepted' (protocol.md working → accepted: the crashed-agent
 * path). Losing a wake notification is safe because this + poll-on-wake
 * recover (§6.2). Interval overridable via MORZ_BUS_SWEEP_MS for tests.
 */
import { sweepExpired } from './board'

const DEFAULT_INTERVAL_MS = 30_000

let timer: NodeJS.Timeout | null = null

export function startSweeper(
  onReclaimed?: (taskIds: string[]) => void,
  intervalMs = Number(process.env.MORZ_BUS_SWEEP_MS) || DEFAULT_INTERVAL_MS
): void {
  if (timer) return
  timer = setInterval(() => {
    try {
      const reclaimed = sweepExpired()
      if (reclaimed.length > 0) {
        console.error(`[bus] sweeper reclaimed expired leases: ${reclaimed.join(', ')}`)
        onReclaimed?.(reclaimed)
      }
    } catch (err) {
      console.error('[bus] sweeper tick failed:', err)
    }
  }, intervalMs)
}

export function stopSweeper(): void {
  if (timer) clearInterval(timer)
  timer = null
}
