/*
 * Morz shared IPC + event contract (0.0.1).
 * THE coordination point for parallel work â€” every module codes against this.
 * Owner: Agent 1 (Backend). Others import types + channel names; do not redefine.
 *
 * Transport: hot PTY data flows rendererâ†”PTY-host over a MessagePort (see
 * PTY_PORT_CHANNEL). Everything else is request/response over ipcRenderer.invoke
 * or push events over ipcRenderer.on, exposed on window.morz.* by the preload.
 */

/* â”€â”€ PTY â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */
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
 * Every message that travels over the PTY MessagePort (rendererâ†”PTY-host).
 * Flow control: host pauses a PTY when unacked bytes to the renderer exceed a
 * high watermark; renderer sends `ack` after xterm has consumed ~5k chars.
 */
export type PtyPortMsg =
  | ({ type: 'write' } & PtyDataMsg) // rendererâ†’host: keystrokes
  | { type: 'ack'; paneId: string; bytes: number } // rendererâ†’host: flow-control ack
  | { type: 'attach'; paneId: string } // rendererâ†’host: replay scrollback after window reopen
  | PtyRendererMsg
/** (legacy) MessagePort channel â€” kept for compatibility; PTY data now relays through main. */
export const PTY_PORT_CHANNEL = 'morz:pty-port'
export const PtyApi = {
  spawn: 'pty:spawn', // (TerminalSpawnOpts) => Promise<{ok:boolean}>
  write: 'pty:write', // ({paneId, data}) rendererâ†’mainâ†’host keystrokes
  ack: 'pty:ack', // ({paneId, bytes}) flow-control ack
  attach: 'pty:attach', // ({paneId}) replay scrollback after reopen
  resize: 'pty:resize', // ({paneId, cols, rows})
  kill: 'pty:kill', // ({paneId})
  list: 'pty:list', // () => Promise<string[]> live paneIds (for reattach)
  data: 'pty:data' // push mainâ†’renderer: data | exit | TUI state (tagged)
} as const

/* â”€â”€ Session (Slice 2) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */
export interface SessionSnapshot {
  layout: unknown // dockview serialized layout (opaque here)
  panes: { paneId: string; cwd: string; shell: string; scrollback: string }[]
}
export const SessionApi = {
  save: 'session:save', // (SessionSnapshot)
  load: 'session:load' // () => Promise<SessionSnapshot | null>
} as const

/* â”€â”€ FileService (Slice 3) â€” owner: Agent 3 â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */
export type Eol = 'lf' | 'crlf'
export interface FileReadResult { content: string; mtimeMs: number; eol: Eol; binary: boolean }
export type FileSaveResult = { ok: true; mtimeMs: number } | { ok: false; conflict: true; mtimeMs: number }
export interface FileChangedMsg { path: string; kind: 'changed' | 'deleted'; mtimeMs: number }
export const FileApi = {
  read: 'file:read', // (path) => Promise<FileReadResult>
  save: 'file:save', // ({path, content, expectedMtimeMs}) => Promise<FileSaveResult>
  watch: 'file:watch', // (path)
  unwatch: 'file:unwatch', // (path)
  changed: 'file:changed' // push event â†’ FileChangedMsg
} as const

/* â”€â”€ GitService (Slice 4) â€” owner: Agent 4 â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */
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
  changed: 'git:changed' // push event â†’ GitStatus
} as const

/* â”€â”€ Claude adapter (Slice 5) â€” owner: Agent 4 â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */
export interface ClaudeStartOpts { agentId: string; cwd: string; resume?: string }
/** Raw Claude stream-json NDJSON event (system/init | stream_event | assistant | user | result | control_request | api_retry). */
export type ClaudeEvent = { type: string; [k: string]: unknown }
export interface ClaudePermissionReq { agentId: string; requestId: string; tool: string; input: unknown }
export interface ClaudePermissionResp { requestId: string; behavior: 'allow' | 'deny' }
export const ClaudeApi = {
  start: 'claude:start', // (ClaudeStartOpts) => Promise<{agentId:string}>
  send: 'claude:send', // ({agentId, text})
  interrupt: 'claude:interrupt', // ({agentId})
  event: 'claude:event', // push â†’ {agentId, event: ClaudeEvent}
  permission: 'claude:permission', // push â†’ ClaudePermissionReq ; renderer replies via permissionRespond
  permissionRespond: 'claude:permission-respond' // (ClaudePermissionResp)
} as const

