import { create } from 'zustand'
import type { CommitBridge, CommitFileDiff, CommitLogEntry, GitFile } from '@shared/ipc'

interface CommitState {
  root: string
  files: GitFile[]
  selectedPath: string | null
  diff: CommitFileDiff | null
  log: CommitLogEntry[]
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
  createCommit(root: string): Promise<void>
  suggestMessage(root: string): Promise<void>
}

function bridge(): CommitBridge {
  const api = (window as unknown as { morzCommit?: CommitBridge }).morzCommit
  if (!api) throw new Error('Commit bridge is unavailable')
  return api
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

let refreshGeneration = 0

export const useCommitStore = create<CommitState>((set, get) => ({
  root: '',
  files: [],
  selectedPath: null,
  diff: null,
  log: [],
  message: '',
  loading: false,
  busy: null,
  error: null,
  setMessage: (message) => set({ message }),
  refresh: async (root) => {
    const generation = ++refreshGeneration
    if (!root) {
      set({ root, files: [], selectedPath: null, diff: null, log: [], loading: false })
      return
    }
    set({ loading: true, error: null })
    try {
      const [status, log] = await Promise.all([window.morz.git.status(root), bridge().log(root)])
      if (generation !== refreshGeneration) return
      const previous = get().root === root ? get().selectedPath : null
      const selectedPath =
        previous && status.files.some((file) => file.path === previous)
          ? previous
          : (status.files[0]?.path ?? null)
      set({ root, files: status.files, log, selectedPath, loading: false })
      if (selectedPath) await get().selectFile(root, selectedPath)
      else set({ diff: null })
    } catch (error) {
      if (generation === refreshGeneration) set({ loading: false, error: errorMessage(error) })
    }
  },
  selectFile: async (root, path) => {
    set({ selectedPath: path, error: null })
    try {
      const diff = await bridge().fileDiff(root, path)
      if (get().root === root && get().selectedPath === path) set({ diff })
    } catch (error) {
      set({ error: errorMessage(error) })
    }
  },
  stageFile: async (root, path) => {
    set({ busy: `stage:${path}`, error: null })
    try {
      await bridge().stageFile(root, path)
      await get().refresh(root)
    } catch (error) {
      set({ error: errorMessage(error) })
    } finally {
      set({ busy: null })
    }
  },
  unstageFile: async (root, path) => {
    set({ busy: `unstage:${path}`, error: null })
    try {
      await bridge().unstageFile(root, path)
      await get().refresh(root)
    } catch (error) {
      set({ error: errorMessage(error) })
    } finally {
      set({ busy: null })
    }
  },
  stageHunk: async (root, patch) => {
    set({ busy: 'stage-hunk', error: null })
    try {
      await bridge().stageHunk(root, patch)
      await get().refresh(root)
    } catch (error) {
      set({ error: errorMessage(error) })
    } finally {
      set({ busy: null })
    }
  },
  discardFile: async (root, path, confirmed) => {
    set({ busy: `discard:${path}`, error: null })
    try {
      await bridge().discardFile(root, path, confirmed)
      await get().refresh(root)
    } catch (error) {
      set({ error: errorMessage(error) })
    } finally {
      set({ busy: null })
    }
  },
  createCommit: async (root) => {
    set({ busy: 'commit', error: null })
    try {
      await bridge().commit(root, get().message)
      set({ message: '' })
      await get().refresh(root)
    } catch (error) {
      set({ error: errorMessage(error) })
    } finally {
      set({ busy: null })
    }
  },
  suggestMessage: async (root) => {
    set({ busy: 'suggest', error: null })
    try {
      const message = await bridge().suggestMessage(root)
      set({ message })
    } catch (error) {
      set({ error: errorMessage(error) })
    } finally {
      set({ busy: null })
    }
  }
}))
