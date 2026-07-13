/*
 * Lane store (Slices 5+6) — active Claude lanes, keyed by pane.
 * Assisted allows ONE lane per space (0.0.1 grid = one space); Manual never
 * creates lanes — the dial removes them all on the way into Manual.
 */
import { create } from 'zustand'

export interface ClaudeLaneInfo {
  paneId: string
  agentId: string
  cwd: string
}

interface LaneState {
  lanes: ClaudeLaneInfo[]
  addLane(lane: ClaudeLaneInfo): void
  removeLane(paneId: string): void
}

export const useLaneStore = create<LaneState>()((set) => ({
  lanes: [],
  addLane: (lane) =>
    set((s) =>
      s.lanes.some((l) => l.paneId === lane.paneId) ? s : { lanes: [...s.lanes, lane] }
    ),
  removeLane: (paneId) => set((s) => ({ lanes: s.lanes.filter((l) => l.paneId !== paneId) }))
}))
