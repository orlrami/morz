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

/* ── w5/dispatch: window.morz.run — approved SpawnPlan → running team.
 * Attached BEFORE exposeInMainWorld (contextBridge snapshots the object at
 * expose time, same constraint the w4/bus block documents). ── */
import { RunApi, type MorzRunApi } from '../shared/ipc'
import type { RunStatus, SpawnPlan } from '../shared/spawn-plan'

const runApi: MorzRunApi = {
  approvePlan: (plan: SpawnPlan) => ipcRenderer.invoke(RunApi.approvePlan, plan),
  dispatch: (plan: SpawnPlan) => ipcRenderer.invoke(RunApi.dispatch, plan),
  listRuns: () => ipcRenderer.invoke(RunApi.list),
  runStatus: (runId) => ipcRenderer.invoke(RunApi.status, runId),
  stopRun: (runId) => ipcRenderer.invoke(RunApi.stop, runId),
  cleanup: (runId) => ipcRenderer.invoke(RunApi.cleanup, runId),
  onRunChanged: (cb) => {
    const h = (_e: unknown, status: RunStatus): void => cb(status)
    ipcRenderer.on(RunApi.changed, h)
    return () => ipcRenderer.off(RunApi.changed, h)
  }
}
api.run = runApi
// end w5/dispatch

// NOTE: the single window.morz expose lives at the END of this file (after the
// w5/dag completeVerified attach) — contextBridge snapshots the object at
// expose time and ignores a second expose of the same key, so `api` must be
// fully assembled before the one exposeInMainWorld('morz', api) call.

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

// w5/planner
import { PlannerApi, type PlannerBridge } from '../shared/ipc'

const plannerApi: PlannerBridge = {
  plan: (goal, spaceRoot) => ipcRenderer.invoke(PlannerApi.plan, { goal, spaceRoot }),
  update: (plan, expectedHash) => ipcRenderer.invoke(PlannerApi.update, { plan, expectedHash }),
  approveAndRun: (planHash) => ipcRenderer.invoke(PlannerApi.approveAndRun, planHash),
  discard: (planHash) => ipcRenderer.invoke(PlannerApi.discard, planHash),
  listOpen: () => ipcRenderer.invoke(PlannerApi.listOpen),
  requestAmendment: (planId, request) =>
    ipcRenderer.invoke(PlannerApi.requestAmendment, { planId, request }),
  approveAmendment: (amendmentHash) =>
    ipcRenderer.invoke(PlannerApi.approveAmendment, amendmentHash),
  discardAmendment: (amendmentHash) =>
    ipcRenderer.invoke(PlannerApi.discardAmendment, amendmentHash)
}

contextBridge.exposeInMainWorld('morzPlanner', plannerApi)
// w5/reviewer
import {
  ReviewApi,
  type ReviewerBridge,
  type ReviewRunInput,
  type ReviewRunResult
} from '../shared/ipc'

const reviewerBridge: ReviewerBridge = {
  run: (input: ReviewRunInput): Promise<ReviewRunResult> =>
    ipcRenderer.invoke(ReviewApi.run, input),
  onChanged: (callback) => {
    const listener = (_event: unknown, result: ReviewRunResult): void => callback(result)
    ipcRenderer.on(ReviewApi.changed, listener)
    return () => ipcRenderer.off(ReviewApi.changed, listener)
  }
}

