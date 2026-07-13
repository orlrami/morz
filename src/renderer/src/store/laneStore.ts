/*
 * Lane store (Slices 5+6) — active Claude lanes, keyed by pane.
 * Assisted allows ONE lane per space (0.0.1 grid = one space); Manual never
 * creates lanes — the dial removes them all on the way into Manual.
 *
 * `lanes` is runtime-only (Shell re-adds them from the session snapshot);
 * `sessions` + `meters` persist so a restarted lane can --resume its Claude
 * session and cost/token totals survive app restarts. "No data" (null) is a
 * first-class meter state — never coerced to a fake zero.
 */
import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export interface ClaudeLaneInfo {
  paneId: string
  agentId: string
  cwd: string
}

export interface LaneMeter {
  costUsd: number | null
  inputTokens: number | null
  outputTokens: number | null
}

const EMPTY_METER: LaneMeter = { costUsd: null, inputTokens: null, outputTokens: null }

interface LaneState {
  lanes: ClaudeLaneInfo[]
  /** agentId → Claude session_id to --resume on lane restart (from system/init). */
  sessions: Record<string, string>
  /** Running totals per agentId. Missing/null fields render as a grey dash. */
  meters: Record<string, LaneMeter>
  addLane(lane: ClaudeLaneInfo): void
  removeLane(paneId: string): void
  setSessionId(agentId: string, sessionId: string): void
  /** Accumulate one run's result usage; undefined fields leave "no data" alone. */
  addUsage(
    agentId: string,
    delta: { costUsd?: number; inputTokens?: number; outputTokens?: number }
  ): void
  /** ~/.claude JSONL fallback totals — only fills token meters that have no data. */
  setFallbackUsage(agentId: string, totals: { inputTokens: number; outputTokens: number }): void
}

export const useLaneStore = create<LaneState>()(
  persist(
    (set) => ({
      lanes: [],
      sessions: {},
      meters: {},
      addLane: (lane) =>
        set((s) =>
          s.lanes.some((l) => l.paneId === lane.paneId) ? s : { lanes: [...s.lanes, lane] }
        ),
      removeLane: (paneId) =>
        set((s) => {
          const gone = s.lanes.find((l) => l.paneId === paneId)
          if (!gone) return { lanes: s.lanes.filter((l) => l.paneId !== paneId) }
          const sessions = { ...s.sessions }
          const meters = { ...s.meters }
          delete sessions[gone.agentId]
          delete meters[gone.agentId]
          return { lanes: s.lanes.filter((l) => l.paneId !== paneId), sessions, meters }
        }),
      setSessionId: (agentId, sessionId) =>
        set((s) => ({ sessions: { ...s.sessions, [agentId]: sessionId } })),
      addUsage: (agentId, delta) =>
        set((s) => {
          const m = s.meters[agentId] ?? EMPTY_METER
          return {
            meters: {
              ...s.meters,
              [agentId]: {
                costUsd: delta.costUsd != null ? (m.costUsd ?? 0) + delta.costUsd : m.costUsd,
                inputTokens:
                  delta.inputTokens != null ? (m.inputTokens ?? 0) + delta.inputTokens : m.inputTokens,
                outputTokens:
                  delta.outputTokens != null
                    ? (m.outputTokens ?? 0) + delta.outputTokens
                    : m.outputTokens
              }
            }
          }
        }),
      setFallbackUsage: (agentId, totals) =>
        set((s) => {
          const m = s.meters[agentId] ?? EMPTY_METER
          if (m.inputTokens != null || m.outputTokens != null) return s // primary data wins
          return {
            meters: {
              ...s.meters,
              [agentId]: { ...m, inputTokens: totals.inputTokens, outputTokens: totals.outputTokens }
            }
          }
        })
    }),
    {
      name: 'morz.lanes',
      version: 1,
      partialize: (s) => ({ sessions: s.sessions, meters: s.meters })
    }
  )
)
