import { useCallback, useEffect, useState } from 'react'
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
  IconX
} from '@tabler/icons-react'
import { TitleBar } from './TitleBar'
import { SpacesSidebar } from './SpacesSidebar'
import { AgentPillBar } from './AgentPillBar'
import { OrchestratorPanel } from './OrchestratorPanel'
import { StatusBar } from './StatusBar'
import { CommandPalette } from './CommandPalette'
import { FileExplorer } from './FileExplorer'
import { CommitPanel } from './CommitPanel'
import { ReviewerPanel } from './ReviewerPanel'
import { DagView } from './DagView'
import { BrowserPanel } from './BrowserPanel'
import { RemotePanel } from './RemotePanel'
import { SettingsPanel } from './SettingsPanel'
import { WorkshopPanel } from './WorkshopPanel'
import { ToastHost } from './Toast'
import { IdePane } from './IdePane'
import { ClaudeLane } from './ClaudeLane'
import { serializeTerminal, useTerminal } from '@/hooks/useTerminal'
import { emit, off, on } from '@/lib/app-events'
import { colors } from '@/lib/tokens'
import { springs } from '@/lib/springs'
import { claudeAllowed, useModeStore } from '@/store/modeStore'
import { useLaneStore } from '@/store/laneStore'
import { newPaneId, useLayoutStore, type PaneDef } from '@/store/layoutStore'
import { getMorz, useSpaceStore } from '@/store/spaceStore'
import type { SessionSnapshot } from '@shared/ipc'

type CenterView = 'terminals' | 'commit' | 'review' | 'dag' | 'browser' | 'remote' | 'settings' | 'workshop'

