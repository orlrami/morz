/*
 * Morz shared IPC + event contract (0.0.1).
 * THE coordination point for parallel work — every module codes against this.
 * Owner: Agent 1 (Backend). Others import types + channel names; do not redefine.
 *
 * Transport: hot PTY data flows renderer↔PTY-host over a MessagePort (see
 * PTY_PORT_CHANNEL). Everything else is request/response over ipcRenderer.invoke
 * or push events over ipcRenderer.on, exposed on window.morz.* by the preload.
 */

/* ── PTY ─────────────────────────────────────────────────────── */
export interface TerminalSpawnOpts {
  paneId: string
  shell?: string // 'pwsh' | 'cmd' | 'wsl' | absolute path; default = user's shell
  cwd?: string
  cols: number
  rows: number
  env?: Record<string, string>
}
export interface PtyDataMsg { paneId: string; data: string }
export interface PtyExitMsg { paneId: string; exitCode: number; signal?: number }
export interface PtyTuiMsg { paneId: string; tui: boolean }
export type PtyRendererMsg =
  | ({ type: 'data' } & PtyDataMsg)
  | ({ type: 'exit' } & PtyExitMsg)
  | ({ type: 'tui' } & PtyTuiMsg)
/**
 * Every message that travels over the PTY MessagePort (renderer↔PTY-host).
 * Flow control: host pauses a PTY when unacked bytes to the renderer exceed a
 * high watermark; renderer sends `ack` after xterm has consumed ~5k chars.
 */
export type PtyPortMsg =
  | ({ type: 'write' } & PtyDataMsg) // renderer→host: keystrokes
  | { type: 'ack'; paneId: string; bytes: number } // renderer→host: flow-control ack
  | { type: 'attach'; paneId: string } // renderer→host: replay scrollback after window reopen
  | PtyRendererMsg
/** (legacy) MessagePort channel — kept for compatibility; PTY data now relays through main. */
export const PTY_PORT_CHANNEL = 'morz:pty-port'
export const PtyApi = {
  spawn: 'pty:spawn', // (TerminalSpawnOpts) => Promise<{ok:boolean}>
  write: 'pty:write', // ({paneId, data}) renderer→main→host keystrokes
  ack: 'pty:ack', // ({paneId, bytes}) flow-control ack
  attach: 'pty:attach', // ({paneId}) replay scrollback after reopen
  resize: 'pty:resize', // ({paneId, cols, rows})
  kill: 'pty:kill', // ({paneId})
  list: 'pty:list', // () => Promise<string[]> live paneIds (for reattach)
  data: 'pty:data' // push main→renderer: data | exit | TUI state (tagged)
} as const

/* ── Session (Slice 2) ───────────────────────────────────────── */
export interface SessionSnapshot {
  layout: unknown // dockview serialized layout (opaque here)
  panes: { paneId: string; cwd: string; shell: string; scrollback: string }[]
}
export const SessionApi = {
  save: 'session:save', // (SessionSnapshot)
  load: 'session:load' // () => Promise<SessionSnapshot | null>
} as const

/* ── FileService (Slice 3) — owner: Agent 3 ──────────────────── */
export type Eol = 'lf' | 'crlf'
export interface FileReadResult { content: string; mtimeMs: number; eol: Eol; binary: boolean }
export type FileSaveResult = { ok: true; mtimeMs: number } | { ok: false; conflict: true; mtimeMs: number }
export interface FileChangedMsg { path: string; kind: 'changed' | 'deleted'; mtimeMs: number }
export const FileApi = {
  read: 'file:read', // (path) => Promise<FileReadResult>
  save: 'file:save', // ({path, content, expectedMtimeMs}) => Promise<FileSaveResult>
  watch: 'file:watch', // (path)
  unwatch: 'file:unwatch', // (path)
  changed: 'file:changed' // push event → FileChangedMsg
} as const

