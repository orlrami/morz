/*
 * Layout store (Slice 1+2) — the split tree behind the terminals grid.
 * Persistence goes through window.morz.session (SQLite in main), NOT zustand
 * persist: Shell hydrates from session.load() at startup and saves a debounced
 * snapshot on change. The tree is binary: every split has exactly two children
 * and a ratio (first child's share). `panes` is the derived doc-order flat
 * list — kept in sync with `root` so consumers keep their old lookups.
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
  /** Direct executable arguments for CLI panes. */
  argv?: string[]
  /** Marks panes created by the launcher (used by the isolated E2E spawn seam). */
  startScreenLaunch?: boolean
  /** False only while no user keystroke has reached this pane. */
  touched?: boolean
  /** Claude panes only — the lane's adapter agentId. */
  agentId?: string
}

export interface LeafNode {
  type: 'leaf'
  pane: PaneDef
}

export interface SplitNode {
  type: 'split'
  id: string
  /** 'row' = side-by-side (split right); 'col' = stacked (split down). */
  dir: 'row' | 'col'
  /** First child's share of the axis, clamped to RATIO_MIN..RATIO_MAX. */
  ratio: number
  a: LayoutNode
  b: LayoutNode
}

export type LayoutNode = LeafNode | SplitNode

export const RATIO_MIN = 0.15
export const RATIO_MAX = 0.85

export function clampRatio(r: number): number {
  return Math.min(RATIO_MAX, Math.max(RATIO_MIN, r))
}