contextBridge.exposeInMainWorld('morzReviewer', reviewerBridge)
// w5/dag
// Keep this bridge assembly at EOF so completeVerified is present when
// contextBridge snapshots and freezes the public API.
import { DodApi } from '../shared/ipc'
Object.assign(api.bus!, {
  completeVerified: (taskId: string, agentId: string, artifact: unknown) =>
    ipcRenderer.invoke(DodApi.completeVerified, { taskId, agentId, artifact })
})
// The single window.morz exposure is deferred to the w6/errors EOF block.
// w5/commit
import { CommitApi, type CommitBridge } from '../shared/ipc'
const commitApi: CommitBridge = {
  fileDiff: (root, path) => ipcRenderer.invoke(CommitApi.fileDiff, root, path),
  stageFile: (root, path) => ipcRenderer.invoke(CommitApi.stageFile, root, path),
  unstageFile: (root, path) => ipcRenderer.invoke(CommitApi.unstageFile, root, path),
  stageHunk: (root, patch) => ipcRenderer.invoke(CommitApi.stageHunk, root, patch),
  discardFile: (root, path, confirmed) =>
    ipcRenderer.invoke(CommitApi.discardFile, root, path, confirmed),
  stagedDiff: (root) => ipcRenderer.invoke(CommitApi.stagedDiff, root),
  commit: (root, message) => ipcRenderer.invoke(CommitApi.commit, root, message),
  log: (root) => ipcRenderer.invoke(CommitApi.log, root),
  suggestMessage: (root) => ipcRenderer.invoke(CommitApi.suggestMessage, root)
}
contextBridge.exposeInMainWorld('morzCommit', commitApi)
// w5/cost
import {
  CostApi as CostChannels,
  type CostBreach,
  type CostBridge,
  type CostSnapshot,
  type CostTestTrackInput,
  type CostUsageSample
} from '../shared/ipc'

const costApi: CostBridge = {
  snapshot: (): Promise<CostSnapshot> => ipcRenderer.invoke(CostChannels.snapshot),
  resume: (runId): Promise<CostSnapshot> => ipcRenderer.invoke(CostChannels.resume, runId),
  stop: (runId): Promise<CostSnapshot> => ipcRenderer.invoke(CostChannels.stop, runId),
  onUpdated: (callback) => {
    const listener = (_event: unknown, snapshot: CostSnapshot): void => callback(snapshot)
    ipcRenderer.on(CostChannels.updated, listener)
    return () => ipcRenderer.off(CostChannels.updated, listener)
  },
  onBreach: (callback) => {
    const listener = (_event: unknown, breach: CostBreach): void => callback(breach)
    ipcRenderer.on(CostChannels.breach, listener)
    return () => ipcRenderer.off(CostChannels.breach, listener)
  }
}

if (process.env.MORZ_E2E === '1') {
  costApi.testTrack = (input: CostTestTrackInput): Promise<void> =>
    ipcRenderer.invoke(CostChannels.testTrack, input)
}

contextBridge.exposeInMainWorld('morzCost', costApi)

function claudeUsage(event: ClaudeEvent): CostUsageSample | null {
  if (event.type === 'meter') {
    const input = typeof event.inputTokens === 'number' ? event.inputTokens : 0
    const output = typeof event.outputTokens === 'number' ? event.outputTokens : 0
    if (input === 0 && output === 0) return null
    return { tokens: input + output, mode: 'total' }
  }
  if (event.type !== 'result') return null
  const sample: CostUsageSample = { mode: 'total' }
  if (typeof event.total_cost_usd === 'number') sample.usd = event.total_cost_usd
  if (event.usage && typeof event.usage === 'object') {
    const usage = event.usage as Record<string, unknown>
    const keys = [
      'input_tokens',
      'output_tokens',
      'cache_creation_input_tokens',
      'cache_read_input_tokens'
    ]
    let total = 0
    let seen = false
    for (const key of keys) {
      if (typeof usage[key] === 'number') {
        total += usage[key]
        seen = true
      }
    }
    if (seen) sample.tokens = total
  }
  return sample.usd == null && sample.tokens == null ? null : sample
}