/* ── GitService (Slice 4) — owner: Agent 4 ───────────────────── */
export interface GitFile { path: string; index: string; worktree: string } // porcelain=v2 XY
export interface GitStatus {
  cwd: string
  branch: string | null
  ahead: number
  behind: number
  files: GitFile[]
}
export const GitApi = {
  status: 'git:status', // (cwd) => Promise<GitStatus>
  watch: 'git:watch', // (cwd)
  changed: 'git:changed' // push event → GitStatus
} as const

/* ── Claude adapter (Slice 5) — owner: Agent 4 ───────────────── */
export interface ClaudeStartOpts { agentId: string; cwd: string; resume?: string }
/** Raw Claude stream-json NDJSON event (system/init | stream_event | assistant | user | result | control_request | api_retry). */
export type ClaudeEvent = { type: string; [k: string]: unknown }
export interface ClaudePermissionReq { agentId: string; requestId: string; tool: string; input: unknown }
export interface ClaudePermissionResp { requestId: string; behavior: 'allow' | 'deny' }
export const ClaudeApi = {
  start: 'claude:start', // (ClaudeStartOpts) => Promise<{agentId:string}>
  send: 'claude:send', // ({agentId, text})
  interrupt: 'claude:interrupt', // ({agentId})
  event: 'claude:event', // push → {agentId, event: ClaudeEvent}
  permission: 'claude:permission', // push → ClaudePermissionReq ; renderer replies via permissionRespond
  permissionRespond: 'claude:permission-respond' // (ClaudePermissionResp)
} as const

/* ── FsService (explorer) — owner: Agent 4 ───────────────────── */
export interface FsEntry { name: string; kind: 'dir' | 'file'; path: string }
export const FsApi = {
  list: 'fs:list' // (dir) => Promise<FsEntry[]> — shallow listing, scoped (no '..'), node_modules/.git hidden
} as const

/* ── Editor handoff (Slice 3) ────────────────────────────────── */
export const EditorApi = {
  detectEditors: 'editor:detect', // () => Promise<('vscode'|'cursor')[]>
  openExternal: 'editor:open-external' // ({editor, path, line, col})
} as const

/* ── Renderer-only event bus (mitt) — owner: Agent 2 (app-events.ts) ──
 * 'open-file': { path: string; line?: number; col?: number }  // Terminal link / reviewer → IDE pane
 * 'focus-pane': { paneId: string }
 */
export type OpenFileEvent = { path: string; line?: number; col?: number }

/* window.morz shape published by the preload (owner: Agent 1). */
export interface MorzApi {
  pty: {
    spawn(o: TerminalSpawnOpts): Promise<{ ok: boolean }>
    write(paneId: string, data: string): void
    ack(paneId: string, bytes: number): void
    attach(paneId: string): void
    resize(paneId: string, cols: number, rows: number): void
    kill(paneId: string): void
    list(): Promise<string[]>
    /** PTY output/exit/TUI state pushed from main. Returns an unsubscribe fn. */
    onData(cb: (msg: PtyRendererMsg) => void): () => void
  }
  session: { save(s: SessionSnapshot): void; load(): Promise<SessionSnapshot | null> }
  file: {
    read(path: string): Promise<FileReadResult>
    save(path: string, content: string, expectedMtimeMs: number): Promise<FileSaveResult>
    watch(path: string): void
    unwatch(path: string): void
    onChanged(cb: (m: FileChangedMsg) => void): void
  }
  git: { status(cwd: string): Promise<GitStatus>; watch(cwd: string): void; onChanged(cb: (s: GitStatus) => void): void }
  fs: { list(dir: string): Promise<FsEntry[]> }
  claude: {
    start(o: ClaudeStartOpts): Promise<{ agentId: string }>
    send(agentId: string, text: string): void
    interrupt(agentId: string): void
    onEvent(cb: (m: { agentId: string; event: ClaudeEvent }) => void): void
    onPermission(cb: (r: ClaudePermissionReq) => void): void
    respondPermission(r: ClaudePermissionResp): void
  }
  editor: { detect(): Promise<('vscode' | 'cursor')[]>; openExternal(editor: string, path: string, line?: number, col?: number): void }
}