export function newPaneId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID().slice(0, 8)}`
}

/** Doc-order flat pane list of a (sub)tree. */
export function panesOf(node: LayoutNode | null): PaneDef[] {
  if (!node) return []
  if (node.type === 'leaf') return [node.pane]
  return [...panesOf(node.a), ...panesOf(node.b)]
}

/** Flat pane list → one row of equal columns (legacy snapshots, defaults). */
export function rowOf(panes: PaneDef[]): LayoutNode | null {
  if (panes.length === 0) return null
  if (panes.length === 1) return { type: 'leaf', pane: panes[0] }
  return {
    type: 'split',
    id: newPaneId('split'),
    dir: 'row',
    ratio: clampRatio(1 / panes.length),
    a: { type: 'leaf', pane: panes[0] },
    b: rowOf(panes.slice(1))!
  }
}

/** Remove a leaf; its sibling takes the parent split's slot. Identity-stable when absent. */
export function removePaneFromTree(node: LayoutNode | null, paneId: string): LayoutNode | null {
  if (!node) return null
  if (node.type === 'leaf') return node.pane.paneId === paneId ? null : node
  const a = removePaneFromTree(node.a, paneId)
  const b = removePaneFromTree(node.b, paneId)
  if (a === node.a && b === node.b) return node
  if (!a) return b
  if (!b) return a
  return { ...node, a, b }
}

function splitLeafInTree(
  node: LayoutNode,
  paneId: string,
  dir: 'right' | 'down',
  sibling: PaneDef
): LayoutNode {
  if (node.type === 'leaf') {
    if (node.pane.paneId !== paneId) return node
    return {
      type: 'split',
      id: newPaneId('split'),
      dir: dir === 'right' ? 'row' : 'col',
      ratio: 0.5,
      a: node,
      b: { type: 'leaf', pane: sibling }
    }
  }
  const a = splitLeafInTree(node.a, paneId, dir, sibling)
  const b = splitLeafInTree(node.b, paneId, dir, sibling)
  if (a === node.a && b === node.b) return node
  return { ...node, a, b }
}

function setRatioInTree(node: LayoutNode, splitId: string, ratio: number): LayoutNode {
  if (node.type === 'leaf') return node
  if (node.id === splitId) return node.ratio === ratio ? node : { ...node, ratio }
  const a = setRatioInTree(node.a, splitId, ratio)
  const b = setRatioInTree(node.b, splitId, ratio)
  if (a === node.a && b === node.b) return node
  return { ...node, a, b }
}

function updatePaneInTree(node: LayoutNode, paneId: string, pane: PaneDef): LayoutNode {
  if (node.type === 'leaf') {
    return node.pane.paneId === paneId ? { ...node, pane } : node
  }
  const a = updatePaneInTree(node.a, paneId, pane)
  const b = updatePaneInTree(node.b, paneId, pane)
  if (a === node.a && b === node.b) return node
  return { ...node, a, b }
}

const DEFAULT_PANES: PaneDef[] = [
  { paneId: 'term-1', kind: 'terminal', cwd: '', shell: '', touched: false },
  { paneId: 'term-2', kind: 'terminal', cwd: '', shell: '', touched: false }
]

interface LayoutState {
  root: LayoutNode | null
  /** Derived doc-order flat list — always in sync with root. */
  panes: PaneDef[]
  activePaneId: string
  /** False until the session snapshot has been loaded — don't render/spawn before. */
  hydrated: boolean
  hydrate(root: LayoutNode | null, defaultCwd?: string): void
  /** Append as a right sibling of the whole tree (Claude lane slot). */
  addPane(pane: PaneDef): void
  removePane(paneId: string): void
  splitPane(paneId: string, dir: 'right' | 'down', cwd?: string): void
  setPaneCwd(paneId: string, cwd: string): void
  touchPane(paneId: string): void
  setRatio(splitId: string, ratio: number): void
  setActivePane(paneId: string): void
}

export const useLayoutStore = create<LayoutState>()((set) => ({
  root: null,
  panes: [],
  activePaneId: '',
  hydrated: false,
  hydrate: (root, defaultCwd = '') =>
    set(() => {
      const r = root ?? rowOf(DEFAULT_PANES.map((pane) => ({ ...pane, cwd: defaultCwd })))
      const panes = panesOf(r)
      return { root: r, panes, activePaneId: panes[0]?.paneId ?? '', hydrated: true }
    }),
  addPane: (pane) =>
    set((s) => {
      const added = { ...pane, touched: pane.touched ?? false }
      const leaf: LayoutNode = { type: 'leaf', pane: added }
      const root: LayoutNode = s.root
        ? { type: 'split', id: newPaneId('split'), dir: 'row', ratio: 0.5, a: s.root, b: leaf }
        : leaf
      return { root, panes: panesOf(root), activePaneId: added.paneId }
    }),
  removePane: (paneId) =>
    set((s) => {
      const root = removePaneFromTree(s.root, paneId)
      if (root === s.root) return s
      const panes = panesOf(root)
      return {
        root,
        panes,
        activePaneId: s.activePaneId === paneId ? (panes[0]?.paneId ?? '') : s.activePaneId
      }
    }),
  splitPane: (paneId, dir, cwd) =>
    set((s) => {
      if (!s.root) return s
      const src = s.panes.find((p) => p.paneId === paneId)
      if (!src) return s
      const sibling: PaneDef = {
        paneId: newPaneId('term'),
        kind: 'terminal',
        cwd: cwd ?? src.cwd,
        shell: src.kind === 'terminal' ? src.shell : '',
        argv: undefined,
        startScreenLaunch: false,
        touched: false
      }
      const root = splitLeafInTree(s.root, paneId, dir, sibling)
      if (root === s.root) return s
      return { root, panes: panesOf(root), activePaneId: sibling.paneId }
    }),
  setPaneCwd: (paneId, cwd) =>
    set((s) => {
      if (!s.root) return s
      const current = s.panes.find((pane) => pane.paneId === paneId)
      if (!current || current.cwd === cwd) return s
      const root = updatePaneInTree(s.root, paneId, { ...current, cwd })
      return { root, panes: panesOf(root) }
    }),
  touchPane: (paneId) =>
    set((s) => {
      if (!s.root) return s
      const current = s.panes.find((pane) => pane.paneId === paneId)
      if (!current || current.touched === true) return s
      const root = updatePaneInTree(s.root, paneId, { ...current, touched: true })
      return { root, panes: panesOf(root) }
    }),
  setRatio: (splitId, ratio) =>
    set((s) => {
      if (!s.root) return s
      const root = setRatioInTree(s.root, splitId, clampRatio(ratio))
      return root === s.root ? s : { root }
    }),
  setActivePane: (paneId) =>
    set((s) => (s.activePaneId === paneId ? s : { activePaneId: paneId }))
}))
