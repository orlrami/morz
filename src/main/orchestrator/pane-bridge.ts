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
 */
import type { PlannedCli } from '../../shared/spawn-plan'
import type { AgentActivity } from '../../shared/agent-title-status'
import { createTitleTracker, type TitleTracker } from '../../shared/agent-title-status'
import { createOscTitleScanner, type OscTitleScanner } from '../../shared/osc-title'
import type { TranscriptUsage } from './claude-usage'

export interface PaneRegistration {
  runId: string
  agentId: string
  cli: PlannedCli
  paneId: string
  /** Metering source; null disables the transcript scan for this agent. */
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
  /** Cumulative token total for this agent; the meter converts it to a delta. */
  trackUsage(runId: string, agentId: string, tokens: number): void
  scanUsage(worktree: string): Promise<TranscriptUsage | null>
  /** Broadcast the refreshed RunStatus. */
  push(runId: string): void
  now(): number
}

interface PaneState extends PaneRegistration {
  scanner: OscTitleScanner
  tracker: TitleTracker
  activity: AgentActivity | null
  lifecycle: 'running' | 'blocked' | null
  startedAt: number
  scanning: boolean
}

export interface PaneBridge {
  registerPane(registration: PaneRegistration): void
  /** Feed one already-relayed PTY chunk. Unknown panes are ignored. */
  observe(paneId: string, data: string): void
  paneExited(paneId: string, code: number | null): void
  /** Forget every pane of a run (stop/cleanup). */
  releaseRun(runId: string): void
  activity(runId: string, agentId: string): AgentActivity | null
  onEvent(listener: (event: PaneBridgeEvent) => void): () => void
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

  /* `idle` moves nothing: it is reached by finishing AND by a denied approval. */
  const applyLifecycle = (pane: PaneState, activity: AgentActivity): void => {
    const next = activity === 'waiting' ? 'blocked' : activity === 'working' ? 'running' : null
    if (next === null || next === pane.lifecycle) return
    try {
      deps.setAgentState(pane.runId, pane.agentId, next)
      pane.lifecycle = next
      deps.push(pane.runId)
    } catch {
      // agent already terminal (stopped/failed) or the transition is illegal
      // from its current state — the observation stands, the lifecycle does not.
    }
  }

  /* A turn just ended — read the transcript once. Never overlapping. */
  const meter = (pane: PaneState): void => {
    if (!pane.worktree || pane.scanning) return
    const worktree = pane.worktree
    pane.scanning = true
    void deps
      .scanUsage(worktree)
      .then((usage) => {
        if (!usage) return
        const total = usage.inputTokens + usage.outputTokens
        if (total <= 0) return
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
      })
      .catch(() => {
        // unreadable transcript — metering stays silent rather than guessing
      })
      .finally(() => {
        pane.scanning = false
      })
  }

  return {
    registerPane(registration: PaneRegistration): void {
      const pane: PaneState = {
        ...registration,
        scanner: createOscTitleScanner(),
        tracker: createTitleTracker(),
        activity: null,
        lifecycle: null,
        startedAt: deps.now(),
        scanning: false
      }
      panes.set(registration.paneId, pane)
      emit({
        type: 'spawn',
        runId: pane.runId,
        agentId: pane.agentId,
        cli: pane.cli,
        paneId: pane.paneId,
        at: pane.startedAt
      })
    },

    observe(paneId: string, data: string): void {
      const pane = panes.get(paneId)
      if (!pane || !data) return
      // In byte order: a working→idle pair coalesced into one chunk must not
      // collapse to just the last title, or the turn end goes unnoticed.
      for (const title of pane.scanner.push(data)) {
        const activity = pane.tracker.handle(title)
        if (!activity) continue
        pane.activity = activity
        emit({
          type: 'state',
          runId: pane.runId,
          agentId: pane.agentId,
          activity,
          title,
          at: deps.now()
        })
        applyLifecycle(pane, activity)
        if (activity !== 'working') meter(pane)
      }
    },

    paneExited(paneId: string, code: number | null): void {
      const pane = panes.get(paneId)
      if (!pane) return
      panes.delete(paneId)
      // The pane is gone, so a stale 'working' chip can never be true again —
      // this is the reliable signal a title-only reader does not have.
      pane.activity = null
      meter(pane)
      emit({
        type: 'exit',
        runId: pane.runId,
        agentId: pane.agentId,
        code,
        durationMs: deps.now() - pane.startedAt,
        at: deps.now()
      })
    },

    releaseRun(runId: string): void {
      for (const [paneId, pane] of panes) {
        if (pane.runId === runId) panes.delete(paneId)
      }
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
