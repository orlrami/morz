import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { motion } from 'framer-motion'
import {
  IconTerminal2,
  IconGitCommit,
  IconShieldCheck,
  IconTopologyStar3,
  IconFolders,
  IconWorld,
  IconDeviceMobile,
  IconSettings,
  IconSquareRoundedPlus,
  IconRobot,
  IconColumns,
  IconX,
  IconHistory
} from '@tabler/icons-react'
import { TitleBar } from './TitleBar'
import { MorzSignal } from './Brand'
import { SpacesSidebar } from './SpacesSidebar'
import { AgentPillBar } from './AgentPillBar'
import { OrchestratorPanel } from './OrchestratorPanel'
import { StatusBar } from './StatusBar'
import { CommandPalette, type PaletteAction } from './CommandPalette'
import { FileExplorer } from './FileExplorer'
import { CommitPanel } from './CommitPanel'
import { ReviewerPanel } from './ReviewerPanel'
import { DagView } from './DagView'
import { BrowserPanel } from './BrowserPanel'
import { RemotePanel } from './RemotePanel'
import { SettingsPanel, type SettingsTab } from './SettingsPanel'
import { WorkshopPanel } from './WorkshopPanel'
import { SessionsPanel } from './SessionsPanel'
// w6/organizer-ui
import { OrganizerPanel } from './OrganizerPanel'
import { ToastHost } from './Toast'
import { IdePane } from './IdePane'
import { ClaudeLane } from './ClaudeLane'
import { useTerminalContextMenu } from './TerminalPane'
import { serializeTerminal, useTerminal } from '@/hooks/useTerminal'
import { emit, off, on } from '@/lib/app-events'
import { colors } from '@/lib/tokens'
import { springs } from '@/lib/springs'
import { themes, useThemeStore } from '@/lib/themes'
import { useCatalogStore } from '@/store/catalogStore'
import { claudeAllowed, useModeStore } from '@/store/modeStore'
import { useLaneStore } from '@/store/laneStore'
import { getRunApi, hydrateRuns } from '@/store/runsStore'
import {
  clampRatio,
  newPaneId,
  panesOf,
  removePaneFromTree,
  rowOf,
  useLayoutStore,
  type LayoutNode,
  type PaneDef,
  type SplitNode
} from '@/store/layoutStore'
import { getMorz, selectActiveSpaceRoot, useSpaceStore } from '@/store/spaceStore'
import { useSessionsStore } from '@/store/sessionsStore'
import type { SessionSnapshot } from '@shared/ipc'

type CenterView = 'terminals' | 'commit' | 'review' | 'dag' | 'browser' | 'remote' | 'organizer' | 'sessions' | 'settings' | 'workshop'

const VIEWS: { id: CenterView; label: string; icon: typeof IconTerminal2 }[] = [
  { id: 'terminals', label: 'Terminals', icon: IconTerminal2 },
  { id: 'commit', label: 'Commit', icon: IconGitCommit },
  { id: 'review', label: 'Review', icon: IconShieldCheck },
  { id: 'dag', label: 'Waves', icon: IconTopologyStar3 },
  { id: 'browser', label: 'Browser', icon: IconWorld },
  { id: 'remote', label: 'Remote', icon: IconDeviceMobile },
  { id: 'organizer', label: 'Organizer', icon: IconFolders },
  // w11/sessions — one center-view entry; SpacesSidebar remains untouched.
  { id: 'sessions', label: 'Sessions', icon: IconHistory }
]

/* Dev-only: allow ?view=commit&explorer=1 so surfaces can be screenshot-verified. */
function initialFromUrl(): { view: CenterView; explorer: boolean } {
  const params = new URLSearchParams(window.location.search)
  const view = params.get('view') as CenterView | null
  return {
    view: view && VIEWS.some((v) => v.id === view) ? view : 'terminals',
    explorer: params.get('explorer') === '1'
  }
}

function sameRoot(left: string, right: string): boolean {
  const key = (value: string): string => value.replace(/[\\/]+$/, '').replace(/\\/g, '/').toLowerCase()
  return !!left && !!right && key(left) === key(right)
}

/* ── session snapshot (Slice 2) ──────────────────────────────── */

