/*
 * Dispatched-pane observation bridge (w17/adapter-seam).
 *
 * Answers ORCH-AUDIT item 2: dispatched panes bypass the AgentAdapter seam, so
 * Morz cannot tell "waiting for approval" from "working" and metering reports
 * {usd:null,tokens:null}. Full rationale: docs/in-progress/SEAM-DESIGN.md.
 *
 * This is an OBSERVER, not a proxy. `observe()` is fed the PTY chunk main has
 * ALREADY relayed to the renderer; it takes a string, returns void, and has no
 * path back into the PTY. It cannot rewrite, delay or swallow a byte, so pane
 * fidelity is structurally unaffected.
 *
 * What it deliberately does NOT do: advance an agent to `done`. A terminal
 * title cannot express completion (fast turns skip `working` entirely, and
 * `idle` is also where a DENIED permission lands). Auto-completion is 0.0.7.
 *
 * Three ordering rules earn their complexity:
 *   - Ledger writes and UI pushes are coalesced to at most one per chunk. A
 *     chunk can legitimately carry thousands of titles, and one SQLite write
 *     plus one broadcast per title would stall the PTY relay behind it.
 *   - Metering reads are serialized per pane with a pending-rescan flag, so a
 *     turn ending while a read is in flight is re-read rather than dropped.
 *   - Teardown AWAITS a final read before detaching, or a run stopped mid-turn
 *     reports zero usage. Reads are idempotent, so the extra pass is free.
 */
import type { PlannedCli } from '../../shared/spawn-plan'
import type { AgentActivity, TitleCli } from '../../shared/agent-title-status'
import { createTitleTracker, type TitleTracker } from '../../shared/agent-title-status'
import { createOscTitleScanner, type OscTitleScanner } from '../../shared/osc-title'
import type { TranscriptReader } from './claude-usage'

export interface PaneRegistration {
  runId: string
  agentId: string
  cli: PlannedCli
  paneId: string
  /** Metering source; null disables the transcript read for this agent. */
  worktree: string | null
}

/** Normalized events for one dispatched agent. Same vocabulary as AdapterEvent,
 * carrying run identity because a dispatched pane is not a lane. */
export type PaneBridgeEvent =
  | { type: 'spawn'; runId: string; agentId: string; cli: PlannedCli; paneId: string; at: number }
  | {
      type: 'state'
      runId: string
      agentId: string
      activity: AgentActivity
      title: string
      at: number
    }
  | {
      type: 'usage'
      runId: string
      agentId: string
      inputTokens: number
      outputTokens: number
      at: number
    }
  | {
      type: 'exit'
      runId: string
      agentId: string
      code: number | null
      durationMs: number
      at: number
    }

export interface PaneBridgeDeps {
  /** Guarded run-store transition. May throw (terminal/illegal) — the bridge catches. */
  setAgentState(runId: string, agentId: string, state: 'running' | 'blocked'): void
  /** The ledger's CURRENT state, so the bridge never acts on a stale cache. */
  getAgentState(runId: string, agentId: string): string | null
  /** Newly observed tokens for this agent — a DELTA, never a running total. */
  trackUsage(runId: string, agentId: string, tokens: number): void
  /** Per-agent transcript reader, or null when this agent has nothing to read. */
  createUsageReader(worktree: string, since: number): TranscriptReader | null
  /** Broadcast the refreshed RunStatus. */
  push(runId: string): void
  now(): number
}

type Lifecycle = 'running' | 'blocked'

interface PaneState extends PaneRegistration {
  scanner: OscTitleScanner
  tracker: TitleTracker
  reader: TranscriptReader | null
  activity: AgentActivity | null
  /** Set only when THIS bridge moved the agent to blocked — it may only undo its own. */
  appliedBlocked: boolean
  startedAt: number
  /** No further observation is accepted (the pane died or the run is tearing down). */
  closed: boolean
  /** Detached: async work still in flight must no longer touch the ledger. */
  released: boolean
  scanning: boolean
  rescan: boolean
  scanPromise: Promise<void> | null
}

export interface PaneBridge {
  registerPane(registration: PaneRegistration): void
  /** Feed one already-relayed PTY chunk. Unknown or closed panes are ignored. */
  observe(paneId: string, data: string): void
  paneExited(paneId: string, code: number | null): void
  /** Final metered read for every pane of a run, then detach. Await before cleanup. */
  finalizeRun(runId: string): Promise<void>
  activity(runId: string, agentId: string): AgentActivity | null
  onEvent(listener: (event: PaneBridgeEvent) => void): () => void
}

/** The dispatcher's CLI ids map onto the classifier's title vocabularies. */
function titleCliFor(cli: PlannedCli): TitleCli {
  return cli === 'claude' || cli === 'codex' || cli === 'agy' ? cli : 'opencode'
}

