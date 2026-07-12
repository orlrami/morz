/*
 * Space store (Slice 4). A space = project root + per-agent worktrees; each
 * agent works on its REAL branch/worktree (owner workflow: builders on
 * branches → merge to main). Git state comes from main via GitApi and is keyed
 * by the root path we asked about.
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

/**
 * The preload bridge, or undefined until Agent 1's full preload lands
 * (env.d.ts still types the stub). Callers must handle undefined.
 */
export function getMorz(): MorzApi | undefined {
  const m = (window as unknown as { morz?: Partial<MorzApi> }).morz
  return m && typeof m.git?.status === 'function' ? (m as MorzApi) : undefined
}

/* Dogfood seed: the Morz repo itself with its parallel agent worktrees. */
const seedSpaces: Space[] = [
  {
    id: 'morz',
    name: 'morz',
    root: 'C:\\Projects\\morz',
    agents: [
      { id: 'backend', name: 'backend', cli: 'claude', root: 'C:\\Projects\\morz-backend' },
      { id: 'terminal', name: 'terminal', cli: 'claude', root: 'C:\\Projects\\morz-terminal' },
      { id: 'spaces', name: 'spaces', cli: 'claude', root: 'C:\\Projects\\morz-spaces' }
    ]
  }
]

interface SpaceState {
  spaces: Space[]
  gitByRoot: Record<string, GitStatus>
  addSpace(space: Space): void
  removeSpace(id: string): void
  setGit(root: string, status: GitStatus): void
  /** Idempotent: subscribe to git:changed once, watch + fetch every root. */
  startWatching(): void
}

let changedSubscribed = false
const watchedRoots = new Set<string>()

export const useSpaceStore = create<SpaceState>()(
  persist(
    (set, get) => ({
      spaces: seedSpaces,
      gitByRoot: {},
      addSpace: (space) => set((s) => ({ spaces: [...s.spaces, space] })),
      removeSpace: (id) => set((s) => ({ spaces: s.spaces.filter((sp) => sp.id !== id) })),
      setGit: (root, status) => set((s) => ({ gitByRoot: { ...s.gitByRoot, [root]: status } })),
      startWatching: () => {
        const morz = getMorz()
        if (!morz) return
        if (!changedSubscribed) {
          changedSubscribed = true
          morz.git.onChanged((status) => get().setGit(status.cwd, status))
        }
        for (const space of get().spaces) {
          for (const root of [space.root, ...space.agents.map((a) => a.root)]) {
            if (watchedRoots.has(root)) continue
            watchedRoots.add(root)
            morz.git.watch(root)
            void morz.git.status(root).then((st) => get().setGit(root, st))
          }
        }
      }
    }),
    {
      name: 'morz.spaces',
      version: 1,
      partialize: (s) => ({ spaces: s.spaces })
    }
  )
)
