/*
 * Morz shared domain types (main <-> preload <-> renderer).
 * v0.1 stubs — expanded as Phase 1/2 land. Kept deliberately small.
 */

export type AgentState = 'working' | 'blocked' | 'idle' | 'done' | 'error'

/** Which AI CLI backs an agent. */
export type CliKind = 'claude' | 'codex' | 'agy' | 'opencode' | 'pi' | 'shell'

/** The control dial — "assist, don't take over". */
export type OrchestrationMode = 'manual' | 'assisted' | 'orchestrated'

export interface Space {
  id: string
  name: string
  cwd: string
  branch?: string
}

export interface Pane {
  id: string
  spaceId: string
  title: string
  cli: CliKind
}

export interface Agent {
  id: string
  paneId: string
  name: string
  cli: CliKind
  model?: string
  state: AgentState
  worktree?: string
}

/** Bus message between agents (replaces the manual markdown-file handoff). */
export interface BusMessage {
  id: string
  from: string
  to?: string
  kind: 'handoff' | 'decision' | 'blocked' | 'status' | 'result'
  body: string
  ts: number
}

/** The IPC surface exposed to the renderer via the preload bridge. */
export interface MorzApi {
  version: string
  // Phase 1+: pty.spawn / pty.write / pty.resize / pty.onData / spaces.* / orchestrator.* / bus.*
}