// Ordinary, non-dispatch lanes have no runId. The dispatcher calls
// costMeter.track(runId, agentId, usage) directly for run-owned lanes.
const claudeSessionSources = new Map<string, string>()
ipcRenderer.on(ClaudeApi.event, (_event, message: { agentId: string; event: ClaudeEvent }) => {
  if (message.event.type === 'system' && message.event.subtype === 'init') {
    const sessionId = message.event.session_id
    if (typeof sessionId === 'string' && sessionId) {
      claudeSessionSources.set(message.agentId, `claude:${sessionId}`)
    }
    return
  }
  const usage = claudeUsage(message.event)
  if (usage) {
    usage.source = claudeSessionSources.get(message.agentId) ?? 'claude'
    ipcRenderer.send(CostChannels.trackAdapter, { agentId: message.agentId, usage })
  }
  if (message.event.type === 'process_exit') claudeSessionSources.delete(message.agentId)
})

// w6/errors
import { NotifyApi, type MorzNotifyApi, type NotifyItem } from '../shared/notify'

const notifyApi: MorzNotifyApi = {
  emit: (item: NotifyItem) => ipcRenderer.send(NotifyApi.emit, item),
  list: (): Promise<NotifyItem[]> => ipcRenderer.invoke(NotifyApi.list),
  markRead: (id) => ipcRenderer.send(NotifyApi.markRead, id),
  dismiss: (id) => ipcRenderer.send(NotifyApi.dismiss, id),
  action: (id, actionId) => ipcRenderer.send(NotifyApi.action, { id, actionId }),
  onPushed: (callback) => {
    const listener = (_event: unknown, item: NotifyItem): void => callback(item)
    ipcRenderer.on(NotifyApi.pushed, listener)
    return () => ipcRenderer.off(NotifyApi.pushed, listener)
  },
  onAction: (callback) => {
    const listener = (_event: unknown, payload: { id: string; actionId: string }): void => callback(payload)
    ipcRenderer.on(NotifyApi.action, listener)
    return () => ipcRenderer.off(NotifyApi.action, listener)
  }
}

api.notify = notifyApi
// window.morz exposure is deferred to the w8/memory-core EOF block.
// end w6/errors
// w6/assistant — APPEND-ONLY: optional assistant proposal bridge
import {
  AssistantApi as AssistantChannels,
  type AssistantBridge,
  type AssistantConnectionStatus,
  type AssistantProvider,
  type StoredSpawnPlan
} from '../shared/ipc'

const assistantApi: AssistantBridge = {
  listProviders: (): Promise<AssistantProvider[]> =>
    ipcRenderer.invoke(AssistantChannels.listProviders),
  status: (): Promise<AssistantConnectionStatus> => ipcRenderer.invoke(AssistantChannels.status),
  setEnabled: (enabled): Promise<AssistantConnectionStatus> =>
    ipcRenderer.invoke(AssistantChannels.setEnabled, enabled),
  connect: (providerId): Promise<AssistantConnectionStatus> =>
    ipcRenderer.invoke(AssistantChannels.connect, providerId),
  disconnect: (): Promise<AssistantConnectionStatus> =>
    ipcRenderer.invoke(AssistantChannels.disconnect),
  propose: (goal, spaceRoot): Promise<StoredSpawnPlan> =>
    ipcRenderer.invoke(AssistantChannels.propose, { goal, spaceRoot })
}

contextBridge.exposeInMainWorld('morzAssistant', assistantApi)
// w6/pulse — append-only Daily Pulse bridge; separate because window.morz was snapshotted above.
import {
  PulseApi as PulseChannels,
  type PulseBridge,
  type PulseBrief,
  type PulseConfigureInput,
  type PulseReadyEvent,
  type PulseRunInput,
  type PulseSnapshot
} from '../shared/ipc'
// NotifyItem already imported by the w6/errors block above