export function createPaneBridge(deps: PaneBridgeDeps): PaneBridge {
  const panes = new Map<string, PaneState>()
  const listeners = new Set<(event: PaneBridgeEvent) => void>()

  const emit = (event: PaneBridgeEvent): void => {
    for (const listener of listeners) {
      try {
        listener(event)
      } catch {
        // an observer must not be able to break observation
      }
    }
  }

  /*
   * `idle` never means done — but it DOES end a wait. When the bridge itself
   * moved the agent to blocked and the CLI returns to its prompt (including
   * when the owner DENIED the approval), leaving the ledger blocked forever is
   * simply wrong. Only a block this bridge applied is cleared, and the decision
   * is made against the ledger's current state rather than a cached value that
   * Stop or the liveness watcher may already have invalidated.
   */
  const desiredLifecycle = (pane: PaneState, activity: AgentActivity): Lifecycle | null => {
    if (activity === 'waiting') return 'blocked'
    if (activity === 'working') return 'running'
    return pane.appliedBlocked ? 'running' : null
  }

  /** Returns true when the ledger actually changed (the caller coalesces the push). */
  const applyLifecycle = (pane: PaneState, activity: AgentActivity): boolean => {
    const desired = desiredLifecycle(pane, activity)
    if (desired === null) return false
    const current = deps.getAgentState(pane.runId, pane.agentId)
    if (current === null) return false // the agent row is gone
    if (current === desired) {
      // already there — keep the "we blocked it" bookkeeping truthful
      pane.appliedBlocked = desired === 'blocked' ? pane.appliedBlocked : false
      return false
    }
    try {
      deps.setAgentState(pane.runId, pane.agentId, desired)
      pane.appliedBlocked = desired === 'blocked'
      return true
    } catch {
      // terminal (stopped/failed) or illegal from the current state — the
      // observation stands, the lifecycle does not.
      return false
    }
  }

  /**
   * Serialized per pane: a request arriving mid-read sets `rescan` instead of
   * being dropped, so the last turn of a burst is never the one that is lost.
   */
  const runScans = (pane: PaneState): Promise<void> => {
    const reader = pane.reader
    if (!reader) return Promise.resolve()
    if (pane.scanning) {
      pane.rescan = true
      return pane.scanPromise ?? Promise.resolve()
    }
    pane.scanning = true
    const promise = (async () => {
      try {
        do {
          pane.rescan = false
          const usage = await reader.read()
          if (!usage || pane.released) continue
          const total = usage.inputTokens + usage.outputTokens
          if (total <= 0) continue
          deps.trackUsage(pane.runId, pane.agentId, total)
          emit({
            type: 'usage',
            runId: pane.runId,
            agentId: pane.agentId,
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            at: deps.now()
          })
          deps.push(pane.runId)
        } while (pane.rescan && !pane.released)
      } catch {
        // unreadable transcript — metering stays silent rather than guessing
      } finally {
        pane.scanning = false
        pane.scanPromise = null
      }
    })()
    pane.scanPromise = promise
    return promise
  }

  /**
   * Drain in-flight work, then take one guaranteed last reading before the pane
   * detaches. Reads are deduplicated per record, so the extra pass can only add
   * tokens that were genuinely not counted yet.
   */
  const finalize = async (pane: PaneState): Promise<void> => {
    pane.closed = true
    pane.activity = null
    try {
      await (pane.scanPromise ?? Promise.resolve())
      await runScans(pane)
    } catch {
      // teardown must never fail on a metering read
    } finally {
      pane.released = true
    }
  }

  return {
    registerPane(registration: PaneRegistration): void {
      const startedAt = deps.now()
      const pane: PaneState = {
        ...registration,
        scanner: createOscTitleScanner(),
        tracker: createTitleTracker(titleCliFor(registration.cli)),
        reader: registration.worktree
          ? deps.createUsageReader(registration.worktree, startedAt)
          : null,
        activity: null,
        appliedBlocked: false,
        startedAt,
        closed: false,
        released: false,
        scanning: false,
        rescan: false,
        scanPromise: null
      }
      panes.set(registration.paneId, pane)
      emit({
        type: 'spawn',
        runId: pane.runId,
        agentId: pane.agentId,
        cli: pane.cli,
        paneId: pane.paneId,
        at: startedAt
      })
    },

    observe(paneId: string, data: string): void {
      const pane = panes.get(paneId)
      if (!pane || pane.closed || !data) return
      let settled: AgentActivity | null = null
      let turnEnded = false
      // Every title is classified, in byte order: a working→idle pair coalesced
      // into one chunk must not collapse to just the last title, or the turn
      // end goes unnoticed. The state EVENTS are the honest record of that.
      for (const title of pane.scanner.push(data)) {
        const activity = pane.tracker.handle(title)
        if (!activity) continue
        pane.activity = activity
        settled = activity
        emit({
          type: 'state',
          runId: pane.runId,
          agentId: pane.agentId,
          activity,
          title,
          at: deps.now()
        })
        if (activity !== 'working') turnEnded = true
      }
      // The ledger only needs where the chunk LANDED. One SQLite write, one
      // broadcast and one metering read per chunk, however many titles it
      // carried — intermediate states inside a single chunk are sub-frame.
      if (settled && applyLifecycle(pane, settled)) deps.push(pane.runId)
      if (turnEnded) void runScans(pane)
    },

    paneExited(paneId: string, code: number | null): void {
      const pane = panes.get(paneId)
      if (!pane || pane.closed) return
      // The pane is gone, so a stale 'working' chip can never be true again —
      // this is the reliable signal a title-only reader does not have.
      emit({
        type: 'exit',
        runId: pane.runId,
        agentId: pane.agentId,
        code,
        durationMs: deps.now() - pane.startedAt,
        at: deps.now()
      })
      void finalize(pane).finally(() => {
        if (panes.get(paneId) === pane) panes.delete(paneId)
      })
    },

    async finalizeRun(runId: string): Promise<void> {
      const targets = [...panes.entries()].filter(([, pane]) => pane.runId === runId)
      await Promise.all(
        targets.map(async ([paneId, pane]) => {
          await finalize(pane)
          if (panes.get(paneId) === pane) panes.delete(paneId)
        })
      )
    },

    activity(runId: string, agentId: string): AgentActivity | null {
      for (const pane of panes.values()) {
        if (pane.runId === runId && pane.agentId === agentId) return pane.activity
      }
      return null
    },

    onEvent(listener: (event: PaneBridgeEvent) => void): () => void {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }
  }
}
