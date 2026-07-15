/*
 * Real project spaces. The persisted document contains only user-owned space
 * metadata and the active id; availability and git status are live runtime
 * state. Missing space roots stay visible/removable, while missing agent
 * worktrees are pruned during boot migration.
 */
import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { GitStatus, MorzApi } from '@shared/ipc'

export type SpaceCli = 'claude' | 'codex' | 'agy' | 'opencode'

export interface SpaceAgent {
  id: string
  name: string
  cli: SpaceCli
  /** Worktree root this agent lives in — its branch comes from git, live. */
  root: string
}

export interface Space {
  id: string
  name: string
  root: string
  agents: SpaceAgent[]
}

export interface SpaceState {
  spaces: Space[]
  activeSpaceId: string | null
  /** Roots known to be missing or unreadable in this boot. */
  unavailableRoots: Record<string, true>
  gitByRoot: Record<string, GitStatus>
  /** True after persisted state, first-boot seeding, and root validation finish. */
  ready: boolean
  /** Persisted so removing every space does not re-seed on the next boot. */
  initialized: boolean
  initialize(): Promise<void>
  addSpace(root: string): Space | null
  removeSpace(id: string): void
  renameSpace(id: string, name: string): void
  setActiveSpace(id: string): void
  setGit(root: string, status: GitStatus): void
  /** Idempotent: subscribe to git:changed once, then watch every available root. */
  startWatching(): void
}

const FIRST_BOOT_ROOT = 'C:\\Projects\\morz'

/** The preload bridge is undefined in renderer-only development. */
export function getMorz(): MorzApi | undefined {
  const m = (window as unknown as { morz?: Partial<MorzApi> }).morz
  return m && typeof m.git?.status === 'function' ? (m as MorzApi) : undefined
}

function cleanRoot(root: string): string {
  const trimmed = root.trim()
  if (/^[A-Za-z]:[\\/]$/.test(trimmed)) return trimmed.replace('/', '\\')
  return trimmed.replace(/[\\/]+$/, '')
}

function rootKey(root: string): string {
  return cleanRoot(root).replace(/\\/g, '/').toLowerCase()
}

function rootName(root: string): string {
  const clean = cleanRoot(root)
  return clean.split(/[\\/]/).filter(Boolean).at(-1) ?? clean
}

function slug(value: string): string {
  return (
    value
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLocaleLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'space'
  )
}

function uniqueId(name: string, spaces: Space[]): string {
  const base = slug(name)
  const used = new Set(spaces.map((space) => space.id))
  if (!used.has(base)) return base
  let suffix = 2
  while (used.has(`${base}-${suffix}`)) suffix += 1
  return `${base}-${suffix}`
}

async function rootExists(root: string): Promise<boolean> {
  const morz = getMorz()
  if (!morz) return false
  try {
    await morz.fs.list(root)
    return true
  } catch {
    return false
  }
}

export function selectActiveSpace(state: Pick<SpaceState, 'spaces' | 'activeSpaceId'>): Space | undefined {
  return state.spaces.find((space) => space.id === state.activeSpaceId)
}

export function selectActiveSpaceRoot(
  state: Pick<SpaceState, 'spaces' | 'activeSpaceId' | 'unavailableRoots'>
): string {
  const space = selectActiveSpace(state)
  return space && !state.unavailableRoots[space.root] ? space.root : ''
}

interface PersistedSpaceState {
  spaces?: Space[]
  activeSpaceId?: string | null
  initialized?: boolean
}

/** Upgrade the old hardcoded-seed document without discarding user spaces. */
export function migrateSpaceState(persisted: unknown): PersistedSpaceState {
  const old = (persisted ?? {}) as PersistedSpaceState
  const spaces = Array.isArray(old.spaces) ? old.spaces : []
  const activeSpaceId = spaces.some((space) => space.id === old.activeSpaceId)
    ? (old.activeSpaceId ?? null)
    : (spaces[0]?.id ?? null)
  return { spaces, activeSpaceId, initialized: true }
}

let changedSubscribed = false
let initializing = false
const watchedRoots = new Set<string>()

