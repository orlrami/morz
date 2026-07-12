import { useEffect, useState } from 'react'
import { motion } from 'framer-motion'
import { IconTerminal2, IconGitCommit, IconShieldCheck, IconTopologyStar3, IconFolders } from '@tabler/icons-react'
import { TitleBar } from './TitleBar'
import { SpacesSidebar } from './SpacesSidebar'
import { AgentPillBar } from './AgentPillBar'
import { TerminalPane } from './TerminalPane'
import { OrchestratorPanel } from './OrchestratorPanel'
import { StatusBar } from './StatusBar'
import { CommandPalette } from './CommandPalette'
import { FileExplorer } from './FileExplorer'
import { CommitPanel } from './CommitPanel'
import { ReviewerPanel } from './ReviewerPanel'
import { DagView } from './DagView'
import { spaces, builder1Blocks, builder2Blocks } from '@/lib/mock'
import { colors } from '@/lib/tokens'
import { springs } from '@/lib/springs'

type CenterView = 'terminals' | 'commit' | 'review' | 'dag'

const VIEWS: { id: CenterView; label: string; icon: typeof IconTerminal2 }[] = [
  { id: 'terminals', label: 'Terminals', icon: IconTerminal2 },
  { id: 'commit', label: 'Commit', icon: IconGitCommit },
  { id: 'review', label: 'Review', icon: IconShieldCheck },
  { id: 'dag', label: 'Waves', icon: IconTopologyStar3 }
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

/* Morz shell: titlebar / (sidebar | pill-bar + center view | orchestrator) / statusbar. */
export function Shell(): JSX.Element {
  const initial = initialFromUrl()
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [explorerOpen, setExplorerOpen] = useState(initial.explorer)
  const [view, setView] = useState<CenterView>(initial.view)

  const agents = spaces[0].agents
  const builder1 = agents.find((a) => a.id === 'builder-1')!
  const builder2 = agents.find((a) => a.id === 'builder-2')!

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
          </div>

          {view === 'terminals' && (
            <>
              <AgentPillBar />
              <div className="flex min-h-0 flex-1 gap-px" style={{ background: 'var(--color-line)' }}>
                <TerminalPane agent={builder1} blocks={builder1Blocks} tail="cursor" />
                <TerminalPane agent={builder2} blocks={builder2Blocks} tail="approval" />
              </div>
            </>
          )}
          {view === 'commit' && <CommitPanel />}
          {view === 'review' && <ReviewerPanel />}
          {view === 'dag' && <DagView />}
        </main>

        <OrchestratorPanel />

        <FileExplorer open={explorerOpen} onClose={() => setExplorerOpen(false)} />
      </div>

      <StatusBar onOpenCommit={() => setView('commit')} />

      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
    </div>
  )
}
