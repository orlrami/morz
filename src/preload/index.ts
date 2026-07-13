/*
 * Morz preload — the ONLY bridge between the sandboxed renderer and the app.
 * Exposes window.morz exactly as typed by MorzApi in src/shared/ipc.ts.
 * Hot PTY data does not pass through here: the renderer gets a MessagePort
 * (onPort) wired straight to the PTY-host.
 */
import { contextBridge, ipcRenderer } from 'electron'
import {
  ClaudeApi,
  EditorApi,
  FileApi,
  FsApi,
  GitApi,
  PtyApi,
  SessionApi,
  type ClaudeEvent,
  type ClaudePermissionReq,
  type ClaudePermissionResp,
  type ClaudeStartOpts,
  type FileChangedMsg,
  type FileReadResult,
  type FsEntry,
  type FileSaveResult,
  type GitStatus,
  type MorzApi,
  type PtyDataMsg,
  type PtyExitMsg,
  type SessionSnapshot,
  type TerminalSpawnOpts
} from '../shared/ipc'

const api: MorzApi = {
  pty: {
    spawn: (o: TerminalSpawnOpts) => ipcRenderer.invoke(PtyApi.spawn, o),
    write: (paneId, data) => ipcRenderer.send(PtyApi.write, { paneId, data }),
    ack: (paneId, bytes) => ipcRenderer.send(PtyApi.ack, { paneId, bytes }),
    attach: (paneId) => ipcRenderer.send(PtyApi.attach, { paneId }),
    resize: (paneId, cols, rows) => ipcRenderer.send(PtyApi.resize, { paneId, cols, rows }),
    kill: (paneId) => ipcRenderer.send(PtyApi.kill, { paneId }),
    list: () => ipcRenderer.invoke(PtyApi.list),
    onData: (cb) => {
      const h = (_e: unknown, msg: PtyDataMsg | PtyExitMsg): void => cb(msg)
      ipcRenderer.on(PtyApi.data, h)
      return () => ipcRenderer.off(PtyApi.data, h)
    }
  },
  session: {
    save: (s: SessionSnapshot) => ipcRenderer.send(SessionApi.save, s),
    load: () => ipcRenderer.invoke(SessionApi.load)
  },
  file: {
    read: (path): Promise<FileReadResult> => ipcRenderer.invoke(FileApi.read, path),
    save: (path, content, expectedMtimeMs): Promise<FileSaveResult> =>
      ipcRenderer.invoke(FileApi.save, { path, content, expectedMtimeMs }),
    watch: (path) => ipcRenderer.send(FileApi.watch, path),
    unwatch: (path) => ipcRenderer.send(FileApi.unwatch, path),
    onChanged: (cb) => {
      ipcRenderer.on(FileApi.changed, (_e, m: FileChangedMsg) => cb(m))
    }
  },
  fs: {
    list: (dir): Promise<FsEntry[]> => ipcRenderer.invoke(FsApi.list, dir)
  },
  git: {
    status: (cwd): Promise<GitStatus> => ipcRenderer.invoke(GitApi.status, cwd),
    watch: (cwd) => ipcRenderer.send(GitApi.watch, cwd),
    onChanged: (cb) => {
      ipcRenderer.on(GitApi.changed, (_e, s: GitStatus) => cb(s))
    }
  },
  claude: {
    start: (o: ClaudeStartOpts) => ipcRenderer.invoke(ClaudeApi.start, o),
    send: (agentId, text) => ipcRenderer.send(ClaudeApi.send, { agentId, text }),
    interrupt: (agentId) => ipcRenderer.send(ClaudeApi.interrupt, { agentId }),
    onEvent: (cb) => {
      ipcRenderer.on(ClaudeApi.event, (_e, m: { agentId: string; event: ClaudeEvent }) => cb(m))
    },
    onPermission: (cb) => {
      ipcRenderer.on(ClaudeApi.permission, (_e, r: ClaudePermissionReq) => cb(r))
    },
    respondPermission: (r: ClaudePermissionResp) => ipcRenderer.send(ClaudeApi.permissionRespond, r)
  },
  editor: {
    detect: () => ipcRenderer.invoke(EditorApi.detectEditors),
    openExternal: (editor, path, line, col) =>
      ipcRenderer.send(EditorApi.openExternal, { editor, path, line, col })
  }
}

/* ── w4/bus: bus namespace — must attach BEFORE exposeInMainWorld
 * (contextBridge snapshots the object at expose time). ── */
import { BusApi } from '../shared/ipc'
import type { Task } from '../shared/bus'

api.bus = {
  listTasks: (filter) => ipcRenderer.invoke(BusApi.listTasks, filter),
  createTask: (input) => ipcRenderer.invoke(BusApi.createTask, input),
  acceptTask: (taskId) => ipcRenderer.invoke(BusApi.acceptTask, taskId),
  withdrawTask: (taskId) => ipcRenderer.invoke(BusApi.withdrawTask, taskId),
  claimTask: (taskId, agentId, leaseMs) =>
    ipcRenderer.invoke(BusApi.claimTask, { taskId, agentId, leaseMs }),
  completeTask: (taskId, agentId, artifact) =>
    ipcRenderer.invoke(BusApi.completeTask, { taskId, agentId, artifact }),
  blockTask: (taskId, agentId, reason) =>
    ipcRenderer.invoke(BusApi.blockTask, { taskId, agentId, reason }),
  resumeTask: (taskId, agentId, leaseMs) =>
    ipcRenderer.invoke(BusApi.resumeTask, { taskId, agentId, leaseMs }),
  send: (input) => ipcRenderer.invoke(BusApi.send, input),
  onTasksChanged: (cb) => {
    const h = (_e: unknown, tasks: Task[]): void => cb(tasks)
    ipcRenderer.on(BusApi.tasksChanged, h)
    return () => ipcRenderer.off(BusApi.tasksChanged, h)
  }
}

contextBridge.exposeInMainWorld('morz', api)