/* ── Bus v0 (0.0.2) — w4/bus — owner: Agent 1 ────────────────── */
// Task board + mailbox IPC. Payload shapes come from the FROZEN protocol
// (src/shared/bus.ts mirrors docs/protocol.md) — imported, never redefined.
import type { AgentId, Message, Part, Task, TaskId, TaskState } from './bus'

export interface BusCreateTaskInput {
  title: string
  createdBy: AgentId
  dependsOn?: TaskId[]
}
/** Artifact minus what Main stamps (id, producedBy, ts). */
export interface BusArtifactInput {
  label: string
  files?: { path: string; mtimeMs: number }[]
  commits?: { sha: string; branch: string; message: string }[]
}
/** Message minus what Main stamps (id, from, ts) — `from` is NEVER accepted from the sender. */
export interface BusSendInput {
  to: AgentId
  taskId: TaskId | null
  parts: Part[]
}
export interface BusTaskFilter {
  state?: TaskState
  assignee?: AgentId
}
export const BusApi = {
  listTasks: 'bus:list-tasks', // (BusTaskFilter?) => Promise<Task[]>
  createTask: 'bus:create-task', // (BusCreateTaskInput) => Promise<Task>  (state 'proposed')
  acceptTask: 'bus:accept-task', // (taskId) => Promise<Task>  proposed→accepted
  withdrawTask: 'bus:withdraw-task', // (taskId) => Promise<Task>  proposed→done (rejected)
  claimTask: 'bus:claim-task', // ({taskId, agentId, leaseMs?}) => Promise<Task|null>  CAS: null = lost race / deps unmet
  completeTask: 'bus:complete-task', // ({taskId, agentId, artifact}) => Promise<Task>  working→done
  blockTask: 'bus:block-task', // ({taskId, agentId, reason}) => Promise<Task>  working→blocked
  resumeTask: 'bus:resume-task', // ({taskId, agentId, leaseMs?}) => Promise<Task>  blocked→working
  send: 'bus:send', // (BusSendInput) => Promise<Message>  mailbox delivery; Main stamps from+ts
  tasksChanged: 'bus:tasks-changed' // push → Task[]  (full board, on every board write)
} as const

export interface MorzBusApi {
  listTasks(filter?: BusTaskFilter): Promise<Task[]>
  createTask(input: BusCreateTaskInput): Promise<Task>
  acceptTask(taskId: TaskId): Promise<Task>
  withdrawTask(taskId: TaskId): Promise<Task>
  claimTask(taskId: TaskId, agentId: AgentId, leaseMs?: number): Promise<Task | null>
  completeTask(taskId: TaskId, agentId: AgentId, artifact: BusArtifactInput): Promise<Task>
  blockTask(taskId: TaskId, agentId: AgentId, reason: string): Promise<Task>
  resumeTask(taskId: TaskId, agentId: AgentId, leaseMs?: number): Promise<Task>
  send(input: BusSendInput): Promise<Message>
  /** Full board pushed on every write. Returns an unsubscribe fn. */
  onTasksChanged(cb: (tasks: Task[]) => void): () => void
}
// declaration-merged into MorzApi above; optional because the preload attaches
// it in its own w4/bus block after the base api literal is built. ONE
// window.morz.bus = the board API (here) + the blackboard/chip UI API
// (shared/bus-ipc.ts) — integration unified them.
export interface MorzApi {
  bus?: MorzBusApi & import('./bus-ipc').MorzBusApi
}

// w4/workshop
export type CatalogKind = 'skill' | 'mcp' | 'plugin' | 'model'
export type CatalogCategory = 'recommended' | 'skills' | 'mcp' | 'plugins' | 'models'
export type CatalogTargetCli = 'claude' | 'codex' | 'agy' | 'opencode'

