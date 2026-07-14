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
  type PtyRendererMsg,
  type SessionSnapshot,
  type TerminalSpawnOpts
} from '../shared/ipc'
// w4/handoff — bus bridge (blackboard + assisted handoff)
import {
  BusApi as BusUiApi,
  type BusApprovalResp,
  type BusHandoffInput,
  type BusSnapshot
} from '../shared/bus-ipc'

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
      const h = (_e: unknown, msg: PtyRendererMsg): void => cb(msg)
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
  },
  // w4/organizer
  organizer: {
    audit: (root) => ipcRenderer.invoke('organizer:audit', root),
    propose: (root) => ipcRenderer.invoke('organizer:propose', root),
    explain: (ruleId) => ipcRenderer.invoke('organizer:explain', ruleId),
    apply: (root, planHash) => ipcRenderer.invoke('organizer:apply', { root, planHash })
  }
}

/* ── w4/bus + w4/handoff: ONE window.morz.bus — the board API (w4/bus) plus
 * the blackboard/chip UI API (w4/handoff). Attached BEFORE exposeInMainWorld
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
  },
  // blackboard/chip UI surface (typed in shared/bus-ipc.ts)
  snapshot: () => ipcRenderer.invoke(BusUiApi.snapshot),
  post: (input: BusHandoffInput) => ipcRenderer.invoke(BusUiApi.post, input),
  respondApproval: (resp: BusApprovalResp) => ipcRenderer.send(BusUiApi.approvalRespond, resp),
  onChanged: (cb) => {
    ipcRenderer.on(BusUiApi.changed, (_e, s: BusSnapshot) => cb(s))
  }
}

// w4/workshop
import { CatalogApi, type CatalogQuery, type CatalogSnapshot } from '../shared/ipc'

Object.assign(api, {
  catalog: {
    query: (query?: CatalogQuery): Promise<CatalogSnapshot> =>
      ipcRenderer.invoke(CatalogApi.query, query),
    refresh: (query?: CatalogQuery): Promise<CatalogSnapshot> =>
      ipcRenderer.invoke(CatalogApi.refresh, query),
    onUpdated: (callback: () => void): (() => void) => {
      const listener = (): void => callback()
      ipcRenderer.on(CatalogApi.updated, listener)
      return () => ipcRenderer.removeListener(CatalogApi.updated, listener)
    }
  }
})

// w4/config
import { ConfigWriterApi } from '../shared/ipc'
api.configWriter = {
  detect: () => ipcRenderer.invoke(ConfigWriterApi.detect),
  propose: (spec, targets) => ipcRenderer.invoke(ConfigWriterApi.propose, spec, targets),
  apply: (proposalId) => ipcRenderer.invoke(ConfigWriterApi.apply, proposalId)
}

// w4/obsidian
import {
  ObsidianApi as ObsidianChannels,
  type ObsidianBridge,
  type ObsidianMadrBody,
  type ObsidianSearchResult,
  type ObsidianStatus
} from '../shared/ipc'

const obsidianApi: ObsidianBridge = {
  status: (): Promise<ObsidianStatus> => ipcRenderer.invoke(ObsidianChannels.status),
  connect: (baseUrl, apiKey): Promise<ObsidianStatus> =>
    ipcRenderer.invoke(ObsidianChannels.connect, baseUrl, apiKey),
  readNote: (path): Promise<string> => ipcRenderer.invoke(ObsidianChannels.readNote, path),
  searchNotes: (query): Promise<ObsidianSearchResult[]> =>
    ipcRenderer.invoke(ObsidianChannels.searchNotes, query),
  prepareAdr: (folder, title, body: ObsidianMadrBody): Promise<{ preview: string; draftId: string }> =>
    ipcRenderer.invoke(ObsidianChannels.prepareAdr, folder, title, body),
  writeAdr: (draftId): Promise<{ path: string }> => ipcRenderer.invoke(ObsidianChannels.writeAdr, draftId)
}

contextBridge.exposeInMainWorld('morzObsidian', obsidianApi)

// w5/dag
// Keep this bridge assembly at EOF so completeVerified is present when
// contextBridge snapshots and freezes the public API.
import { DodApi } from '../shared/ipc'
Object.assign(api.bus!, {
  completeVerified: (taskId: string, agentId: string, artifact: unknown) =>
    ipcRenderer.invoke(DodApi.completeVerified, { taskId, agentId, artifact })
})
contextBridge.exposeInMainWorld('morz', api)
