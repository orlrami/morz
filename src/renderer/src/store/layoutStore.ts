/*
 * Layout store (Slice 2) — the pane list behind the terminals grid.
 * Persistence goes through window.morz.session (SQLite in main), NOT zustand
 * persist: Shell hydrates from session.load() at startup and saves a debounced
 * snapshot on change. 0.0.1 renders panes as one row; split `dir` is accepted
 * for the app-events contract but both directions insert a right sibling.
 */
import { create } from 'zustand'

export type PaneKind = 'terminal' | 'claude'

export interface PaneDef {
  paneId: string
  kind: PaneKind
  /** '' = PTY-host default. */
  cwd: string
  /** '' = user's default shell; unused for claude panes. */
  shell: string
  /** Claude panes only — the lane's adapter agentId. */
  agentId?: string
}

export function newPaneId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID().slice(0, 8)}`
}

const DEFAULT_PANES: PaneDef[] = [
  { paneId: 'term-1', kind: 'terminal', cwd: '', shell: '' },
  { paneId: 'term-2', kind: 'terminal', cwd: '', shell: '' }
]

interface LayoutState {
  panes: PaneDef[]
  /** False until the session snapshot has been loaded — don't render/spawn before. */
  hydrated: boolean
  hydrate(panes: PaneDef[] | null): void
  addPane(pane: PaneDef): void
  removePane(paneId: string): void
  splitPane(paneId: string, dir: 'right' | 'down'): void
}

export const useLayoutStore = create<LayoutState>()((set) => ({
  panes: [],
  hydrated: false,
  hydrate: (panes) =>
    set({ panes: panes && panes.length > 0 ? panes : DEFAULT_PANES, hydrated: true }),
  addPane: (pane) => set((s) => ({ panes: [...s.panes, pane] })),
  removePane: (paneId) => set((s) => ({ panes: s.panes.filter((p) => p.paneId !== paneId) })),
  splitPane: (paneId, _dir) =>
    set((s) => {
      const i = s.panes.findIndex((p) => p.paneId === paneId)
      if (i === -1) return s
      const src = s.panes[i]
      const sibling: PaneDef = {
        paneId: newPaneId('term'),
        kind: 'terminal',
        cwd: src.cwd,
        shell: src.kind === 'terminal' ? src.shell : ''
      }
      const panes = [...s.panes]
      panes.splice(i + 1, 0, sibling)
      return { panes }
    })
}))