function buildSnapshot(root: LayoutNode | null, panes: PaneDef[]): SessionSnapshot {
  return {
    // `panes` rides along so pre-tree builds (and the parse fallback) still hydrate.
    layout: { tree: root, panes },
    panes: panes
      .filter((p) => p.kind === 'terminal')
      .map((p) => ({
        paneId: p.paneId,
        cwd: p.cwd,
        shell: p.shell,
        scrollback: serializeTerminal(p.paneId) ?? ''
      }))
  }
}

function parsePane(v: unknown): PaneDef | null {
  const p = v as Partial<PaneDef> | null | undefined
  if (!p || typeof p.paneId !== 'string') return null
  if (p.kind !== 'terminal' && p.kind !== 'claude') return null
  return { paneId: p.paneId, kind: p.kind, cwd: p.cwd ?? '', shell: p.shell ?? '', agentId: p.agentId }
}

/** Recovering parse: a corrupt child collapses to its sibling, never the whole tree. */
function parseNode(v: unknown): LayoutNode | null {
  const n = v as { type?: unknown } | null | undefined
  if (!n || typeof n !== 'object') return null
  if (n.type === 'leaf') {
    const pane = parsePane((n as { pane?: unknown }).pane)
    return pane ? { type: 'leaf', pane } : null
  }
  if (n.type === 'split') {
    const s = n as Partial<SplitNode>
    const a = parseNode(s.a)
    const b = parseNode(s.b)
    if (!a) return b
    if (!b) return a
    return {
      type: 'split',
      id: typeof s.id === 'string' ? s.id : newPaneId('split'),
      dir: s.dir === 'col' ? 'col' : 'row',
      ratio: clampRatio(typeof s.ratio === 'number' ? s.ratio : 0.5),
      a,
      b
    }
  }
  return null
}

/** layout is opaque in the contract — try tree, then flat layout.panes, then snap.panes. */
function layoutFromSnapshot(snap: SessionSnapshot | null): LayoutNode | null {
  if (!snap) return null
  const layout = snap.layout as { tree?: unknown; panes?: unknown } | null | undefined
  if (layout?.tree) {
    const tree = parseNode(layout.tree)
    if (tree) return tree
  }
  if (layout && Array.isArray(layout.panes)) {
    const parsed = layout.panes.map(parsePane).filter((p): p is PaneDef => p !== null)
    if (parsed.length > 0) return rowOf(parsed)
  }
  if (Array.isArray(snap.panes) && snap.panes.length > 0) {
    return rowOf(
      snap.panes.map((p) => ({
        paneId: p.paneId,
        kind: 'terminal' as const,
        cwd: p.cwd,
        shell: p.shell
      }))
    )
  }
  return null
}

