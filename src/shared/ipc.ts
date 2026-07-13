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
/**
 * Every message that travels over the PTY MessagePort (renderer↔PTY-host).
 * Flow control: host pauses a PTY when unacked bytes to the renderer exceed a
 * high watermark; renderer sends `ack` after xterm has consumed ~5k chars.
 */
export type PtyPortMsg =
  | ({ type: 'write' } & PtyDataMsg) // renderer→host: keystrokes
  | { type: 'ack'; paneId: string; bytes: number } // renderer→host: flow-control ack
  | { type: 'attach'; paneId: string } // renderer→host: replay scrollback after window reopen
  | ({ type: 'data' } & PtyDataMsg) // host→renderer: PTY output
  | ({ type: 'exit' } & PtyExitMsg) // host→renderer: PTY exited
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
  data: 'pty:data' // push main→renderer: PtyDataMsg | PtyExitMsg (tagged)
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
    /** PTY output/exit pushed from main. Returns an unsubscribe fn. */
    onData(cb: (msg: PtyDataMsg | PtyExitMsg) => void): () => void
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
// it in its own w4/bus block after the base api literal is built
export interface MorzApi {
  bus?: MorzBusApi
}