const VIEWS: { id: CenterView; label: string; icon: typeof IconTerminal2 }[] = [
  { id: 'terminals', label: 'Terminals', icon: IconTerminal2 },
  { id: 'commit', label: 'Commit', icon: IconGitCommit },
  { id: 'review', label: 'Review', icon: IconShieldCheck },
  { id: 'dag', label: 'Waves', icon: IconTopologyStar3 },
  { id: 'browser', label: 'Browser', icon: IconWorld },
  { id: 'remote', label: 'Remote', icon: IconDeviceMobile }
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

/* ── session snapshot (Slice 2) ──────────────────────────────── */

function buildSnapshot(panes: PaneDef[]): SessionSnapshot {
  return {
    layout: { panes },
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

/** layout is opaque in the contract — validate our own shape, fall back to panes[]. */
function panesFromSnapshot(snap: SessionSnapshot | null): PaneDef[] | null {
  if (!snap) return null
  const layout = snap.layout as { panes?: unknown } | null | undefined
  if (layout && Array.isArray(layout.panes)) {
    const parsed = (layout.panes as Partial<PaneDef>[])
      .filter(
        (p): p is PaneDef =>
          typeof p?.paneId === 'string' && (p.kind === 'terminal' || p.kind === 'claude')
      )
      .map((p) => ({
        paneId: p.paneId,
        kind: p.kind,
        cwd: p.cwd ?? '',
        shell: p.shell ?? '',
        agentId: p.agentId
      }))
    if (parsed.length > 0) return parsed
  }
  if (Array.isArray(snap.panes) && snap.panes.length > 0) {
    return snap.panes.map((p) => ({
      paneId: p.paneId,
      kind: 'terminal' as const,
      cwd: p.cwd,
      shell: p.shell
    }))
  }
  return null
}

/* Morz shell: titlebar / (sidebar | pill-bar + center view | orchestrator) / statusbar. */
export function Shell(): JSX.Element {
  const initial = initialFromUrl()
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [explorerOpen, setExplorerOpen] = useState(initial.explorer)
  const [view, setView] = useState<CenterView>(initial.view)

  const mode = useModeStore((s) => s.mode)
  const panes = useLayoutStore((s) => s.panes)
  const hydrated = useLayoutStore((s) => s.hydrated)
  const lanes = useLaneStore((s) => s.lanes)
  const spaceRoot = useSpaceStore((s) => s.spaces[0]?.root ?? '')

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
    if (useLayoutStore.getState().hydrated) return
    const finish = (loaded: PaneDef[] | null): void => {
      if (useLayoutStore.getState().hydrated) return
      const currentMode = useModeStore.getState().mode
      const usable =
        currentMode === 'manual' ? (loaded?.filter((p) => p.kind !== 'claude') ?? null) : loaded
      useLayoutStore.getState().hydrate(usable)
      if (currentMode !== 'manual' && usable) {
        for (const p of usable) {
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
      .then((snap) => finish(panesFromSnapshot(snap)))
      .catch(() => finish(null))
  }, [])

  /* Session save: debounced on pane-list change, 30s idle tick for scrollback
   * drift (never per chunk), and on window unload. */
  useEffect(() => {
    const sess = getMorz()?.session
    if (!sess) return
    let timer: number | undefined
    const save = (): void => {
      const { panes: current, hydrated: ready } = useLayoutStore.getState()
      if (ready) sess.save(buildSnapshot(current))
    }
    const unsub = useLayoutStore.subscribe((s, prev) => {
      if (!s.hydrated || s.panes === prev.panes) return
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
      useLayoutStore.getState().splitPane(paneId, dir)
    }
    on('close-pane', onClosePane)
    on('split-pane', onSplitPane)
    return () => {
      off('close-pane', onClosePane)
      off('split-pane', onSplitPane)
    }
  }, [])

  /* Claude lane trigger (Slices 5+6): Assisted only, one lane per space.
   * The lane itself calls claude:start on the first prompt (ClaudeLane owns
   * the adapter handshake — start() is kill-and-respawn, so no double-start). */
  const startClaudeLane = useCallback(
    (fromPaneId?: string): void => {
      if (!claudeAllowed(useModeStore.getState().mode)) return
      if (useLaneStore.getState().lanes.length > 0) return // one lane per space (0.0.1)
      const src = fromPaneId
        ? useLayoutStore.getState().panes.find((p) => p.paneId === fromPaneId)
        : undefined
      const cwd = src?.cwd || spaceRoot
      const paneId = newPaneId('lane')
      const agentId = `claude-${paneId}`
      useLaneStore.getState().addLane({ paneId, agentId, cwd })
      useLayoutStore.getState().addPane({ paneId, kind: 'claude', cwd, shell: '', agentId })
    },
    [spaceRoot]
  )

  const paletteExtras =
    claudeAllowed(mode) && lanes.length === 0
      ? [{ id: 'spawn-claude-lane', group: 'spawn', label: 'spawn: Claude lane', hint: 'assisted' }]
      : []

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

            <nav className="ml-1 flex items-center gap-0.5 py-1.5" role="tablist" aria-label="Center view">
              {VIEWS.map((v) => {
                const active = view === v.id
                const Icon = v.icon
                return (
                  <button
                    key={v.id}
                    role="tab"
                    aria-selected={active}
                    onClick={() => setView(v.id)}
                    className="relative flex cursor-pointer items-center gap-1.5 rounded-lg px-2.5 py-1 text-[11px] font-medium"
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
              <div className="flex min-h-0 flex-1 gap-px" style={{ background: 'var(--color-line)' }}>
                {!hydrated && (
                  <div
                    className="flex flex-1 items-center justify-center text-[11px]"
                    style={{ background: colors.page, color: colors.quartzDim }}
                  >
                    Restoring session…
                  </div>
                )}
                {hydrated &&
                  panes.map((pane) =>
                    pane.kind === 'terminal' ? (
                      <ShellTerminalPane
                        key={pane.paneId}
                        pane={pane}
                        showStartLane={claudeAllowed(mode)}
                        laneTaken={lanes.length > 0}
                        onStartLane={() => startClaudeLane(pane.paneId)}
                      />
                    ) : (
                      <LanePaneSlot key={pane.paneId} pane={pane} manual={mode === 'manual'} />
                    )
                  )}
              </div>
            </>
          )}
          {view === 'commit' && <CommitPanel />}
          {view === 'review' && <ReviewerPanel />}
          {view === 'dag' && <DagView />}
          {view === 'browser' && <BrowserPanel />}
          {view === 'remote' && <RemotePanel />}
          {view === 'settings' && <SettingsPanel />}
          {view === 'workshop' && <WorkshopPanel />}
        </main>

        <OrchestratorPanel />

        <FileExplorer open={explorerOpen} onClose={() => setExplorerOpen(false)} />
      </div>

      <StatusBar onOpenCommit={() => setView('commit')} />

      <ToastHost />

      {/* IDE editor pane — self-managed overlay; opens on ctrl-click 'open-file' events */}
      <IdePane />

      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        extraActions={paletteExtras}
        onAction={(id) => {
          if (id === 'spawn-claude-lane') startClaudeLane()
        }}
      />
    </div>
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

  return (
    <section
      className="relative flex min-w-0 flex-1 flex-col overflow-hidden"
      style={{ background: colors.page }}
      aria-label={`Terminal — ${pane.paneId}`}
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
      <div ref={containerRef} className="min-h-0 flex-1 py-2 pl-3 pr-1" style={{ background: colors.page }} />
    </section>
  )
}

/*
 * Claude lane slot. Manual mounts NOTHING that touches window.morz.claude —
 * lane panes are stripped on hydrate and on dial switch, so this branch is a
 * belt-and-braces placeholder, not a code path that talks to the adapter.
 */
function LanePaneSlot({ pane, manual }: { pane: PaneDef; manual: boolean }): JSX.Element {
  return (
    <section
      className="relative flex min-w-0 flex-1 flex-col overflow-hidden"
      style={{ background: colors.page }}
      aria-label={`Claude lane — ${pane.agentId ?? pane.paneId}`}
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
