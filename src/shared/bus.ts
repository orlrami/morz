/*
 * Agent-to-agent protocol types — MIRRORS docs/protocol.md v1 (FROZEN).
 * Task → Message → Part → Artifact. Change policy: ADDITIVE ONLY — new
 * optional fields / Part kinds / TaskState values bump the minor version;
 * renames/removals need a v2 with migration. Consumers MUST ignore unknown
 * fields and unknown Part.kind / TaskState values.
 *
 * Shared by the bus (task board, mailbox, pipe server), the morz-mcp shim,
 * and the adapters. Wave-4 seam: edit ONLY additively, keep protocol.md in
 * lockstep.
 */

/** Stable identity of one agent lane, e.g. "claude-lane-3", or "morz" (Main as coordinator). */
export type AgentId = string
/** ULID/GUID minted by Main. Unique per task board. */
export type TaskId = string
/** ULID/GUID minted by the sender. Unique per mailbox. */
export type MessageId = string

export const PROTOCOL_VERSION = '1.0' as const

export type TaskState =
  | 'proposed' // suggested by an agent or the user; not yet claimable
  | 'accepted' // approved (chip in Assisted); claimable
  | 'working' // claimed by exactly one agent (lease held)
  | 'blocked' // claimant cannot proceed; blockedReason set
  | 'done' // terminal; artifacts attached

export interface Task {
  protocolVersion: '1.0'
  id: TaskId
  state: TaskState
  title: string
  createdBy: AgentId
  /** Who holds it now (state 'working' | 'blocked'), else null. */
  assignee: AgentId | null
  createdAt: string // ISO-8601 UTC with ms
  updatedAt: string
  /** Tasks that must be 'done' before this one is claimable (DAG deps). */
  dependsOn: TaskId[]
  /** Required when state is 'blocked'. */
  blockedReason?: string
  /** Claim lease expiry while 'working' — sweeper re-opens past this. */
  leaseUntil?: string
  artifacts: Artifact[]
}

export interface Message {
  protocolVersion: '1.0'
  id: MessageId
  /** Stamped by Main — never trusted from the agent. */
  from: AgentId
  /** Target agent, or "morz" for the coordinator. */
  to: AgentId
  /** Null only for broadcast notices (rare). */
  taskId: TaskId | null
  ts: string // stamped by Main on ingest
  parts: Part[] // at least one
}

export type Part = TextPart | FilePart | DiffPart | CommandPart | ApprovalRequestPart

export interface TextPart {
  kind: 'text'
  text: string // Markdown allowed
}

/** Pointer to a file — never inline content; mtime detects staleness. */
export interface FilePart {
  kind: 'file'
  path: string // absolute, or relative to the Space root
  mtimeMs: number
  line?: number
  col?: number
}

/** Unified diff, self-contained (headers included). */
export interface DiffPart {
  kind: 'diff'
  unified: string
  baseRef?: string
}

/** A command an agent ran or proposes. argv-form — never a shell string. */
export interface CommandPart {
  kind: 'command'
  cwd: string
  argv: string[]
  exitCode?: number // present when reporting a finished run
  proposed?: boolean // true = "I want to run this"
}

/** Human sign-off request — the Assisted approval chip. */
export interface ApprovalRequestPart {
  kind: 'approval-request'
  summary: string
  action:
    | { type: 'run-command'; command: CommandPart }
    | { type: 'dispatch-task'; taskId: TaskId; to: AgentId }
  /** Correlates the eventual allow/deny back to this request. */
  requestId: string
}

export interface Artifact {
  /** ULID/GUID, unique within the task. */
  id: string
  producedBy: AgentId
  ts: string
  /** Human-readable one-liner ("retry logic + 3 tests"). */
  label: string
  files: { path: string; mtimeMs: number }[]
  commits: { sha: string; branch: string; message: string }[]
}

/** Reserved coordinator identity (Main). */
export const MORZ_AGENT_ID: AgentId = 'morz'
