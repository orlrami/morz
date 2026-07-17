import { create } from 'zustand'
import type {
  CommitAiBridge,
  CommitBridge,
  CommitFileDiff,
  CommitHistoryEntry,
  CommitLogEntry,
  GitFile
} from '@shared/ipc'
import type { MorzReportApi, ReportKind } from '@shared/report'

const REPORT_ENGINE_HINT = 'Connect an AI report engine in Settings to explain commits, files, and branches.'
const MAX_REPORT_CONTEXT_BYTES = 384 * 1024

interface CommitSummary {
  title: string
  text: string
  status: 'loading' | 'ready' | 'hint' | 'error'
}

interface CommitState {
  root: string
  files: GitFile[]
  selectedPath: string | null
  diff: CommitFileDiff | null
  log: CommitHistoryEntry[]
  selectedCommitSha: string | null
  lastCommitSha: string | null
  summary: CommitSummary | null
  message: string
  loading: boolean
  busy: string | null
  error: string | null
  setMessage(message: string): void
  refresh(root: string): Promise<void>
  selectFile(root: string, path: string): Promise<void>
  stageFile(root: string, path: string): Promise<void>
  unstageFile(root: string, path: string): Promise<void>
  stageHunk(root: string, patch: string): Promise<void>
  discardFile(root: string, path: string, confirmed: boolean): Promise<void>
  createCommit(root: string): Promise<string | null>
  suggestMessage(root: string): Promise<void>
  summarizeCommit(root: string, entry: CommitHistoryEntry): Promise<void>
  summarizeFile(root: string, path: string): Promise<void>
  summarizeBranch(root: string): Promise<void>
}

function bridge(): CommitBridge {
  const api = (window as unknown as { morzCommit?: CommitBridge }).morzCommit
  if (!api) throw new Error('Commit bridge is unavailable')
  return api
}

function commitAiBridge(): CommitAiBridge | undefined {
  return (window as unknown as { morzCommitAi?: CommitAiBridge }).morzCommitAi
}

async function loadCommitLog(root: string): Promise<CommitLogEntry[]> {
  let primaryError: unknown
  try {
    const entries = await bridge().log(root)
    if (entries.length > 0) return entries
  } catch (error) {
    primaryError = error
  }

  const historyBridge = commitAiBridge()
  if (historyBridge) {
    try {
      return await historyBridge.commitLog(root)
    } catch (error) {
      if (primaryError === undefined) primaryError = error
    }
  }

  if (primaryError !== undefined) throw primaryError
  return []
}

function reportBridge(): MorzReportApi | undefined {
  const bridges = window as unknown as {
    morz?: { report?: MorzReportApi }
    /** Deterministic consumer-contract stub, exposed only under MORZ_E2E. */
    morzCommitAiReportStub?: MorzReportApi
    morzCommitAiReportDisabled?: boolean
  }
  if (bridges.morzCommitAiReportDisabled) return undefined
  return bridges.morzCommitAiReportStub ?? bridges.morz?.report
}

function boundedReportContext(value: string): string {
  const encoded = new TextEncoder().encode(value)
  if (encoded.byteLength <= MAX_REPORT_CONTEXT_BYTES) return value
  const prefix = new TextDecoder().decode(encoded.slice(0, MAX_REPORT_CONTEXT_BYTES))
  return `${prefix}\n... [report context truncated at 384 KB]`
}

async function requestReport(kind: ReportKind, context: string, cwd: string): Promise<CommitSummary> {
  const report = reportBridge()
  if (!report) return { title: '', text: REPORT_ENGINE_HINT, status: 'hint' }
  try {
    const config = await report.config()
    if (!config.configured) return { title: '', text: REPORT_ENGINE_HINT, status: 'hint' }
    const result = await report.summarize({ kind, context: boundedReportContext(context), cwd })
    return {
      title: '',
      text: result.text || (result.ok ? 'The report engine returned an empty summary.' : 'Report failed.'),
      status: result.ok ? 'ready' : 'error'
    }
  } catch (error) {
    return { title: '', text: errorMessage(error), status: 'error' }
  }
}