/* Morz shell: titlebar / (sidebar | pill-bar + center view | orchestrator) / statusbar. */
export function Shell(): JSX.Element {
  const initial = initialFromUrl()
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [explorerOpen, setExplorerOpen] = useState(initial.explorer)
  const [orchestratorOpen, setOrchestratorOpen] = useState(true) // w10/identity
  const [view, setView] = useState<CenterView>(initial.view)
  const [settingsTab, setSettingsTab] = useState<SettingsTab>('limits')
  const [settingsRevision, setSettingsRevision] = useState(0)

  const mode = useModeStore((s) => s.mode)
  const root = useLayoutStore((s) => s.root)
  const hydrated = useLayoutStore((s) => s.hydrated)
  const panes = useLayoutStore((s) => s.panes)
  const activePaneId = useLayoutStore((s) => s.activePaneId)
  const lanes = useLaneStore((s) => s.lanes)
  const spacesReady = useSpaceStore((state) => state.ready)
  const spaceRoot = useSpaceStore(selectActiveSpaceRoot)
  const activeSpace = useSpaceStore((state) =>
    state.spaces.find((space) => space.id === state.activeSpaceId)
  )
  const spaceBranch = useSpaceStore((state) =>
    spaceRoot ? state.gitByRoot[spaceRoot]?.branch ?? null : null
  )
  const activeLanes = lanes.filter((lane) => sameRoot(lane.cwd, spaceRoot))
  const sessionAgents = useMemo(
    () => [
      ...new Set([
        ...(activeSpace?.agents.map((agent) => agent.cli) ?? []),
        ...(activeLanes.length > 0 ? ['claude'] : [])
      ])
    ],
    [activeLanes.length, activeSpace?.agents]
  )
  const sessionAgentsKey = sessionAgents.join('|')

  /* w11/sessions — a space with an open pane owns exactly one live work record. */
  useEffect(() => {
    const store = useSessionsStore.getState()
    if (!spacesReady || !spaceRoot) {
      if (spacesReady) void store.endCurrent()
      return
    }
    if (!hydrated || panes.length === 0) return
    void store.activate({
      spaceRoot,
      title: spaceBranch || activeSpace?.name || 'Project session',
      agentsUsed: sessionAgents
    })
  }, [activeSpace?.name, hydrated, panes.length, sessionAgentsKey, spaceBranch, spaceRoot, spacesReady])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setPaletteOpen((v) => !v)
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'b') {
        e.preventDefault()
        setExplorerOpen((v) => !v)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  /* Session restore: load once, recreate panes; terminals reattach and the
   * PTY-host replays scrollback. Lane panes only survive outside Manual. */
  useEffect(() => {
    if (!spacesReady) return
    if (useLayoutStore.getState().hydrated) return
    const finish = (loaded: LayoutNode | null): void => {
      if (useLayoutStore.getState().hydrated) return
      const currentMode = useModeStore.getState().mode
      let usable = loaded
      if (currentMode === 'manual' && usable) {
        for (const p of panesOf(usable)) {
          if (p.kind === 'claude') usable = removePaneFromTree(usable, p.paneId)
        }
      }
      useLayoutStore.getState().hydrate(usable, spaceRoot)
      if (currentMode !== 'manual' && usable) {
        for (const p of panesOf(usable)) {
          if (p.kind === 'claude' && p.agentId) {
            useLaneStore.getState().addLane({ paneId: p.paneId, agentId: p.agentId, cwd: p.cwd })
          }
        }
      }
    }
    const sess = getMorz()?.session
    if (!sess) {
      finish(null)
      return
    }
    sess
      .load()
      .then((snap) => finish(layoutFromSnapshot(snap)))
      .catch(() => finish(null))
  }, [spaceRoot, spacesReady])

  /* Session save: debounced on pane-list change, 30s idle tick for scrollback
   * drift (never per chunk), and on window unload. */
  useEffect(() => {
    const sess = getMorz()?.session
    if (!sess) return
    let timer: number | undefined
    const save = (): void => {
      const { root: tree, panes: current, hydrated: ready } = useLayoutStore.getState()
      if (ready) sess.save(buildSnapshot(tree, current))
    }
    const unsub = useLayoutStore.subscribe((s, prev) => {
      if (!s.hydrated || s.root === prev.root) return
      window.clearTimeout(timer)
      timer = window.setTimeout(save, 1000)
    })
    const idle = window.setInterval(save, 30_000)
    window.addEventListener('beforeunload', save)
    return () => {
      unsub()
      window.clearTimeout(timer)
      window.clearInterval(idle)
      window.removeEventListener('beforeunload', save)
    }
  }, [])

  /* Pane lifecycle events from terminal headers / shortcuts (app-events seam). */
  useEffect(() => {
    const onClosePane = ({ paneId }: { paneId: string }): void => {
      const pane = useLayoutStore.getState().panes.find((p) => p.paneId === paneId)
      if (!pane) return
      const morz = getMorz()
      if (pane.kind === 'terminal') {
        morz?.pty.kill(paneId)
      } else {
        const lane = useLaneStore.getState().lanes.find((l) => l.paneId === paneId)
        if (lane && useModeStore.getState().mode !== 'manual') morz?.claude.interrupt(lane.agentId)
        useLaneStore.getState().removeLane(paneId)
      }
      useLayoutStore.getState().removePane(paneId)
    }
    const onSplitPane = ({ paneId, dir }: { paneId: string; dir: 'right' | 'down' }): void => {
      const cwd = selectActiveSpaceRoot(useSpaceStore.getState())
      useLayoutStore.getState().splitPane(paneId, dir, cwd || undefined)
    }
    const onFocusPane = ({ paneId }: { paneId: string }): void => {
      useLayoutStore.getState().setActivePane(paneId)
      // xterm's hidden textarea owns keyboard input — focus it directly.
      document
        .querySelector<HTMLElement>(`[data-pane-id="${paneId}"] .xterm-helper-textarea`)
        ?.focus()
    }
    on('close-pane', onClosePane)
    on('split-pane', onSplitPane)
    on('focus-pane', onFocusPane)
    return () => {
      off('close-pane', onClosePane)
      off('split-pane', onSplitPane)
      off('focus-pane', onFocusPane)
    }
  }, [])

  /* Claude lane trigger (Slices 5+6): Assisted only, one lane per space.
   * The lane itself calls claude:start on the first prompt (ClaudeLane owns
   * the adapter handshake — start() is kill-and-respawn, so no double-start). */
  const startClaudeLane = useCallback(
    (): void => {
      if (!claudeAllowed(useModeStore.getState().mode)) return
      const cwd = spaceRoot
      if (!cwd) return
      if (useLaneStore.getState().lanes.some((lane) => sameRoot(lane.cwd, cwd))) return
      const paneId = newPaneId('lane')
      const agentId = `claude-${paneId}`
      useLaneStore.getState().addLane({ paneId, agentId, cwd })
      useLayoutStore.getState().addPane({ paneId, kind: 'claude', cwd, shell: '', agentId })
    },
    [spaceRoot]
  )

  const paletteActions = useMemo<PaletteAction[]>(() => {
    const actions: PaletteAction[] = VIEWS.map((item) => ({
      id: `view-${item.id}`,
      group: 'view',
      label: `view: ${item.label.toLowerCase()}`
    }))

    actions.push(
      { id: 'view-workshop', group: 'view', label: 'view: workshop' },
      { id: 'view-settings', group: 'view', label: 'view: settings' },
      { id: 'toggle-explorer', group: 'view', label: 'view: toggle file explorer', hint: 'Ctrl+B' },
      { id: 'spawn-terminal', group: 'spawn', label: 'spawn: terminal pane' },
      { id: 'settings-limits', group: 'settings', label: 'settings: limits & usage' },
      { id: 'settings-appearance', group: 'settings', label: 'settings: appearance' },
      { id: 'settings-control', group: 'settings', label: 'settings: control' },
      { id: 'settings-memory', group: 'settings', label: 'settings: open memory settings' }
    )

    if (activePaneId && panes.some((pane) => pane.paneId === activePaneId)) {
      actions.push(
        { id: 'split-pane-right', group: 'spawn', label: 'spawn: split focused pane right' },
        { id: 'split-pane-down', group: 'spawn', label: 'spawn: split focused pane down' },
        { id: 'close-focused-pane', group: 'view', label: 'view: close focused pane' }
      )
    }

    if (
      claudeAllowed(mode) &&
      activeLanes.length === 0 && // one lane per SPACE (w9/spaces semantics)
      typeof window.morz?.claude?.start === 'function'
    ) {
      actions.push({
        id: 'spawn-claude-lane',
        group: 'spawn',
        label: 'spawn: Claude lane',
        hint: 'assisted'
      })
    }

    if (window.morz?.catalog && typeof window.morz.catalog.refresh === 'function') {
      actions.push({ id: 'workshop-sync', group: 'workshop', label: 'workshop: sync catalog' })
    }

    if (getRunApi()) {
      actions.push({ id: 'run-refresh', group: 'run', label: 'run: refresh orchestration runs' })
    }

    for (const theme of themes) {
      actions.push({
        id: `theme-${theme.id}`,
        group: 'theme',
        label: `theme: switch to ${theme.name}`
      })
    }

    return actions
  }, [activePaneId, activeLanes.length, mode, panes])

  const openSettings = useCallback((tab: SettingsTab, focusMemory = false): void => {
    setSettingsTab(tab)
    setSettingsRevision((revision) => revision + 1)
    setView('settings')
    if (focusMemory) {
      window.setTimeout(() => {
        document
          .querySelector<HTMLElement>('section[aria-label="Learning memory"]')
          ?.scrollIntoView({ block: 'start' })
      }, 0)
    }
  }, [])

  const runPaletteAction = useCallback(
    (id: string): void => {
      const centerView = id.startsWith('view-') ? id.slice('view-'.length) : ''
      if (
        centerView &&
        [...VIEWS.map((item) => item.id), 'settings', 'workshop'].includes(centerView as CenterView)
      ) {
        setView(centerView as CenterView)
        return
      }

      if (id === 'toggle-explorer') {
        setExplorerOpen((open) => !open)
        return
      }

      if (id === 'spawn-terminal') {
        const layout = useLayoutStore.getState()
        const source = layout.panes.find((pane) => pane.paneId === layout.activePaneId)
        layout.addPane({
          paneId: newPaneId('term'),
          kind: 'terminal',
          cwd: source?.cwd || spaceRoot,
          shell: source?.kind === 'terminal' ? source.shell : ''
        })
        setView('terminals')
        return
      }

      if (id === 'spawn-claude-lane') {
        startClaudeLane()
        setView('terminals')
        return
      }

      if (id === 'split-pane-right' || id === 'split-pane-down') {
        const paneId = useLayoutStore.getState().activePaneId
        if (paneId) emit('split-pane', { paneId, dir: id.endsWith('down') ? 'down' : 'right' })
        setView('terminals')
        return
      }

      if (id === 'close-focused-pane') {
        const paneId = useLayoutStore.getState().activePaneId
        if (paneId) emit('close-pane', { paneId })
        setView('terminals')
        return
      }

      if (id === 'settings-limits') openSettings('limits')
      if (id === 'settings-appearance') openSettings('appearance')
      if (id === 'settings-control') openSettings('control')
      if (id === 'settings-memory') openSettings('control', true)

      if (id === 'workshop-sync' && window.morz?.catalog) {
        setView('workshop')
        void useCatalogStore.getState().refresh()
      }

      if (id === 'run-refresh' && getRunApi()) void hydrateRuns()

      if (id.startsWith('theme-')) {
        const themeId = id.slice('theme-'.length)
        if (themes.some((theme) => theme.id === themeId)) useThemeStore.getState().setTheme(themeId)
      }
    },
    [openSettings, spaceRoot, startClaudeLane]
  )

  return (
    <div className="relative flex h-full flex-col overflow-hidden">
      <TitleBar onOpenPalette={() => setPaletteOpen(true)} />

      <div className="relative flex min-h-0 flex-1">
        <SpacesSidebar />

        <main className="flex min-w-0 flex-1 flex-col">
          <div className="flex items-center border-b" style={{ borderColor: 'var(--color-line)', background: colors.page }}>
            {/* explorer toggle + view switcher share the strip above the panes */}
            <button
              onClick={() => setExplorerOpen((v) => !v)}
              className="ml-2 flex cursor-pointer items-center gap-1 rounded-md p-1.5 transition-colors hover:bg-[#37332B]"
              title="Toggle file explorer (Ctrl+B)"
              aria-label="Toggle file explorer"
              style={{ color: explorerOpen ? colors.bronzeHot : colors.quartzDim }}
            >
              <IconFolders size={15} stroke={1.5} />
            </button>

            <nav
              className="ml-1 flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto py-1.5 [&::-webkit-scrollbar]:hidden"
              role="tablist"
              aria-label="Center view"
            >
              {VIEWS.map((v) => {
                const active = view === v.id
                const Icon = v.icon
                return (
                  <button
                    key={v.id}
                    role="tab"
                    aria-selected={active}
                    onClick={() => setView(v.id)}
                    className="relative flex shrink-0 cursor-pointer items-center gap-1.5 rounded-lg px-2.5 py-1 text-[11px] font-medium"
                    style={{ color: active ? colors.quartz : colors.quartzDim, fontFamily: 'var(--font-display)' }}
                  >
                    {active && (
                      <motion.span
                        layoutId="center-view-pill"
                        transition={springs.layout}
                        className="absolute inset-0 rounded-lg border"
                        style={{ background: colors.card, borderColor: 'var(--color-line-strong)' }}
                      />
                    )}
                    <span className="relative flex items-center gap-1.5">
                      <Icon size={13} stroke={1.5} />
                      {v.label}
                    </span>
                  </button>
                )
              })}
            </nav>

            <button
              onClick={() => setView('workshop')}
              className="ml-auto flex cursor-pointer items-center rounded-md p-1.5 transition-colors hover:bg-[#37332B]"
              title="Workshop — add skills, MCP servers, plugins, models"
              aria-label="Workshop"
              style={{ color: view === 'workshop' ? colors.bronzeHot : colors.quartzDim }}
            >
              <IconSquareRoundedPlus size={15} stroke={1.5} />
            </button>
            {/* w10/identity — the orchestrator is a Morz system, not a generic robot. */}
            <button
              onClick={() => setOrchestratorOpen((open) => !open)}
              className="flex cursor-pointer items-center rounded-md p-1.5 transition-colors hover:bg-[#37332B]"
              title={`${orchestratorOpen ? 'Hide' : 'Show'} orchestrator`}
              aria-label="Toggle orchestrator"
              aria-pressed={orchestratorOpen}
              style={{ color: orchestratorOpen ? colors.quartz : colors.quartzDim }}
            >
              <MorzSignal className="h-[15px] w-[21px]" goldPoint />
            </button>
            <button
              onClick={() => setView('settings')}
              className="mr-2 flex cursor-pointer items-center rounded-md p-1.5 transition-colors hover:bg-[#37332B]"
              title="Settings"
              aria-label="Settings"
              style={{ color: view === 'settings' ? colors.bronzeHot : colors.quartzDim }}
            >
              <IconSettings size={15} stroke={1.5} />
            </button>
          </div>

          {view === 'terminals' && (
            <>
              <AgentPillBar />
              <div className="flex min-h-0 flex-1" style={{ background: colors.page }}>
                {!hydrated && (
                  <div
                    className="flex flex-1 items-center justify-center text-[11px]"
                    style={{ background: colors.page, color: colors.quartzDim }}
                  >
                    Restoring session…
                  </div>
                )}
                {hydrated && root && (
                  <LayoutNodeView
                    node={root}
                    renderLeaf={(pane) =>
                      pane.kind === 'terminal' ? (
                        <ShellTerminalPane
                          key={pane.paneId}
                          pane={pane}
                          showStartLane={claudeAllowed(mode)}
                          laneTaken={activeLanes.length > 0}
                          onStartLane={startClaudeLane}
                        />
                      ) : (
                        <LanePaneSlot key={pane.paneId} pane={pane} manual={mode === 'manual'} />
                      )
                    }
                  />
                )}
              </div>
            </>
          )}
          {view === 'commit' && <CommitPanel />}
          {view === 'review' && <ReviewerPanel />}
          {view === 'dag' && <DagView />}
          {view === 'browser' && <BrowserPanel />}
          {view === 'remote' && <RemotePanel />}
          {view === 'organizer' && <OrganizerPanel />}
          {/* w11/sessions */}
          {view === 'sessions' && <SessionsPanel />}
          {view === 'settings' && (
            <SettingsPanel key={`${settingsTab}-${settingsRevision}`} initialTab={settingsTab} />
          )}
          {view === 'workshop' && <WorkshopPanel />}
        </main>

        {orchestratorOpen && <OrchestratorPanel />}{/* w10/identity */}

        <FileExplorer open={explorerOpen} onClose={() => setExplorerOpen(false)} />
      </div>

      <StatusBar onOpenCommit={() => setView('commit')} />

      <ToastHost />

      {/* IDE editor pane — self-managed overlay; opens on ctrl-click 'open-file' events */}
      <IdePane />

      <CommandPalette
        open={paletteOpen}
        actions={paletteActions}
        onClose={() => setPaletteOpen(false)}
        onAction={runPaletteAction}
      />
    </div>
  )
}

