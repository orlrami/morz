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
import type { BusPendingApproval, BusSnapshot, MorzBusApi } from '@shared/bus-ipc'
import { selectActiveSpaceRoot, useSpaceStore } from './spaceStore'

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
  stop(): void
  respondApproval(requestId: string, approved: boolean): void
  /** Dev command: simulate lane A posting a handoff targeting `to`. */
  simulateHandoff(to: AgentId): void
}

let subscribed = false

/*
 * w14/orch-scoped — the mirror is scoped to the ACTIVE SPACE. Snapshots are
 * pulled per space (main filters), and pushes (always the full board) are
 * re-filtered here before they reach the UI, so the blackboard never shows
 * another project's history. Tasks without a spaceRoot (legacy / spaceless
 * callers) stay visible in every space.
 */
let lastSnapshot: BusSnapshot | null = null

function activeRoot(): string {
  return selectActiveSpaceRoot(useSpaceStore.getState())
}

function scopeSnapshot(s: BusSnapshot): Pick<BusState, 'tasks' | 'messages' | 'approvals'> {
  const spaceRoot = activeRoot()
  if (!spaceRoot) return { tasks: s.tasks, messages: s.messages, approvals: s.approvals }
  const tasks = s.tasks.filter((t) => !t.spaceRoot || t.spaceRoot === spaceRoot)
  const kept = new Set(tasks.map((t) => t.id))
  return {
    tasks,
    messages: s.messages.filter((m) => m.taskId === null || kept.has(m.taskId)),
    approvals: s.approvals.filter((a) => kept.has(a.taskId))
  }
}

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
      bus.onChanged((s) => {
        lastSnapshot = s
        set({ ...scopeSnapshot(s), live: true })
      })
    }
    if (!spaceSub) {
      spaceSub = useSpaceStore.subscribe((state) => {
        const root = selectActiveSpaceRoot(state)
        if (root === knownRoot) return
        knownRoot = root
        if (lastSnapshot) set(scopeSnapshot(lastSnapshot))
        void getBus()
          ?.snapshot(root || undefined)
          .then((s) => {
            lastSnapshot = s
            set({ ...scopeSnapshot(s), live: true })
          })
      })
    }
    
    knownRoot = activeRoot()
    void bus.snapshot(knownRoot || undefined).then((s) => {
      lastSnapshot = s
      set({ ...scopeSnapshot(s), live: true })
    })
  },
  stop: () => {
    unsubscribeBusStore()
  },
  respondApproval: (requestId, approved) => {
    getBus()?.respondApproval({ requestId, approved })
  },
  simulateHandoff: (to) => {
    void getBus()?.post({
      from: 'claude-lane-a',
      to,
      title: 'Review the retry logic in catalog sync',
      text: 'Simulated handoff (dev command): lane A finished the fetcher change and hands review to you. Payload lives on the blackboard — respond via the bus, not this prompt.',
      spaceRoot: activeRoot() || undefined // w14/orch-scoped
    })
  }
}))

// w14/orch-scoped — switching spaces swaps the whole blackboard: re-scope the
// last known board immediately, then pull a fresh per-space snapshot.
let knownRoot: string | null = null
let spaceSub: (() => void) | null = null

export function unsubscribeBusStore(): void {
  if (spaceSub) {
    spaceSub()
    spaceSub = null
  }
}

