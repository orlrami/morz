import { useEffect, useState } from 'react'
import { TitleBar } from './TitleBar'
import { SpacesSidebar } from './SpacesSidebar'
import { AgentPillBar } from './AgentPillBar'
import { TerminalPane } from './TerminalPane'
import { OrchestratorPanel } from './OrchestratorPanel'
import { StatusBar } from './StatusBar'
import { CommandPalette } from './CommandPalette'
import { spaces, builder1Blocks, builder2Blocks } from '@/lib/mock'

/* Morz shell: titlebar / (sidebar | pill-bar + panes | orchestrator) / statusbar. */
export function Shell(): JSX.Element {
  const [paletteOpen, setPaletteOpen] = useState(false)
  const agents = spaces[0].agents
  const builder1 = agents.find((a) => a.id === 'builder-1')!
  const builder2 = agents.find((a) => a.id === 'builder-2')!

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setPaletteOpen((v) => !v)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return (
    <div className="relative flex h-full flex-col overflow-hidden">
      <TitleBar onOpenPalette={() => setPaletteOpen(true)} />

      <div className="flex min-h-0 flex-1">
        <SpacesSidebar />

        <main className="flex min-w-0 flex-1 flex-col">
          <AgentPillBar />
          <div className="flex min-h-0 flex-1 gap-px" style={{ background: 'var(--color-line)' }}>
            <TerminalPane agent={builder1} blocks={builder1Blocks} tail="cursor" />
            <TerminalPane agent={builder2} blocks={builder2Blocks} tail="approval" />
          </div>
        </main>

        <OrchestratorPanel />
      </div>

      <StatusBar />

      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
    </div>
  )
}