/* ── split tree ──────────────────────────────────────────────── */

function LayoutNodeView({
  node,
  renderLeaf
}: {
  node: LayoutNode
  renderLeaf(pane: PaneDef): JSX.Element
}): JSX.Element {
  if (node.type === 'leaf') return renderLeaf(node.pane)
  return <SplitView node={node} renderLeaf={renderLeaf} />
}

function SplitView({
  node,
  renderLeaf
}: {
  node: SplitNode
  renderLeaf(pane: PaneDef): JSX.Element
}): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const row = node.dir === 'row'
  return (
    <div
      ref={containerRef}
      className={`flex min-h-0 min-w-0 flex-1 ${row ? 'flex-row' : 'flex-col'}`}
    >
      <div className="flex min-h-0 min-w-0" style={{ flex: `${node.ratio} 1 0%` }}>
        <LayoutNodeView node={node.a} renderLeaf={renderLeaf} />
      </div>
      <SplitDivider row={row} splitId={node.id} containerRef={containerRef} />
      <div className="flex min-h-0 min-w-0" style={{ flex: `${1 - node.ratio} 1 0%` }}>
        <LayoutNodeView node={node.b} renderLeaf={renderLeaf} />
      </div>
    </div>
  )
}

/* Pointer-drag resizer: ratio = pointer position within the split container. */
function SplitDivider({
  row,
  splitId,
  containerRef
}: {
  row: boolean
  splitId: string
  containerRef: React.RefObject<HTMLDivElement>
}): JSX.Element {
  const [dragging, setDragging] = useState(false)
  return (
    <div
      role="separator"
      aria-orientation={row ? 'vertical' : 'horizontal'}
      onPointerDown={(e) => {
        e.preventDefault()
        e.currentTarget.setPointerCapture(e.pointerId)
        setDragging(true)
      }}
      onPointerMove={(e) => {
        if (!dragging) return
        const rect = containerRef.current?.getBoundingClientRect()
        if (!rect) return
        const ratio = row
          ? (e.clientX - rect.left) / rect.width
          : (e.clientY - rect.top) / rect.height
        useLayoutStore.getState().setRatio(splitId, ratio) // store clamps 0.15–0.85
      }}
      onPointerUp={(e) => {
        e.currentTarget.releasePointerCapture(e.pointerId)
        setDragging(false)
      }}
      className="shrink-0 transition-colors"
      style={{
        width: row ? 4 : undefined,
        height: row ? undefined : 4,
        cursor: row ? 'col-resize' : 'row-resize',
        background: dragging ? colors.bronze : 'var(--color-line)',
        touchAction: 'none'
      }}
    />
  )
}