export interface CatalogInstallSpec {
  name: string
  command?: string
  args: string[]
  env: Record<string, string>
  url?: string
  transport?: 'stdio' | 'sse' | 'streamable-http'
  headers?: Record<string, string>
}

export interface CatalogItem {
  id: string
  kind: CatalogKind
  name: string
  description: string
  source: string
  sourceUrl: string | null
  stars: number | null
  official: boolean
  recommended: boolean
  installSpec: CatalogInstallSpec | null
  benchmarkScore?: number | null
  benchmarkLabel?: string | null
  contextLength?: number | null
  updatedAt: string
}

export interface CatalogQuery {
  category?: CatalogCategory
  search?: string
  limit?: number
}

export interface CatalogSnapshot {
  items: CatalogItem[]
  lastSyncAt: number | null
  offline: boolean
  syncing: boolean
  error: string | null
}

export const CatalogApi = {
  query: 'catalog:query',
  refresh: 'catalog:refresh',
  updated: 'catalog:updated'
} as const

export interface MorzApi {
  /** Optional for mixed-wave builds; the production preload always publishes it. */
  catalog?: {
    query(query?: CatalogQuery): Promise<CatalogSnapshot>
    refresh(query?: CatalogQuery): Promise<CatalogSnapshot>
    onUpdated?(callback: () => void): () => void
  }
}

// w4/config
export type ConfigWriterTarget = 'claude' | 'codex' | 'opencode'
export interface ConfigWriterInstallSpec {
  name: string
  command: string
  args: string[]
  env: Record<string, string>
}
export interface ConfigWriterDetectedConfig {
  target: ConfigWriterTarget
  path: string
}
export interface ConfigWriterProposal {
  proposalId: string
  hash: string
  target: ConfigWriterTarget
  path: string
  unifiedDiff: string
}
export interface ConfigWriterApplyResult {
  target: ConfigWriterTarget
  path: string
  backupPath: string
}
export const ConfigWriterApi = {
  detect: 'config-writer:detect',
  propose: 'config-writer:propose',
  apply: 'config-writer:apply'
} as const
export interface ConfigWriterApiShape {
  detect(): Promise<ConfigWriterDetectedConfig[]>
  propose(spec: ConfigWriterInstallSpec, targets: ConfigWriterTarget[]): Promise<ConfigWriterProposal[]>
  apply(proposalId: string): Promise<ConfigWriterApplyResult>
}
export interface MorzApi {
  configWriter?: ConfigWriterApiShape
}

// w4/obsidian
export const ObsidianApi = {
  status: 'obsidian:status',
  connect: 'obsidian:connect',
  readNote: 'obsidian:read-note',
  searchNotes: 'obsidian:search-notes',
  prepareAdr: 'obsidian:prepare-adr',
  writeAdr: 'obsidian:write-adr'
} as const

export type ObsidianConnectionState = 'not-connected' | 'connected' | 'offline'
export interface ObsidianStatus {
  state: ObsidianConnectionState
  baseUrl?: string
  error?: string
}
export interface ObsidianMadrBody {
  status: string
  context: string
  decision: string
  consequences: string
}
export interface ObsidianSearchResult {
  filename: string
  [key: string]: unknown
}
export interface ObsidianBridge {
  status(): Promise<ObsidianStatus>
  connect(baseUrl: string, apiKey: string): Promise<ObsidianStatus>
  readNote(path: string): Promise<string>
  searchNotes(query: string): Promise<ObsidianSearchResult[]>
  prepareAdr(folder: string, title: string, body: ObsidianMadrBody): Promise<{ preview: string; draftId: string }>
  writeAdr(draftId: string): Promise<{ path: string }>
}
// w4/organizer
export interface OrganizerViolation {
  rule: string
  path: string
  detail: string
  cite: string
}
export type OrganizerInverseOperation =
  | { kind: 'move'; from: string; to: string }
  | { kind: 'delete'; to: string }