const pulseBridge: PulseBridge = {
  snapshot: (): Promise<PulseSnapshot> => ipcRenderer.invoke(PulseChannels.snapshot),
  configure: (input: PulseConfigureInput): Promise<PulseSnapshot> =>
    ipcRenderer.invoke(PulseChannels.configure, input),
  runNow: (input: PulseRunInput): Promise<PulseBrief> =>
    ipcRenderer.invoke(PulseChannels.runNow, input),
  onReady: (callback) => {
    const listener = (_event: unknown, ready: PulseReadyEvent): void => callback(ready)
    ipcRenderer.on(PulseChannels.ready, listener)
    return () => ipcRenderer.off(PulseChannels.ready, listener)
  },
  onNotice: (callback) => {
    const listener = (_event: unknown, notice: NotifyItem): void => callback(notice)
    ipcRenderer.on(PulseChannels.notice, listener)
    return () => ipcRenderer.off(PulseChannels.notice, listener)
  },
  ackNotice: (id: string): Promise<void> => ipcRenderer.invoke(PulseChannels.ackNotice, id),
  onOpen: (callback) => {
    const listener = (_event: unknown, brief: PulseBrief): void => callback(brief)
    ipcRenderer.on(PulseChannels.open, listener)
    return () => ipcRenderer.off(PulseChannels.open, listener)
  }
}

if (process.env.MORZ_E2E === '1') {
  pulseBridge.testNextFire = (time: string, now: number): Promise<number> =>
    ipcRenderer.invoke(PulseChannels.testNextFire, time, now)
}

contextBridge.exposeInMainWorld('morzPulse', pulseBridge)

// w8/memory-core — append-only learning-memory bridge
import {
  MemoryApi as MemoryChannels,
  type MemoryEntry,
  type MemoryProposal,
  type MemoryScope,
  type MorzMemoryApi
} from '../shared/memory'

type MemoryE2eApi = MorzMemoryApi & {
  testPropose?(proposal: MemoryProposal): Promise<MemoryProposal>
  testRender?(opts: { projectRoot?: string; spaceId?: string; agentId?: string }): Promise<string>
}

const memoryApi: MemoryE2eApi = {
  list: (scope?: MemoryScope, scopeRef?: string): Promise<MemoryEntry[]> =>
    ipcRenderer.invoke(MemoryChannels.list, scope, scopeRef),
  get: (id: string): Promise<MemoryEntry | null> => ipcRenderer.invoke(MemoryChannels.get, id),
  save: (entry: MemoryEntry): Promise<MemoryEntry> => ipcRenderer.invoke(MemoryChannels.save, entry),
  remove: (id: string): Promise<void> => ipcRenderer.invoke(MemoryChannels.remove, id),
  setEnabled: (id: string, enabled: boolean): Promise<MemoryEntry> =>
    ipcRenderer.invoke(MemoryChannels.setEnabled, { id, enabled }),
  search: (query: string, limit?: number): Promise<MemoryEntry[]> =>
    ipcRenderer.invoke(MemoryChannels.search, query, limit),
  proposals: (): Promise<MemoryProposal[]> => ipcRenderer.invoke(MemoryChannels.proposals),
  resolveProposal: (id: string, approved: boolean): Promise<MemoryProposal> =>
    ipcRenderer.invoke(MemoryChannels.resolveProposal, { id, approved }),
  onChanged: (callback) => {
    const listener = (): void => callback()
    ipcRenderer.on(MemoryChannels.changed, listener)
    return () => ipcRenderer.off(MemoryChannels.changed, listener)
  }
}

if (process.env.MORZ_E2E === '1') {
  memoryApi.testPropose = (proposal) => ipcRenderer.invoke('memory:e2e-propose', proposal)
  memoryApi.testRender = (opts) => ipcRenderer.invoke('memory:e2e-render', opts)
}

const apiWithMemory = api as MorzApi & { memory: MorzMemoryApi }
apiWithMemory.memory = memoryApi
// window.morz exposure is deferred to the w11/report-engine EOF block.
// w8/routing — append-only routing/settings bridge.
import {
  RoutingApi as RoutingChannels,
  type RouteDecision,
  type RouteOptions,
  type RoutingBridge,
  type RoutingRule,
  type RoutingSnapshot,
  type LocalModelStatus
} from '../shared/ipc'