/* ── panes ───────────────────────────────────────────────────── */

/*
 * Live terminal pane: useTerminal spawns/reattaches the PTY with the pane's
 * saved shell+cwd (TerminalPane can't carry those — it's the Phase-0 mock
 * chrome). Header buttons emit the app-events seam Shell subscribes to.
 */
function ShellTerminalPane({
  pane,
  showStartLane,
  laneTaken,
  onStartLane
}: {
  pane: PaneDef
  showStartLane: boolean
  laneTaken: boolean
  onStartLane(): void
}): JSX.Element {
  const { containerRef } = useTerminal(pane.paneId, {
    shell: pane.shell || undefined,
    cwd: pane.cwd || undefined
  })
  const ctxMenu = useTerminalContextMenu(pane.paneId)
  const active = useLayoutStore((s) => s.activePaneId === pane.paneId)

  return (
    <section
      className="relative flex min-w-0 flex-1 flex-col overflow-hidden"
      style={{
        background: colors.page,
        boxShadow: active ? `inset 0 0 0 1px ${colors.bronze}66` : undefined
      }}
      aria-label={`Terminal — ${pane.paneId}`}
      data-pane-id={pane.paneId}
      onPointerDownCapture={() => useLayoutStore.getState().setActivePane(pane.paneId)}
    >
      <div
        className="flex shrink-0 items-center gap-2 border-b px-3 py-1.5"
        style={{ background: colors.panel, borderColor: 'var(--color-line)' }}
      >
        <IconTerminal2 size={12} stroke={1.5} style={{ color: colors.quartzDim }} />
        <span className="text-xs font-semibold" style={{ fontFamily: 'var(--font-display)' }}>
          {pane.shell || 'shell'}
        </span>
        <span className="truncate font-mono text-[10px]" style={{ color: colors.quartzDim }}>
          {pane.cwd}
        </span>
        <span className="ml-auto flex items-center gap-0.5">
          {showStartLane && (
            <button
              onClick={onStartLane}
              disabled={laneTaken}
              className="flex cursor-pointer items-center rounded-md p-1 transition-colors hover:bg-[#37332B] disabled:cursor-not-allowed disabled:opacity-40"
              title={laneTaken ? 'One Claude lane per space in 0.0.1' : 'Start Claude here'}
              aria-label="Start Claude here"
              style={{ color: colors.agentClaude }}
            >
              <IconRobot size={13} stroke={1.5} />
            </button>
          )}
          <button
            onClick={() => emit('split-pane', { paneId: pane.paneId, dir: 'right' })}
            className="flex cursor-pointer items-center rounded-md p-1 transition-colors hover:bg-[#37332B]"
            title="Split pane"
            aria-label="Split pane"
            style={{ color: colors.quartzDim }}
          >
            <IconColumns size={13} stroke={1.5} />
          </button>
          <button
            onClick={() => emit('close-pane', { paneId: pane.paneId })}
            className="flex cursor-pointer items-center rounded-md p-1 transition-colors hover:bg-[#37332B]"
            title="Close pane"
            aria-label="Close pane"
            style={{ color: colors.quartzDim }}
          >
            <IconX size={13} stroke={1.5} />
          </button>
        </span>
      </div>

      {/* xterm mount — pl-3 leaves room for the block accent strips */}
      <div
        ref={containerRef}
        className="min-h-0 flex-1 py-2 pl-3 pr-1"
        style={{ background: colors.page }}
        onContextMenu={ctxMenu.onContextMenu}
      />

      {/* right-click context menu (copy/paste/split/close) */}
      {ctxMenu.element}
    </section>
  )
}