function formatLog(entries: Array<{ shortSha: string; date: string; subject: string }>): string {
  return entries.length
    ? entries.map((entry) => `${entry.shortSha} ${entry.date} ${entry.subject}`).join('\n')
    : '(no commits found)'
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

let refreshGeneration = 0
let operationGeneration = 0
let summaryGeneration = 0

export const useCommitStore = create<CommitState>((set, get) => ({
  root: '',
  files: [],
  selectedPath: null,
  diff: null,
  log: [],
  selectedCommitSha: null,
  lastCommitSha: null,
  summary: null,
  message: '',
  loading: false,
  busy: null,
  error: null,
  setMessage: (message) => set({ message, lastCommitSha: null }),
  refresh: async (root) => {
    const generation = ++refreshGeneration
    const rootChanged = get().root !== root
    if (rootChanged) operationGeneration += 1
    if (!root) {
      summaryGeneration += 1
      set({ root, files: [], selectedPath: null, diff: null, log: [], selectedCommitSha: null, lastCommitSha: null, summary: null, message: '', loading: false, busy: null, error: null })
      return
    }
    set({
      root,
      loading: true,
      error: null,
      ...(rootChanged ? { files: [], selectedPath: null, diff: null, log: [], selectedCommitSha: null, lastCommitSha: null, summary: null, message: '', busy: null } : {})
    })
    try {
      const [status, entries] = await Promise.all([
        window.morz.git.status(root),
        loadCommitLog(root)
      ])
      if (generation !== refreshGeneration) return
      const previous = get().root === root ? get().selectedPath : null
      const selectedPath =
        previous && status.files.some((file) => file.path === previous)
          ? previous
          : (status.files[0]?.path ?? null)
      set({
        root,
        files: status.files,
        log: entries.map((entry) => ({ ...entry, diff: '' })),
        selectedPath,
        loading: false
      })
      if (selectedPath) await get().selectFile(root, selectedPath)
      else set({ diff: null })
    } catch (error) {
      if (generation === refreshGeneration) set({ loading: false, error: errorMessage(error) })
    }
  },
  selectFile: async (root, path) => {
    if (get().root !== root) return
    summaryGeneration += 1
    set({ selectedPath: path, selectedCommitSha: null, diff: null, summary: null, error: null })
    try {
      const diff = await bridge().fileDiff(root, path)
      if (get().root === root && get().selectedPath === path) set({ diff })
    } catch (error) {
      if (get().root === root && get().selectedPath === path) set({ error: errorMessage(error) })
    }
  },
  stageFile: async (root, path) => {
    if (get().root !== root) return
    const operation = ++operationGeneration
    set({ busy: `stage:${path}`, error: null })
    try {
      await bridge().stageFile(root, path)
      if (operation !== operationGeneration || get().root !== root) return
      await get().refresh(root)
    } catch (error) {
      if (operation === operationGeneration && get().root === root) set({ error: errorMessage(error) })
    } finally {
      if (operation === operationGeneration && get().root === root) set({ busy: null })
    }
  },
  unstageFile: async (root, path) => {
    if (get().root !== root) return
    const operation = ++operationGeneration
    set({ busy: `unstage:${path}`, error: null })
    try {
      await bridge().unstageFile(root, path)
      if (operation !== operationGeneration || get().root !== root) return
      await get().refresh(root)
    } catch (error) {
      if (operation === operationGeneration && get().root === root) set({ error: errorMessage(error) })
    } finally {
      if (operation === operationGeneration && get().root === root) set({ busy: null })
    }
  },
  stageHunk: async (root, patch) => {
    if (get().root !== root) return
    const operation = ++operationGeneration
    set({ busy: 'stage-hunk', error: null })
    try {
      await bridge().stageHunk(root, patch)
      if (operation !== operationGeneration || get().root !== root) return
      await get().refresh(root)
    } catch (error) {
      if (operation === operationGeneration && get().root === root) set({ error: errorMessage(error) })
    } finally {
      if (operation === operationGeneration && get().root === root) set({ busy: null })
    }
  },
  discardFile: async (root, path, confirmed) => {
    if (get().root !== root) return
    const operation = ++operationGeneration
    set({ busy: `discard:${path}`, error: null })
    try {
      await bridge().discardFile(root, path, confirmed)
      if (operation !== operationGeneration || get().root !== root) return
      await get().refresh(root)
    } catch (error) {
      if (operation === operationGeneration && get().root === root) set({ error: errorMessage(error) })
    } finally {
      if (operation === operationGeneration && get().root === root) set({ busy: null })
    }
  },
  createCommit: async (root) => {
    if (get().root !== root) return null
    const operation = ++operationGeneration
    const message = get().message
    let createdSha: string | null = null
    set({ busy: 'commit', error: null, lastCommitSha: null })
    try {
      const result = await bridge().commit(root, message)
      createdSha = result.sha
      if (operation !== operationGeneration || get().root !== root) return null
      set({ message: '' })
      await get().refresh(root)
      if (operation !== operationGeneration || get().root !== root) return null
      if (!get().log.some((entry) => entry.sha === createdSha)) {
        const entries = await loadCommitLog(root)
        if (operation !== operationGeneration || get().root !== root) return null
        set({ log: entries.map((entry) => ({ ...entry, diff: '' })) })
      }
      if (!get().log.some((entry) => entry.sha === createdSha)) {
        throw new Error(`Commit ${createdSha.slice(0, 7)} was created, but Git history did not return it`)
      }
      set({ lastCommitSha: createdSha })
      return createdSha
    } catch (error) {
      if (operation === operationGeneration && get().root === root) {
        set({
          error: createdSha
            ? `Committed ${createdSha.slice(0, 7)}, but history refresh failed: ${errorMessage(error)}`
            : errorMessage(error),
          lastCommitSha: createdSha
        })
      }
      return createdSha
    } finally {
      if (operation === operationGeneration && get().root === root) set({ busy: null })
    }
  },
  suggestMessage: async (root) => {
    if (get().root !== root) return
    const operation = ++operationGeneration
    set({ busy: 'suggest', error: null })
    try {
      const message = await bridge().suggestMessage(root)
      if (operation === operationGeneration && get().root === root) set({ message })
    } catch (error) {
      if (operation === operationGeneration && get().root === root) set({ error: errorMessage(error) })
    } finally {
      if (operation === operationGeneration && get().root === root) set({ busy: null })
    }
  },
  summarizeCommit: async (root, entry) => {
    if (get().root !== root) return
    const generation = ++summaryGeneration
    const title = `Commit ${entry.shortSha}`
    set({ selectedCommitSha: entry.sha, summary: { title, text: '', status: 'loading' } })
    let commitPatch = entry.diff
    if (!commitPatch) {
      try {
        commitPatch = (await commitAiBridge()?.commitDiff(root, entry.sha)) ?? '(diff unavailable)'
      } catch {
        commitPatch = '(diff unavailable: output exceeded the history limit)'
      }
    }
    if (generation !== summaryGeneration || get().root !== root) return
    const result = await requestReport(
      'commit',
      [`Commit: ${entry.sha}`, `Author: ${entry.author}`, `Date: ${entry.date}`, `Message: ${entry.subject}`, '', 'Diff:', commitPatch || '(no textual diff)'].join('\n'),
      root
    )
    if (generation === summaryGeneration && get().root === root) set({ summary: { ...result, title } })
  },
  summarizeFile: async (root, path) => {
    if (get().root !== root) return
    const historyBridge = commitAiBridge()
    const generation = ++summaryGeneration
    const title = `File ${path}`
    set({ selectedCommitSha: null, summary: { title, text: '', status: 'loading' } })
    if (!historyBridge) {
      if (generation === summaryGeneration) set({ summary: { title, text: 'Commit history is unavailable in this build.', status: 'error' } })
      return
    }
    try {
      const [history, requestedDiff] = await Promise.all([
        historyBridge.fileHistory(root, path),
        bridge().fileDiff(root, path).catch(() => null)
      ])
      if (generation !== summaryGeneration || get().root !== root) return
      const selectedDiff = requestedDiff?.path === path ? requestedDiff : null
      const result = await requestReport(
        'file',
        [
          `File: ${history.path}`,
          `Branch: ${history.branch ?? '(detached HEAD)'}`,
          `Added in commit: ${history.firstSeenCommit ?? '(not committed yet)'}`,
          `Added date: ${history.firstSeenDate ?? '(not committed yet)'}`,
          `Added by change: ${history.firstSeenSubject ?? '(not committed yet)'}`,
          '',
          'File log:',
          formatLog(history.commits),
          '',
          'Current staged/unstaged change (binary patches are included when available):',
          selectedDiff ? [selectedDiff.staged, selectedDiff.unstaged].filter(Boolean).join('\n') || '(no diff)' : '(no diff)'
        ].join('\n'),
        root
      )
      if (generation === summaryGeneration && get().root === root) set({ summary: { ...result, title } })
    } catch (error) {
      if (generation === summaryGeneration && get().root === root) set({ summary: { title, text: errorMessage(error), status: 'error' } })
    }
  },
  summarizeBranch: async (root) => {
    if (get().root !== root) return
    const historyBridge = commitAiBridge()
    const generation = ++summaryGeneration
    const pendingTitle = 'Branch summary'
    set({ selectedCommitSha: null, summary: { title: pendingTitle, text: '', status: 'loading' } })
    if (!historyBridge) {
      if (generation === summaryGeneration) set({ summary: { title: pendingTitle, text: 'Branch history is unavailable in this build.', status: 'error' } })
      return
    }
    try {
      const branch = await historyBridge.branchDiffVsBase(root)
      if (generation !== summaryGeneration || get().root !== root) return
      const title = `Branch ${branch.branch ?? '(detached HEAD)'}`
      const result = await requestReport(
        'branch',
        [
          `Branch: ${branch.branch ?? '(detached HEAD)'}`,
          `Base branch: ${branch.baseBranch ?? '(base not found)'}`,
          '',
          'Branch commits:',
          formatLog(branch.commits),
          '',
          'Diff vs base:',
          branch.diff || '(no diff vs base)'
        ].join('\n'),
        root
      )
      if (generation === summaryGeneration && get().root === root) set({ summary: { ...result, title } })
    } catch (error) {
      if (generation === summaryGeneration && get().root === root) set({ summary: { title: pendingTitle, text: errorMessage(error), status: 'error' } })
    }
  }
}))