export const useSpaceStore = create<SpaceState>()(
  persist(
    (set, get) => ({
      spaces: [],
      activeSpaceId: null,
      unavailableRoots: {},
      gitByRoot: {},
      ready: false,
      initialized: false,
      initialize: async () => {
        if (get().ready || initializing) return
        initializing = true
        try {
          let spaces = get().spaces
          let initialized = get().initialized

          if (!initialized) {
            const exists = await rootExists(FIRST_BOOT_ROOT)
            spaces = exists
              ? [{ id: 'morz', name: 'morz', root: FIRST_BOOT_ROOT, agents: [] }]
              : []
            initialized = true
          }

          const roots = [...new Set(spaces.flatMap((space) => [space.root, ...space.agents.map((agent) => agent.root)]))]
          const availability = new Map(
            await Promise.all(roots.map(async (root) => [root, await rootExists(root)] as const))
          )
          const unavailableRoots: Record<string, true> = {}
          for (const space of spaces) {
            if (!availability.get(space.root)) unavailableRoots[space.root] = true
          }
          spaces = spaces.map((space) => ({
            ...space,
            agents: space.agents.filter((agent) => availability.get(agent.root))
          }))

          const requestedActive = get().activeSpaceId
          const activeSpaceId =
            spaces.find((space) => space.id === requestedActive && !unavailableRoots[space.root])?.id ??
            spaces.find((space) => !unavailableRoots[space.root])?.id ??
            null

          set({ spaces, initialized, unavailableRoots, activeSpaceId, ready: true })
          get().startWatching()
        } finally {
          initializing = false
        }
      },
      addSpace: (rawRoot) => {
        const root = cleanRoot(rawRoot)
        if (!root) return null
        const existing = get().spaces.find((space) => rootKey(space.root) === rootKey(root))
        if (existing) {
          set((state) => {
            const unavailableRoots = { ...state.unavailableRoots }
            delete unavailableRoots[existing.root]
            return { activeSpaceId: existing.id, unavailableRoots }
          })
          queueMicrotask(() => get().startWatching())
          return existing
        }
        const name = rootName(root)
        const space: Space = {
          id: uniqueId(name, get().spaces),
          name,
          root,
          agents: []
        }
        set((state) => {
          const unavailableRoots = { ...state.unavailableRoots }
          delete unavailableRoots[root]
          return {
            spaces: [...state.spaces, space],
            activeSpaceId: space.id,
            unavailableRoots,
            initialized: true
          }
        })
        queueMicrotask(() => get().startWatching())
        return space
      },
      removeSpace: (id) =>
        set((state) => {
          const removed = state.spaces.find((space) => space.id === id)
          if (!removed) return state
          const spaces = state.spaces.filter((space) => space.id !== id)
          const unavailableRoots = { ...state.unavailableRoots }
          delete unavailableRoots[removed.root]
          const activeSpaceId =
            state.activeSpaceId === id
              ? (spaces.find((space) => !unavailableRoots[space.root])?.id ?? null)
              : state.activeSpaceId
          return { spaces, unavailableRoots, activeSpaceId, initialized: true }
        }),
      renameSpace: (id, rawName) => {
        const name = rawName.trim()
        if (!name) return
        set((state) => ({
          spaces: state.spaces.map((space) => (space.id === id ? { ...space, name } : space))
        }))
      },
      setActiveSpace: (id) =>
        set((state) => {
          const space = state.spaces.find((candidate) => candidate.id === id)
          if (!space || state.unavailableRoots[space.root]) return state
          return { activeSpaceId: id }
        }),
      setGit: (root, status) =>
        set((state) => ({ gitByRoot: { ...state.gitByRoot, [root]: status } })),
      startWatching: () => {
        const morz = getMorz()
        if (!morz) return
        if (!changedSubscribed) {
          changedSubscribed = true
          morz.git.onChanged((status) => get().setGit(status.cwd, status))
        }
        for (const space of get().spaces) {
          for (const root of [space.root, ...space.agents.map((agent) => agent.root)]) {
            if (get().unavailableRoots[root] || watchedRoots.has(root)) continue
            watchedRoots.add(root)
            morz.git.watch(root)
            void morz.git.status(root).then((status) => get().setGit(root, status))
          }
        }
      }
    }),
    {
      name: 'morz.spaces',
      version: 2,
      migrate: (persisted) => migrateSpaceState(persisted),
      partialize: (state) => ({
        spaces: state.spaces,
        activeSpaceId: state.activeSpaceId,
        initialized: state.initialized
      }),
      onRehydrateStorage: () => () => {
        queueMicrotask(() => void useSpaceStore.getState().initialize())
      }
    }
  )
)