const routingBridge: RoutingBridge = {
  snapshot: (spaceRoot?: string): Promise<RoutingSnapshot> =>
    ipcRenderer.invoke(RoutingChannels.snapshot, spaceRoot),
  saveRules: (rules: RoutingRule[]): Promise<RoutingRule[]> =>
    ipcRenderer.invoke(RoutingChannels.saveRules, rules),
  setSpacePrivate: (spaceRoot: string, value: boolean): Promise<boolean> =>
    ipcRenderer.invoke(RoutingChannels.setSpacePrivate, { spaceRoot, value }),
  refreshLocalModels: (): Promise<LocalModelStatus[]> =>
    ipcRenderer.invoke(RoutingChannels.refreshLocalModels),
  route: (taskText: string, options: RouteOptions = {}): Promise<RouteDecision> =>
    ipcRenderer.invoke(RoutingChannels.route, { taskText, options })
}

contextBridge.exposeInMainWorld('morzRouting', routingBridge)
// end w8/routing
// w8/voice — append-only local Whisper bridge.
import {
  VoiceApi as VoiceChannels,
  type VoiceBridge,
  type VoiceSettingsSnapshot
} from '../shared/ipc'

const voiceBridge: VoiceBridge = {
  settings: (): Promise<VoiceSettingsSnapshot> => ipcRenderer.invoke(VoiceChannels.settings),
  chooseEngine: (): Promise<VoiceSettingsSnapshot> =>
    ipcRenderer.invoke(VoiceChannels.chooseEngine),
  clearEngine: (): Promise<VoiceSettingsSnapshot> => ipcRenderer.invoke(VoiceChannels.clearEngine),
  testTranscription: (): Promise<string | null> =>
    ipcRenderer.invoke(VoiceChannels.testTranscription),
  transcribe: (audio: Uint8Array): Promise<string> =>
    ipcRenderer.invoke(VoiceChannels.transcribe, audio)
}

contextBridge.exposeInMainWorld('morzVoice', voiceBridge)

// w9/spaces — append-only native folder picker bridge.
import { DialogApi as DialogChannels, type DialogBridge } from '../shared/ipc'

const dialogBridge: DialogBridge = {
  pickFolder: (): Promise<string | null> => ipcRenderer.invoke(DialogChannels.pickFolder)
}

contextBridge.exposeInMainWorld('morzDialog', dialogBridge)
// end w9/spaces
// w9/browser — append-only isolated embedded-browser bridge.
import {
  BrowserApi as BrowserChannels,
  type BrowserAgentKind,
  type BrowserBridge,
  type BrowserRect,
  type BrowserState,
  type ElementContext
} from '../shared/ipc'

const browserBridge: BrowserBridge = {
  create: (): Promise<BrowserState> => ipcRenderer.invoke(BrowserChannels.create),
  destroy: (): Promise<void> => ipcRenderer.invoke(BrowserChannels.destroy),
  state: (): Promise<BrowserState> => ipcRenderer.invoke(BrowserChannels.state),
  navigate: (url: string): Promise<BrowserState> =>
    ipcRenderer.invoke(BrowserChannels.navigate, url),
  setBounds: (rect: BrowserRect): void => ipcRenderer.send(BrowserChannels.setBounds, rect),
  back: (): Promise<BrowserState> => ipcRenderer.invoke(BrowserChannels.back),
  forward: (): Promise<BrowserState> => ipcRenderer.invoke(BrowserChannels.forward),
  reload: (): Promise<BrowserState> => ipcRenderer.invoke(BrowserChannels.reload),
  setPickMode: (enabled: boolean): Promise<BrowserState> =>
    ipcRenderer.invoke(BrowserChannels.setPickMode, enabled),
  discoverLocalhost: (): Promise<string[]> =>
    ipcRenderer.invoke(BrowserChannels.discoverLocalhost),
  liveAgents: (kind: BrowserAgentKind): Promise<string[]> =>
    ipcRenderer.invoke(BrowserChannels.liveAgents, kind),
  copyText: (text: string): Promise<void> => ipcRenderer.invoke(BrowserChannels.copyText, text),
  onStateChanged: (callback) => {
    const listener = (_event: unknown, state: BrowserState): void => callback(state)
    ipcRenderer.on(BrowserChannels.stateChanged, listener)
    return () => ipcRenderer.off(BrowserChannels.stateChanged, listener)
  },
  onPicked: (callback) => {
    const listener = (_event: unknown, context: ElementContext): void => callback(context)
    ipcRenderer.on(BrowserChannels.picked, listener)
    return () => ipcRenderer.off(BrowserChannels.picked, listener)
  }
}