/* â”€â”€ FsService (explorer) â€” owner: Agent 4 â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */
export interface FsEntry { name: string; kind: 'dir' | 'file'; path: string }
export const FsApi = {
  list: 'fs:list' // (dir) => Promise<FsEntry[]> â€” shallow listing, scoped (no '..'), node_modules/.git hidden
} as const

/* â”€â”€ Editor handoff (Slice 3) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */
export const EditorApi = {
  detectEditors: 'editor:detect', // () => Promise<('vscode'|'cursor')[]>
  openExternal: 'editor:open-external' // ({editor, path, line, col})
} as const

/* â”€â”€ Renderer-only event bus (mitt) â€” owner: Agent 2 (app-events.ts) â”€â”€
 * 'open-file': { path: string; line?: number; col?: number }  // Terminal link / reviewer â†’ IDE pane
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

/* â”€â”€ Bus v0 (0.0.2) â€” w4/bus â€” owner: Agent 1 â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */
// Task board + mailbox IPC. Payload shapes come from the FROZEN protocol
// (src/shared/bus.ts mirrors docs/protocol.md) â€” imported, never redefined.
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
/** Message minus what Main stamps (id, from, ts) â€” `from` is NEVER accepted from the sender. */
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
  acceptTask: 'bus:accept-task', // (taskId) => Promise<Task>  proposedâ†’accepted
  withdrawTask: 'bus:withdraw-task', // (taskId) => Promise<Task>  proposedâ†’done (rejected)
  claimTask: 'bus:claim-task', // ({taskId, agentId, leaseMs?}) => Promise<Task|null>  CAS: null = lost race / deps unmet
  completeTask: 'bus:complete-task', // ({taskId, agentId, artifact}) => Promise<Task>  workingâ†’done
  blockTask: 'bus:block-task', // ({taskId, agentId, reason}) => Promise<Task>  workingâ†’blocked
  resumeTask: 'bus:resume-task', // ({taskId, agentId, leaseMs?}) => Promise<Task>  blockedâ†’working
  send: 'bus:send', // (BusSendInput) => Promise<Message>  mailbox delivery; Main stamps from+ts
  tasksChanged: 'bus:tasks-changed' // push â†’ Task[]  (full board, on every board write)
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
// (shared/bus-ipc.ts) â€” integration unified them.
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

export type CatalogSourceState = 'ok' | 'offline' | 'rate-limited' | 'needs-key' | 'error'

export interface CatalogSourceStatus {
  source: 'mcp-registry' | 'openrouter-models' | 'openrouter-benchmarks' | 'github'
  status: CatalogSourceState
  lastError: string | null
  nextRetry: number | null
  lastSyncAt: number | null
}

