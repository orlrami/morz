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
/** MessagePort channel name posted from main→renderer once, carries all PTY data both ways. */
export const PTY_PORT_CHANNEL = 'morz:pty-port'
export const PtyApi = {
  spawn: 'pty:spawn', // (TerminalSpawnOpts) => Promise<{ok:boolean}>
  write: 'pty:write', // over MessagePort: {paneId, data}
  resize: 'pty:resize', // ({paneId, cols, rows})
  kill: 'pty:kill', // ({paneId})
  list: 'pty:list' // () => Promise<string[]> live paneIds (for reattach)
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
    resize(paneId: string, cols: number, rows: number): void
    kill(paneId: string): void
    list(): Promise<string[]>
    /** renderer receives the MessagePort for PTY data; call once at startup. */
    onPort(cb: (port: MessagePort) => void): void
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