/*
 * Claude lane slot. Manual mounts NOTHING that touches window.morz.claude —
 * lane panes are stripped on hydrate and on dial switch, so this branch is a
 * belt-and-braces placeholder, not a code path that talks to the adapter.
 */
function LanePaneSlot({ pane, manual }: { pane: PaneDef; manual: boolean }): JSX.Element {
  const active = useLayoutStore((s) => s.activePaneId === pane.paneId)
  return (
    <section
      className="relative flex min-w-0 flex-1 flex-col overflow-hidden"
      style={{
        background: colors.page,
        boxShadow: active ? `inset 0 0 0 1px ${colors.bronze}66` : undefined
      }}
      aria-label={`Claude lane — ${pane.agentId ?? pane.paneId}`}
      data-pane-id={pane.paneId}
      onPointerDownCapture={() => useLayoutStore.getState().setActivePane(pane.paneId)}
    >
      <div
        className="flex shrink-0 items-center gap-2 border-b px-3 py-1.5"
        style={{ background: colors.panel, borderColor: 'var(--color-line)' }}
      >
        <IconRobot size={12} stroke={1.5} style={{ color: colors.agentClaude }} />
        <span className="text-xs font-semibold" style={{ fontFamily: 'var(--font-display)' }}>
          Claude lane
        </span>
        <span className="truncate font-mono text-[10px]" style={{ color: colors.quartzDim }}>
          {pane.cwd}
        </span>
        <button
          onClick={() => emit('close-pane', { paneId: pane.paneId })}
          className="ml-auto flex cursor-pointer items-center rounded-md p-1 transition-colors hover:bg-[#37332B]"
          title="Close lane"
          aria-label="Close lane"
          style={{ color: colors.quartzDim }}
        >
          <IconX size={13} stroke={1.5} />
        </button>
      </div>
      <div className="min-h-0 flex-1 p-2">
        {manual ? (
          <div
            className="flex h-full items-center justify-center rounded-xl border text-[11px]"
            style={{ background: colors.panel, borderColor: 'var(--color-line)', color: colors.quartzDim }}
          >
            Manual mode — lane closed. Switch to Assisted to start one.
          </div>
        ) : (
          <ClaudeLane agentId={pane.agentId ?? pane.paneId} cwd={pane.cwd} />
        )}
      </div>
    </section>
  )
}