export interface CatalogSnapshot {
  items: CatalogItem[]
  lastSyncAt: number | null
  offline: boolean
  syncing: boolean
  error: string | null
  sources: CatalogSourceStatus[]
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
  /** Persistent in-app notice log (wave 6). */
  notify?: import('./notify').MorzNotifyApi
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

// w5/adapters â€” APPEND-ONLY block, owner: Agent 4 (wave 5).
// Normalized cross-CLI agent event stream. Every AgentAdapter (claude/codex/agy,
// src/main/adapters/) maps its native output onto this union; the dispatcher
// and future lane UIs consume ONLY these shapes. Raw CLI events keep flowing on
// the existing ClaudeApi.event channel â€” this union is additive, not a rename.
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
// w5/dispatch â€” approved SpawnPlan â†’ real running team (visible panes)
// SpawnPlan already imported by the w5/planner block above.
import type { RunState, RunStatus } from './spawn-plan'
export interface RunSummary {
  runId: string
  runTag: string
  goal: string
  state: RunState
  createdAt: string
}
export const RunApi = {
  approvePlan: 'run:approve-plan', // (SpawnPlan) => Promise<{planHash}>  Main stamps + stores the hash
  dispatch: 'run:dispatch', // (SpawnPlan) => Promise<{runId}>  re-hash + verify vs stored approved plan
  list: 'run:list', // () => Promise<RunSummary[]>
  status: 'run:status', // (runId) => Promise<RunStatus | null>
  stop: 'run:stop', // (runId) => Promise<RunStatus>  global Stop â€” kills every agent's process tree
  cleanup: 'run:cleanup', // (runId) => Promise<RunStatus>  removes run-tagged worktrees + branches
  changed: 'run:changed' // push â†’ RunStatus on every run/agent state change
} as const
export interface MorzRunApi {
  approvePlan(plan: SpawnPlan): Promise<{ planHash: string }>
  dispatch(plan: SpawnPlan): Promise<{ runId: string }>
  listRuns(): Promise<RunSummary[]>
  runStatus(runId: string): Promise<RunStatus | null>
  stopRun(runId: string): Promise<RunStatus>
  cleanup(runId: string): Promise<RunStatus>
  /** Run/agent state pushes. Returns an unsubscribe fn. */
  onRunChanged(cb: (status: RunStatus) => void): () => void
}
export interface MorzApi {
  run?: MorzRunApi
}
// w5/reviewer
export type ReviewAuthor = 'claude' | 'codex'
export type ReviewSeverity = 'critical' | 'high' | 'medium' | 'low' | 'info'

export interface ReviewFinding {
  severity: ReviewSeverity
  file: string
  line: number
  title: string
  evidence: string
  suggestedFix?: string
}

export interface ReviewRunInput {
  cwd: string
  baseRef: string
  headRef: string
  author: ReviewAuthor
}

export interface ReviewRunResult extends ReviewRunInput {
  id: string
  reviewer: ReviewAuthor
  sameModelReview: boolean
  findings: ReviewFinding[]
  createdAt: string
}

export const ReviewApi = {
  run: 'review:run',
  changed: 'review:changed'
} as const

export interface ReviewerBridge {
  run(input: ReviewRunInput): Promise<ReviewRunResult>
  onChanged(callback: (result: ReviewRunResult) => void): () => void
}
// w5/dag
export interface DodCheck {
  /** argv form: executable first, followed by arguments; never a shell string. */
  command: string[]
  cwd: string
}
export interface BusCreateTaskInput {
  dod?: DodCheck[]
}
export const DodApi = {
  completeVerified: 'bus:complete-verified'
} as const
export interface MorzBusApi {
  completeVerified?(taskId: TaskId, agentId: AgentId, artifact: BusArtifactInput): Promise<Task>
}
// w5/commit
export interface CommitLogEntry {
  sha: string
  shortSha: string
  author: string
  date: string
  subject: string
}
export interface CommitFileDiff {
  path: string
  staged: string
  unstaged: string
}
export const CommitApi = {
  fileDiff: 'commit:file-diff',
  stageFile: 'commit:stage-file',
  unstageFile: 'commit:unstage-file',
  stageHunk: 'commit:stage-hunk',
  discardFile: 'commit:discard-file',
  stagedDiff: 'commit:staged-diff',
  commit: 'commit:create',
  log: 'commit:log',
  suggestMessage: 'commit:suggest-message'
} as const
export interface CommitBridge {
  fileDiff(root: string, path: string): Promise<CommitFileDiff>
  stageFile(root: string, path: string): Promise<void>
  unstageFile(root: string, path: string): Promise<void>
  stageHunk(root: string, patch: string): Promise<void>
  discardFile(root: string, path: string, confirmed: boolean): Promise<void>
  stagedDiff(root: string): Promise<string>
  commit(root: string, message: string): Promise<{ sha: string }>
  log(root: string): Promise<CommitLogEntry[]>
  suggestMessage(root: string): Promise<string>
}
// w5/cost
export type CostCapKind = 'usd' | 'tokens'
export interface CostCaps {
  maxUsd: number | null
  maxTokens: number | null
}
export interface CostUsageSample {
  usd?: number | null
  tokens?: number | null
  /** Dispatcher samples are deltas; adapter samples report running totals. */
  mode?: 'delta' | 'total'
  source?: string
  /** Optional replay key; duplicate samples with the same key are ignored. */
  sampleId?: string
}
export interface CostUsageTotals {
  usd: number | null
  tokens: number | null
}
export interface CostBreach {
  runId: string
  kind: CostCapKind
  value: number
  cap: number
}
export interface CostRunMeter {
  runId: string
  usage: CostUsageTotals
  caps: CostCaps
  breach: CostBreach | null
}
export interface CostSnapshot {
  session: CostUsageTotals
  activeRun: CostRunMeter | null
}
export interface CostTestTrackInput {
  runId: string
  agentId: string
  usage: CostUsageSample
  caps?: CostCaps
}
export const CostApi = {
  snapshot: 'cost:snapshot',
  updated: 'cost:updated',
  breach: 'cost-breach',
  resume: 'cost:resume',
  stop: 'cost:stop',
  trackAdapter: 'cost:track-adapter',
  testTrack: 'cost:test-track'
} as const
export interface CostBridge {
  snapshot(): Promise<CostSnapshot>
  resume(runId: string): Promise<CostSnapshot>
  stop(runId: string): Promise<CostSnapshot>
  onUpdated(callback: (snapshot: CostSnapshot) => void): () => void
  onBreach(callback: (breach: CostBreach) => void): () => void
  /** Dev-only; absent unless MORZ_E2E=1 in both preload and Main. */
  testTrack?(input: CostTestTrackInput): Promise<void>
}

// w6/assistant â€” APPEND-ONLY: bring-your-own assistant proposal source
export type AssistantProviderKind = 'hosted' | 'local'
export interface AssistantProvider {
  id: string
  name: string
  kind: AssistantProviderKind
  description: string
}
export type AssistantConnectionState = 'disconnected' | 'connecting' | 'connected' | 'error'
export interface AssistantConnectionStatus {
  state: AssistantConnectionState
  providerId: string | null
  detail?: string
}
export const AssistantApi = {
  listProviders: 'assistant:list-providers',
  status: 'assistant:status',
  setEnabled: 'assistant:set-enabled',
  connect: 'assistant:connect',
  disconnect: 'assistant:disconnect',
  propose: 'assistant:propose'
} as const
export interface AssistantBridge {
  listProviders(): Promise<AssistantProvider[]>
  status(): Promise<AssistantConnectionStatus>
  setEnabled(enabled: boolean): Promise<AssistantConnectionStatus>
  connect(providerId: string): Promise<AssistantConnectionStatus>
  disconnect(): Promise<AssistantConnectionStatus>
  propose(goal: string, spaceRoot: string): Promise<StoredSpawnPlan>
}
// w6/pulse â€” append-only Daily Pulse contract.
export type PulseMode = 'manual' | 'assisted' | 'orchestrated'
export type PulseTrigger = 'scheduled' | 'manual'

export interface PulseSettingsSnapshot {
  enabled: boolean
  time: string
  nextFire: number | null
  mode: PulseMode
  spaceRoot: string
}

export interface PulseBrief {
  id: string
  createdAt: number
  spaceRoot: string
  markdown: string
  trigger: PulseTrigger
}

export interface PulseSnapshot {
  settings: PulseSettingsSnapshot
  briefs: PulseBrief[]
  pendingNotices: import('./notify').NotifyItem[]
  running: boolean
}

export interface PulseConfigureInput {
  enabled: boolean
  time: string
  mode: PulseMode
  spaceRoot: string
}

export interface PulseRunInput {
  mode: PulseMode
  spaceRoot: string
}

export interface PulseReadyEvent {
  brief: PulseBrief
  notice: import('./notify').NotifyItem
}

export const PulseApi = {
  snapshot: 'pulse:snapshot',
  configure: 'pulse:configure',
  runNow: 'pulse:run-now',
  ready: 'pulse:ready',
  notice: 'pulse:notice',
  ackNotice: 'pulse:ack-notice',
  open: 'pulse:open',
  testNextFire: 'pulse:test-next-fire'
} as const

export interface PulseBridge {
  snapshot(): Promise<PulseSnapshot>
  configure(input: PulseConfigureInput): Promise<PulseSnapshot>
  runNow(input: PulseRunInput): Promise<PulseBrief>
  onReady(callback: (event: PulseReadyEvent) => void): () => void
  onNotice(callback: (notice: import('./notify').NotifyItem) => void): () => void
  ackNotice(id: string): Promise<void>
  onOpen(callback: (brief: PulseBrief) => void): () => void
  /** Present only when MORZ_E2E=1. */
  testNextFire?(time: string, now: number): Promise<number>
}

// w8/routing â€” append-only routing, local-model, and settings contract.
export type RoutingTarget = 'agy' | 'codex' | 'claude' | 'local'

export interface RoutingRuleMatch {
  keywords: string[]
  regex: string[]
}

export interface RoutingRule {
  id: string
  label: string
  match: RoutingRuleMatch
  target: RoutingTarget
  reason: string
  enabled: boolean
}

export type LocalModelProvider = 'ollama' | 'lm-studio'

export interface LocalModelStatus {
  provider: LocalModelProvider
  baseUrl: string
  healthy: boolean
  models: string[]
  checkedAt: number
  detail?: string
}

export interface RouteOptions {
  spaceRoot?: string
  spacePrivate?: boolean
}

export interface RouteDecision {
  target: RoutingTarget
  reason: string
  rule: RoutingRule
  warning?: string
  localModel?: LocalModelStatus
  /** Environment for a Claude-Code-compatible local endpoint. Never applied globally. */
  claudeEnv?: Record<'ANTHROPIC_BASE_URL' | 'ANTHROPIC_MODEL', string>
}

export interface RoutingSnapshot {
  rules: RoutingRule[]
  localModels: LocalModelStatus[]
  spacePrivate: boolean
}

export const RoutingApi = {
  snapshot: 'routing:snapshot',
  saveRules: 'routing:save-rules',
  setSpacePrivate: 'routing:set-space-private',
  refreshLocalModels: 'routing:refresh-local-models',
  route: 'routing:route'
} as const

export interface RoutingBridge {
  snapshot(spaceRoot?: string): Promise<RoutingSnapshot>
  saveRules(rules: RoutingRule[]): Promise<RoutingRule[]>
  setSpacePrivate(spaceRoot: string, value: boolean): Promise<boolean>
  refreshLocalModels(): Promise<LocalModelStatus[]>
  route(taskText: string, options?: RouteOptions): Promise<RouteDecision>
}
// end w8/routing
// w8/voice â€” append-only local Whisper contract.
export interface VoiceSettingsSnapshot {
  configured: boolean
  enginePath: string | null
}

export const VoiceApi = {
  settings: 'voice:settings',
  chooseEngine: 'voice:choose-engine',
  clearEngine: 'voice:clear-engine',
  testTranscription: 'voice:test-transcription',
  transcribe: 'voice:transcribe'
} as const

export interface VoiceBridge {
  settings(): Promise<VoiceSettingsSnapshot>
  chooseEngine(): Promise<VoiceSettingsSnapshot>
  clearEngine(): Promise<VoiceSettingsSnapshot>
  testTranscription(): Promise<string | null>
  transcribe(audio: Uint8Array): Promise<string>
}

// w9/spaces â€” append-only native project-folder picker contract.
export const DialogApi = {
  pickFolder: 'dialog:pick-folder'
} as const

export interface DialogBridge {
  pickFolder(): Promise<string | null>
}
// end w9/spaces
// w9/browser â€” append-only embedded browser + CDP element-pick contract.
export interface BrowserRect {
  x: number
  y: number
  width: number
  height: number
}

export interface ElementContext {
  selector: string
  a11y: { role: string; name: string }
  curatedStyles: {
    color: string
    backgroundColor: string
    fontFamily: string
    fontSize: string
    fontWeight: string
    margin: string
    padding: string
    border: string
  }
  boundingRect: BrowserRect
  croppedScreenshotDataUrl: string
  /** Absolute path to the same crop in the OS temp directory. */
  screenshotPath: string
  sourceLoc?: string
  html: string
}

export interface BrowserState {
  url: string
  title: string
  canGoBack: boolean
  canGoForward: boolean
  loading: boolean
  picking: boolean
  error?: string
}

export type BrowserAgentKind = 'agy' | 'claude'

export const BrowserApi = {
  create: 'browser:create',
  destroy: 'browser:destroy',
  state: 'browser:state',
  navigate: 'browser:navigate',
  setBounds: 'browser:set-bounds',
  back: 'browser:back',
  forward: 'browser:forward',
  reload: 'browser:reload',
  setPickMode: 'browser:set-pick-mode',
  discoverLocalhost: 'browser:discover-localhost',
  liveAgents: 'browser:live-agents',
  copyText: 'browser:copy-text',
  stateChanged: 'browser:state-changed',
  picked: 'browser:picked',
  testPick: 'browser:e2e-pick'
} as const

export interface BrowserBridge {
  create(): Promise<BrowserState>
  destroy(): Promise<void>
  state(): Promise<BrowserState>
  navigate(url: string): Promise<BrowserState>
  setBounds(rect: BrowserRect): void
  back(): Promise<BrowserState>
  forward(): Promise<BrowserState>
  reload(): Promise<BrowserState>
  setPickMode(enabled: boolean): Promise<BrowserState>
  discoverLocalhost(): Promise<string[]>
  liveAgents(kind: BrowserAgentKind): Promise<string[]>
  copyText(text: string): Promise<void>
  onStateChanged(callback: (state: BrowserState) => void): () => void
  onPicked(callback: (context: ElementContext) => void): () => void
  /** Present only when MORZ_E2E=1. */
  testPick?(selector: string): Promise<ElementContext>
}
// end w9/browser
// w9/installer
export type UpdaterStatus =
  | 'disabled'
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'ready'
  | 'up-to-date'
  | 'error'

export interface UpdaterSnapshot {
  version: string
  channel: 'stable'
  enabled: boolean
  status: UpdaterStatus
  detail: string
  availableVersion?: string
  progress?: number
}

export const UpdaterApi = {
  status: 'updater:status',
  check: 'updater:check',
  changed: 'updater:changed'
} as const

export interface UpdaterBridge {
  status(): Promise<UpdaterSnapshot>
  check(): Promise<UpdaterSnapshot>
  onChanged(callback: (snapshot: UpdaterSnapshot) => void): () => void
}

// w11/commit-ai â€” append-only commit intelligence contract.
export interface CommitHistoryEntry extends CommitLogEntry {
  diff: string
}

export interface CommitFileHistory {
  path: string
  firstSeenCommit: string | null
  firstSeenDate: string | null
  firstSeenSubject: string | null
  branch: string | null
  commits: CommitLogEntry[]
}

export interface CommitBranchDiff {
  branch: string | null
  baseBranch: string | null
  diff: string
  commits: CommitLogEntry[]
}

export const CommitAiApi = {
  commitLog: 'commit:history-log',
  commitDiff: 'commit:history-diff',
  fileHistory: 'commit:file-history',
  branchDiffVsBase: 'commit:branch-diff-vs-base'
} as const

export interface CommitAiBridge {
  commitLog(root: string): Promise<CommitHistoryEntry[]>
  commitDiff(root: string, sha: string): Promise<string>
  fileHistory(root: string, path: string): Promise<CommitFileHistory>
  branchDiffVsBase(root: string): Promise<CommitBranchDiff>
}
// end w11/commit-ai
// w11/lanes-runs â€” APPEND-ONLY live PTY process-identity contract.
export interface PaneInfo {
  paneId: string
  shell: string
  argv: string[]
  /** Best-effort foreground process title; absent when the PTY backend cannot report it. */
  foreground?: string
}

export const PaneInfoApi = {
  list: 'pty:paneInfo'
} as const

export interface PaneInfoBridge {
  list(): Promise<PaneInfo[]>
}
// end w11/lanes-runs
// w11/sessions â€” append-only per-project work-session history contract.
export type SessionHistorySource = 'morz' | 'claude'

export interface SessionHistoryRecord {
  id: string
  spaceRoot: string
  startedAt: string
  endedAt: string | null
  title: string
  agentsUsed: string[]
  summary?: string
  source: SessionHistorySource
}

export interface SessionHistoryStartInput {
  spaceRoot: string
  title?: string
  agentsUsed?: string[]
  summary?: string
}

export const SessionHistoryApi = {
  start: 'sessions:start',
  end: 'sessions:end',
  list: 'sessions:list',
  current: 'sessions:current'
} as const

export interface SessionHistoryBridge {
  start(input: SessionHistoryStartInput): Promise<SessionHistoryRecord>
  end(sessionId?: string): Promise<SessionHistoryRecord | null>
  list(spaceRoot: string): Promise<SessionHistoryRecord[]>
  current(spaceRoot: string): Promise<SessionHistoryRecord | null>
}
// end w11/sessions
// w12/sessions-resume â€” append-only model, pin, and native resume contract.
export interface SessionHistoryRecord {
  /** CLI-reported model when the native transcript exposes one. */
  model?: string
  /** CLI-reported agent identity when the native transcript exposes one. */
  agent?: string
  pinned: boolean
}

export interface SessionResumeInfo {
  cli: Extract<AdapterCli, 'claude' | 'codex'>
  sessionId: string
  cwd: string
}

export interface SessionLaneStartInput {
  id: string
  agentId: string
}

export interface SessionLaneStart extends SessionResumeInfo {
  agentId: string
}

export const SessionResumeApi = {
  pin: 'sessions:pin',
  resumeInfo: 'sessions:resume-info',
  startLane: 'sessions:resume-start-lane',
  testStarts: 'sessions:resume-test-starts'
} as const

export interface SessionResumeBridge {
  pin(id: string, pinned: boolean): Promise<void>
  resumeInfo(id: string): Promise<SessionResumeInfo | null>
  startLane(input: SessionLaneStartInput): Promise<{ agentId: string }>
}

export interface SessionResumeTestBridge {
  starts(): Promise<SessionLaneStart[]>
}
// end w12/sessions-resume

// w12/orch-engine â€” append-only planner engine selection contract.
// w15/planner-fast-default â€” 'fast' races Claude (Sonnet) against Codex
// (GPT-5.5); first valid plan wins. Default engine for new installs.
export type PlannerEngine = 'fast' | 'claude' | 'codex' | 'local'

/** Which Claude model the planner uses when the claude engine runs. */
export type PlannerClaudeModel = 'sonnet' | 'opus' | 'fable'

export const PlannerEngineApi = {
  get: 'planner-engine:get',
  set: 'planner-engine:set',
  getModel: 'planner-engine:get-model',
  setModel: 'planner-engine:set-model'
} as const

export interface PlannerEngineBridge {
  get(): Promise<PlannerEngine>
  set(engine: PlannerEngine): Promise<PlannerEngine>
  getModel(): Promise<PlannerClaudeModel>
  setModel(model: PlannerClaudeModel): Promise<PlannerClaudeModel>
}

export interface StoredSpawnPlan {
  notice?: string
}
// end w12/orch-engine

// w13/dispatch-visible â€” append-only dispatched-agent pane contract.
// A dispatched pane must be a REAL renderer pane before the CLI launch command
// is typed: without a mounted xterm session nobody sends flow-control acks, so
// the PTY pauses at the high watermark and the launch never executes. Main
// pushes `created` when the dispatcher spawns an agent pane; the renderer adds
// it to the layout, mounts the terminal, and acks with `attached` â€” only then
// does the dispatcher write the launch command.
export interface RunPaneCreated {
  paneId: string
  runId: string
  agentId: string
  cwd: string
  cli: AdapterCli
}
export const RunPaneApi = {
  created: 'run:pane-created', // push mainâ†’renderer: RunPaneCreated
  attached: 'run:pane-attached' // rendererâ†’main: (paneId) after xterm session attach
} as const
export interface RunPaneBridge {
  /** Dispatched-pane pushes. Returns an unsubscribe fn. */
  onPaneCreated(cb: (info: RunPaneCreated) => void): () => void
  notifyPaneAttached(paneId: string): void
}
// end w13/dispatch-visible
// w13/planner-schema â€” non-fatal schema repairs the planner applied to accept
// the plan (role truncation, branch slugify). Surface them; never hide them.
export interface StoredSpawnPlan {
  warnings?: string[]
}
// end w13/planner-schema
// w14/orch-scoped â€” APPEND-ONLY: the orchestrator is scoped per Space.
// Plans, blackboard tasks, and runs carry the space they were created in;
// list queries accept an optional spaceRoot filter (no arg = unfiltered,
// so every pre-w14 caller keeps its old behavior).
export interface RunSummary {
  spaceRoot: string
}
export interface BusCreateTaskInput {
  /** Space the task belongs to; tasks without one are visible in every space. */
  spaceRoot?: string
}
export interface BusTaskFilter {
  spaceRoot?: string
}
export interface PlannerBridge {
  listOpen(
    spaceRoot?: string
  ): Promise<{ plans: StoredSpawnPlan[]; amendments: StoredPlanAmendment[] }>
}
export interface MorzRunApi {
  listRuns(spaceRoot?: string): Promise<RunSummary[]>
}
// end w14/orch-scoped

// w14/multi-agent-plan â€” append-only team-proposal contract.
// The planner model returns recommendedTeamSize + rationale alongside the
// SpawnPlan JSON; Main strips them before schema validation and surfaces them
// on the plan response. Plan requests may carry user team constraints (size /
// composition) so a re-plan keeps the user's team without touching the goal.
import type { PlannedCli } from './spawn-plan'
export interface PlanTeamOptions {
  /** Required team size for a re-plan (1-8). */
  teamSize?: number
  /** Proposed composition to preserve on a re-plan. */
  team?: Array<{ role: string; cli: PlannedCli }>
}
export interface StoredSpawnPlan {
  recommendedTeamSize?: number
  teamRationale?: string
}
export interface PlannerBridge {
  plan(goal: string, spaceRoot: string, teamOptions?: PlanTeamOptions): Promise<StoredSpawnPlan>
}
// end w14/multi-agent-plan

// w14/runs-clear â€” append-only history IPC contract.
// Clearing only changes ledger visibility. It never removes panes, worktrees,
// branches, or any other resource owned by the explicit cleanup action.
export type RunHistoryPolicy = 'forever' | 'launch' | 'last-5'

export interface ClearedRun {
  runId: string
  clearedAt: string
  hasWorktrees: boolean
}

export const RunHistoryApi = {
  clearRun: 'run:clear',
  clearFinished: 'run:clear-finished',
  policy: 'run:history-policy'
} as const

export interface RunHistoryBridge {
  clearRun(runId: string): Promise<ClearedRun>
  clearFinished(spaceRoot: string): Promise<ClearedRun[]>
  applyPolicy(spaceRoot: string, policy: RunHistoryPolicy): Promise<ClearedRun[]>
}
// end w14/runs-clear

// w15/model-choice â€” append-only per-CLI model selection contract.
// ModelChoice types live in shared/model-choice.ts; every launch surface
// (lanes, dispatcher, planner, pulse, opencode) resolves through that engine.
// cli-config choices route through the config-writer (diff-first, never a
// direct write); inherit = NO flag ever.
import type {
  ModelCatalogEntry,
  ModelChoice,
  ModelCli,
  ModelSource
} from './model-choice'

export interface ModelChoiceSetInput {
  cli: ModelCli
  model: string
  source: ModelSource
  fallback?: string | null
  /** Absent/empty = the global default; a space root = per-space override. */
  spaceRoot?: string
}

export interface ModelChoiceSnapshot {
  cli: ModelCli
  global: ModelChoice
  spaceOverride: ModelChoice | null
  /** What a launch in the queried space would actually use (override wins). */
  effective: ModelChoice
  catalog: ModelCatalogEntry[]
}

export const ModelChoiceApi = {
  list: 'model-choice:list', // (spaceRoot?) => Promise<ModelChoiceSnapshot[]>
  set: 'model-choice:set', // (ModelChoiceSetInput) => Promise<ModelChoiceSnapshot[]>
  clearOverride: 'model-choice:clear-override', // (cli, spaceRoot) => Promise<ModelChoiceSnapshot[]>
  refreshCatalogs: 'model-choice:refresh-catalogs', // () => Promise<void>
  proposeConfig: 'model-choice:propose-config', // (cli, model) => Promise<ConfigWriterProposal> â€” diff only, never writes
  applyConfig: 'model-choice:apply-config', // (proposalId) => Promise<ConfigWriterApplyResult>
  changed: 'model-choice:changed', // push (no payload â€” re-list)
  testLaneSpawnArgs: 'model-choice:e2e-lane-spawn-args' // MORZ_E2E only
} as const

export interface MorzModelsBridge {
  list(spaceRoot?: string): Promise<ModelChoiceSnapshot[]>
  set(input: ModelChoiceSetInput): Promise<ModelChoiceSnapshot[]>
  clearOverride(cli: ModelCli, spaceRoot: string): Promise<ModelChoiceSnapshot[]>
  refreshCatalogs(): Promise<void>
  proposeConfig(cli: ModelCli, model: string): Promise<ConfigWriterProposal>
  applyConfig(proposalId: string): Promise<ConfigWriterApplyResult>
  onChanged(cb: () => void): () => void
  /** Present only when MORZ_E2E=1: last Claude lane spawn argv. */
  testLaneSpawnArgs?(): Promise<string[] | null>
}
// end w15/model-choice
// w15/context-hub â€” opt-in context-file matrix + proposal-only writes.
export interface MorzApi {
  contextHub?: import('./context-hub').ContextHubBridge
}
