/*
 * Bus store (0.0.2, w4/handoff) — renderer mirror of the live blackboard.
 * Runtime-only (the SQLite board in Main is the source of truth).
 *
 * Mode gating: start() is only ever called from Assisted surfaces (the
 * OrchestratorPanel gates on modeStore like ClaudeLane) — in Manual nothing
 * subscribes and no bus IPC fires, so the handoff machinery is provably idle.
 */
import { create } from 'zustand'
import type { AgentId, Message, Task } from '@shared/bus'
import type { BusPendingApproval, MorzBusApi } from '@shared/bus-ipc'

/** The bus bridge, or undefined until the preload exposes it. */
export function getBus(): MorzBusApi | undefined {
  const m = (window as unknown as { morz?: { bus?: MorzBusApi } }).morz
  return m?.bus && typeof m.bus.snapshot === 'function' ? m.bus : undefined
}

interface BusState {
  tasks: Task[]
  messages: Message[]
  approvals: BusPendingApproval[]
  /** True once a snapshot has arrived (distinguishes empty board from no bridge). */
  live: boolean
  /** Subscribe + pull the initial snapshot. Idempotent; Assisted-only callers. */
  start(): void
  respondApproval(requestId: string, approved: boolean): void
  /** Dev command: simulate lane A posting a handoff targeting `to`. */
  simulateHandoff(to: AgentId): void
}

let subscribed = false

export const useBusStore = create<BusState>()((set) => ({
  tasks: [],
  messages: [],
  approvals: [],
  live: false,
  start: () => {
    const bus = getBus()
    if (!bus) return
    if (!subscribed) {
      subscribed = true
      // Contract has no unsubscribe (matches file/git/claude bridges) —
      // subscribe once per renderer lifetime.
      bus.onChanged((s) =>
        set({ tasks: s.tasks, messages: s.messages, approvals: s.approvals, live: true })
      )
    }
    void bus
      .snapshot()
      .then((s) =>
        set({ tasks: s.tasks, messages: s.messages, approvals: s.approvals, live: true })
      )
  },
  respondApproval: (requestId, approved) => {
    getBus()?.respondApproval({ requestId, approved })
  },
  simulateHandoff: (to) => {
    void getBus()?.post({
      from: 'claude-lane-a',
      to,
      title: 'Review the retry logic in catalog sync',
      text: 'Simulated handoff (dev command): lane A finished the fetcher change and hands review to you. Payload lives on the blackboard — respond via the bus, not this prompt.'
    })
  }
}))
