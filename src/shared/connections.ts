/*
 * CLI connections contract (dogfood wave — "how does Morz know which CLIs?").
 * Morz automates launching the user's OWN CLIs, so it must DETECT which are
 * installed + logged in, their plan/model, and which pane is running which.
 * Powers: Settings → Connections, the real Limits & Usage panel, and the
 * pill-bar / active-lane "what model is running" labels.
 * Owner: the `connections` agent implements detection; `lanes-runs` consumes
 * the model-label helper. ADDITIVE only during the wave.
 */

export type CliId = 'claude' | 'codex' | 'agy' | 'opencode'

export interface CliUpdateState {
  /** True only when the CLI/package manager reported a newer version. */
  available: boolean
  /** Version reported by the CLI's own diagnostic/update-check output. */
  latestVersion: string | null
  /** Human-readable command shown beside the explicit update action. */
  command: string
}

export interface CliConnection {
  id: CliId
  label: string // "Claude Code", "Codex", "Antigravity", "OpenCode"
  installed: boolean // last known install state (kept when a re-probe stops finding it)
  /**
   * The executable resolved on PATH at the MOST RECENT probe. `installed` is
   * last-known state: a CLI that disappears keeps installed:true and a stale
   * version so the UI stays honest, but it is no longer present and must not
   * be offered for a new run (w17 review).
   */
  present: boolean
  version: string | null
  /** Epoch ms of the most recent probe attempt. */
  detectedAt: number
  /** A failed probe kept the last known version; never present it as fresh. */
  versionStale: boolean
  /** Lower-version duplicate installs found on PATH; surfaced, never silent (w16). */
  duplicates?: string[]
  /** Null unless a newer version was reported and a safe updater is known. */
  update: CliUpdateState | null
  /** Logged in / usable (best-effort probe; null = unknown). */
  authed: boolean | null
  /** Plan or account tier if the CLI exposes it (e.g. "Max", "Pro"); else null. */
  plan: string | null
  /** Default model the CLI reports, if any. */
  model: string | null
  /** Rolling-window usage if the CLI/local logs expose it; null = no data (first-class). */
  usage: { usedPct: number | null; resetsAt: string | null } | null
}

export const ConnectionsApi = {
  list: 'connections:list', // () => Promise<CliConnection[]>  detect all
  refresh: 'connections:refresh', // () => Promise<CliConnection[]>  re-probe
  update: 'connections:update', // (CliId) => Promise<{ paneId: string }> explicit user action
  changed: 'connections:changed' // push → CliConnection[]
} as const

export interface MorzConnectionsApi {
  list(): Promise<CliConnection[]>
  refresh(): Promise<CliConnection[]>
  update(id: CliId): Promise<{ paneId: string }>
  onChanged(cb: (conns: CliConnection[]) => void): () => void
}

/**
 * Planner eligibility: only a CLI whose executable is on PATH right now may be
 * proposed for a run. `installed` alone is last-known state, so a CLI the user
 * uninstalled would otherwise stay plannable forever (w17 review).
 */
export function isPlannerEligible(connection: CliConnection): boolean {
  return connection.installed && connection.present
}

/**
 * Resolving a CLI on PATH has three outcomes, and they must not be collapsed:
 * `probe-error` (the lookup timed out, could not spawn, or overflowed its
 * output budget) is NOT evidence that the CLI is gone. Only an authoritative
 * `absent` may clear presence — otherwise one flaky lookup evicts a working
 * CLI from planning until a later probe happens to succeed (w17 review).
 */
export type PathResolution =
  | { kind: 'found'; candidates: string[] }
  | { kind: 'absent' }
  | { kind: 'probe-error' }

/**
 * Classify a PATH lookup. Windows `where.exe` exits 1 for an authoritative
 * "no match"; every other failure — exit 2, a timeout or spawn failure, an
 * output overflow (exitCode null) — leaves presence unknown.
 */
export function classifyPathProbe(
  probe: { ok: boolean; exitCode: number | null },
  candidates: readonly string[]
): PathResolution {
  if (!probe.ok) return probe.exitCode === 1 ? { kind: 'absent' } : { kind: 'probe-error' }
  return candidates.length > 0 ? { kind: 'found', candidates: [...candidates] } : { kind: 'absent' }
}

/** Presence after a re-probe: a probe error keeps the last good answer. */
export function presenceAfterProbe(resolution: PathResolution, wasPresent: boolean): boolean {
  if (resolution.kind === 'found') return true
  return resolution.kind === 'absent' ? false : wasPresent
}

/** Map a spawned pane's argv/exe to the CliId it is running (shared by detection + lanes). */
export function cliOfExecutable(exe: string): CliId | null {
  const base = exe.toLowerCase().replace(/\.(exe|cmd|bat)$/, '')
  if (base.endsWith('claude')) return 'claude'
  if (base.endsWith('codex')) return 'codex'
  if (base.endsWith('agy') || base.includes('antigravity')) return 'agy'
  if (base.endsWith('opencode')) return 'opencode'
  return null
}