if (process.env.MORZ_E2E === '1') {
  browserBridge.testPick = (selector: string): Promise<ElementContext> =>
    ipcRenderer.invoke(BrowserChannels.testPick, selector)
}

contextBridge.exposeInMainWorld('morzBrowser', browserBridge)
// end w9/browser
// w9/installer
import {
  UpdaterApi as UpdaterChannels,
  type UpdaterBridge,
  type UpdaterSnapshot
} from '../shared/ipc'

const updaterBridge: UpdaterBridge = {
  status: (): Promise<UpdaterSnapshot> => ipcRenderer.invoke(UpdaterChannels.status),
  check: (): Promise<UpdaterSnapshot> => ipcRenderer.invoke(UpdaterChannels.check),
  onChanged: (callback) => {
    const listener = (_event: unknown, value: UpdaterSnapshot): void => callback(value)
    ipcRenderer.on(UpdaterChannels.changed, listener)
    return () => ipcRenderer.off(UpdaterChannels.changed, listener)
  }
}

contextBridge.exposeInMainWorld('morzUpdater', updaterBridge)

// w11/connections — append-only CLI detection and usage bridge.
import {
  ConnectionsApi as ConnectionsChannels,
  type CliConnection,
  type MorzConnectionsApi
} from '../shared/connections'

const connectionsBridge: MorzConnectionsApi = {
  list: (): Promise<CliConnection[]> => ipcRenderer.invoke(ConnectionsChannels.list),
  refresh: (): Promise<CliConnection[]> => ipcRenderer.invoke(ConnectionsChannels.refresh),
  onChanged: (callback) => {
    const listener = (_event: unknown, connections: CliConnection[]): void => callback(connections)
    ipcRenderer.on(ConnectionsChannels.changed, listener)
    return () => ipcRenderer.off(ConnectionsChannels.changed, listener)
  }
}

contextBridge.exposeInMainWorld('morzConnections', connectionsBridge)
// w11/report-engine — append-only AI report bridge; this is the single window.morz exposure.
import {
  ReportApi as ReportChannels,
  type MorzReportApi,
  type ReportProvider,
  type ReportRequest
} from '../shared/report'

const reportBridge: MorzReportApi = {
  config: () => ipcRenderer.invoke(ReportChannels.config),
  setProvider: (provider: ReportProvider, model?: string) =>
    ipcRenderer.invoke(ReportChannels.setProvider, { provider, model }),
  setKey: (provider: ReportProvider, key: string) =>
    ipcRenderer.invoke(ReportChannels.setKey, { provider, key }),
  clearKey: (provider: ReportProvider) => ipcRenderer.invoke(ReportChannels.clearKey, provider),
  test: () => ipcRenderer.invoke(ReportChannels.test),
  summarize: (request: ReportRequest) => ipcRenderer.invoke(ReportChannels.summarize, request)
}

const apiWithReport = apiWithMemory as typeof apiWithMemory & { report: MorzReportApi }
apiWithReport.report = reportBridge
contextBridge.exposeInMainWorld('morz', apiWithReport)
