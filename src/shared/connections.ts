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
  installed: boolean // resolved on PATH
  version: string | null
  /** Epoch ms of the most recent probe attempt. */
  detectedAt: number
  /** A failed probe kept the last known version; never present it as fresh. */
  versionStale: boolean
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

/** Map a spawned pane's argv/exe to the CliId it is running (shared by detection + lanes). */
export function cliOfExecutable(exe: string): CliId | null {
  const base = exe.toLowerCase().replace(/\.(exe|cmd|bat)$/, '')
  if (base.endsWith('claude')) return 'claude'
  if (base.endsWith('codex')) return 'codex'
  if (base.endsWith('agy') || base.includes('antigravity')) return 'agy'
  if (base.endsWith('opencode')) return 'opencode'
  return null
}