export type OrganizerOperation =
  | { kind: 'move'; from: string; to: string; inverse: OrganizerInverseOperation }
  | { kind: 'create'; to: string; content: string; inverse: OrganizerInverseOperation }
export interface OrganizerPlan {
  version: 1
  root: string
  baseCommit: string | null
  operations: OrganizerOperation[]
  beforeTree: string[]
  afterTree: string[]
  planHash: string
}
export interface OrganizerExplanation { rule: string; explanation: string; cite: string }
export interface OrganizerApplyResult {
  runTag: string
  branch: string
  commit: string
  worktreePath: string
  journalPath: string
  diff: string
}
export const OrganizerApi = {
  audit: 'organizer:audit',
  propose: 'organizer:propose',
  explain: 'organizer:explain',
  apply: 'organizer:apply'
} as const
export interface OrganizerApi {
  audit(root: string): Promise<OrganizerViolation[]>
  propose(root: string): Promise<OrganizerPlan>
  explain(ruleId: string): Promise<OrganizerExplanation>
  apply(root: string, planHash: string): Promise<OrganizerApplyResult>
}
export interface MorzApi { organizer: OrganizerApi }

// w5/adapters — APPEND-ONLY block, owner: Agent 4 (wave 5).
// Normalized cross-CLI agent event stream. Every AgentAdapter (claude/codex/agy,
// src/main/adapters/) maps its native output onto this union; the dispatcher
// and future lane UIs consume ONLY these shapes. Raw CLI events keep flowing on
// the existing ClaudeApi.event channel — this union is additive, not a rename.
export type AdapterCli = 'claude' | 'codex' | 'agy'
export type AdapterEvent =
  | { type: 'init'; cli: AdapterCli; sessionId: string | null; model: string | null }
  | { type: 'delta'; text: string } // streamed output chunk (raw PTY text for agy)
  | { type: 'message'; role: 'assistant' | 'system'; text: string } // complete message
  | { type: 'tool'; name: string; detail?: unknown }
  | { type: 'result'; inputTokens?: number; outputTokens?: number; costUsd?: number } // turn done
  | { type: 'error'; message: string }
  | { type: 'exit'; code: number | null }
// w5/planner
import type { PlannedAgent, SpawnPlan } from './spawn-plan'

export type PlanApprovalState = 'DRAFT' | 'PROPOSED' | 'APPROVED'

export interface StoredSpawnPlan {
  plan: SpawnPlan
  state: PlanApprovalState
}

export type PlanAmendmentAction =
  | { kind: 'add'; agent: PlannedAgent }
  | { kind: 'replace'; replaceAgentId: string; agent: PlannedAgent }

export interface PlanAmendment {
  version: '1.0'
  id: string
  planId: string
  action: PlanAmendmentAction
  createdAt: string
  amendmentHash: string
}

export interface StoredPlanAmendment {
  amendment: PlanAmendment
  state: 'PROPOSED' | 'APPROVED'
}

export const PlannerApi = {
  plan: 'planner:plan',
  update: 'planner:update',
  approveAndRun: 'planner:approve-and-run',
  discard: 'planner:discard',
  listOpen: 'planner:list-open',
  requestAmendment: 'planner:request-amendment',
  approveAmendment: 'planner:approve-amendment',
  discardAmendment: 'planner:discard-amendment'
} as const

export interface PlannerBridge {
  plan(goal: string, spaceRoot: string): Promise<StoredSpawnPlan>
  update(plan: SpawnPlan, expectedHash: string): Promise<StoredSpawnPlan>
  approveAndRun(
    planHash: string
  ): Promise<{ record: StoredSpawnPlan; runId: string }>
  discard(planHash: string): Promise<void>
  listOpen(): Promise<{ plans: StoredSpawnPlan[]; amendments: StoredPlanAmendment[] }>
  requestAmendment(planId: string, request: string): Promise<StoredPlanAmendment>
  approveAmendment(amendmentHash: string): Promise<StoredPlanAmendment>
  discardAmendment(amendmentHash: string): Promise<void>
}
