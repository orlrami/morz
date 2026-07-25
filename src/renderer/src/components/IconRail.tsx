import { useEffect, useRef, useState } from 'react'
import {
  IconFolders,
  IconGitCommit,
  IconHistory,
  IconPlus,
  IconSettings,
  IconShieldCheck,
  IconSquareRoundedPlus,
  IconTerminal2,
  IconTopologyStar3,
  IconWorld
} from '@tabler/icons-react'
import { MODULES, type ModuleId } from '@shared/modules'
import { colors } from '@/lib/tokens'
import { useModulesStore } from '@/store/modulesStore'
import { ModuleDrawer } from './ModuleDrawer'

/*
 * w15/shell-layout — 56px icon rail, the shell's only view switcher.
 * Groups: CORE (Terminals, Explorer toggle) / MODULES (enabled modules with a
 * center view, from modulesStore) / bottom `+` (module drawer) + Settings.
 * Active view = bronze left bar + card tint. Buttons keep role="tab" with the
 * same accessible names the old top strip had, so view navigation is stable.
 */

export type RailView =
  | 'terminals'
  | 'commit'
  | 'review'
  | 'dag'
  | 'browser'
  | 'organizer'
  | 'sessions'
  | 'settings'
  | 'workshop'

/** Modules that own a center view, in rail order. Others (pulse/voice/obsidian) live in Settings. */
const MODULE_VIEWS: { module: ModuleId; view: RailView; label: string; icon: typeof IconTerminal2 }[] = [
  { module: 'commit', view: 'commit', label: 'Commit', icon: IconGitCommit },
  { module: 'review', view: 'review', label: 'Review', icon: IconShieldCheck },
  { module: 'orchestration', view: 'dag', label: 'Waves', icon: IconTopologyStar3 },
  { module: 'browser', view: 'browser', label: 'Browser', icon: IconWorld },
  { module: 'organizer', view: 'organizer', label: 'Organizer', icon: IconFolders },
  { module: 'sessions', view: 'sessions', label: 'Sessions', icon: IconHistory },
  { module: 'workshop', view: 'workshop', label: 'Workshop', icon: IconSquareRoundedPlus }
]

interface IconRailProps {
  view: RailView
  onSelectView(view: RailView): void
  explorerOpen: boolean
  onToggleExplorer(): void
}

export function IconRail({ view, onSelectView, explorerOpen, onToggleExplorer }: IconRailProps): JSX.Element {
  const enabled = useModulesStore((s) => s.enabled)
  const [drawerOpen, setDrawerOpen] = useState(false)

  return (
    <nav
      className="relative flex w-14 shrink-0 flex-col items-center border-r"
      style={{ background: colors.panel, borderColor: 'var(--color-line)' }}
      aria-label="View rail"
      data-testid="icon-rail"
    >
      <div
        role="tablist"
        aria-label="Views"
        aria-orientation="vertical"
        className="flex w-full flex-col items-center gap-1 pt-2"
      >
        <RailTab
          label="Terminals"
          icon={IconTerminal2}
          active={view === 'terminals'}
          onClick={() => onSelectView('terminals')}
        />
        <RailButton
          label="Toggle file explorer"
          title="Toggle file explorer (Ctrl+B)"
          icon={IconFolders}
          lit={explorerOpen}
          onClick={onToggleExplorer}
        />

        <RailDivider />

        {MODULE_VIEWS.filter((m) => enabled[m.module]).map((m) => (
          <RailTab
            key={m.view}
            label={m.label}
            icon={m.icon}
            active={view === m.view}
            onClick={() => onSelectView(m.view)}
          />
        ))}
      </div>

      <div className="mt-auto flex w-full flex-col items-center gap-1 pb-2">
        <RailButton
          label="Add modules"
          title="Add modules"
          icon={IconPlus}
          lit={drawerOpen}
          onClick={() => setDrawerOpen((v) => !v)}
        />
        <RailButton
          label="Settings"
          title="Settings"
          icon={IconSettings}
          lit={view === 'settings'}
          onClick={() => onSelectView('settings')}
        />
      </div>

      <ModuleDrawer open={drawerOpen} onClose={() => setDrawerOpen(false)} />
    </nav>
  )
}

function RailDivider(): JSX.Element {
  return <span className="my-1 h-px w-7" style={{ background: 'var(--color-line-strong)' }} aria-hidden />
}

function RailTab({
  label,
  icon: Icon,
  active,
  onClick
}: {
  label: string
  icon: typeof IconTerminal2
  active: boolean
  onClick(): void
}): JSX.Element {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      aria-label={label}
      title={label}
      onClick={onClick}
      className="relative flex h-9 w-full cursor-pointer items-center justify-center transition-colors"
      style={{ color: active ? colors.quartz : colors.quartzDim }}
    >
      {active && (
        <span
          className="absolute bottom-1.5 left-0 top-1.5 w-[3px] rounded-r"
          style={{ background: colors.bronze }}
          aria-hidden
        />
      )}
      <span
        className="flex size-8 items-center justify-center rounded-lg"
        style={{ background: active ? colors.card : 'transparent' }}
      >
        <Icon size={17} stroke={1.5} />
      </span>
    </button>
  )
}

function RailButton({
  label,
  title,
  icon: Icon,
  lit,
  onClick
}: {
  label: string
  title: string
  icon: typeof IconTerminal2
  lit: boolean
  onClick(): void
}): JSX.Element {
  return (
    <button
      type="button"
      aria-label={label}
      title={title}
      onClick={onClick}
      className="flex h-9 w-full cursor-pointer items-center justify-center transition-colors"
      style={{ color: lit ? colors.bronzeHot : colors.quartzDim }}
    >
      <span className="flex size-8 items-center justify-center rounded-lg hover:bg-[#37332B]">
        <Icon size={17} stroke={1.5} />
      </span>
    </button>
  )
}

/* w15 integration — the rail's `+` opens the real ModuleDrawer (w15/modules-core). */
