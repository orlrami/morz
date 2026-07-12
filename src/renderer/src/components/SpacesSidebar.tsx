import { useEffect, useState } from 'react'
import { motion } from 'framer-motion'
import {
  IconArrowDown,
  IconArrowUp,
  IconChevronDown,
  IconChevronRight,
  IconGitBranch,
  IconPlus
} from '@tabler/icons-react'
import type { GitStatus } from '@shared/ipc'
import { cliTint, cliLabel } from '@/lib/mock'
import { colors, statusColor } from '@/lib/tokens'
import { staggerContainer, staggerItem } from '@/lib/springs'
import { useSpaceStore, type Space, type SpaceAgent } from '@/store/spaceStore'

/*
 * Spaces sidebar (Slice 4): projects → agents, live from git. Each agent row
 * shows its REAL branch/worktree (owner workflow: builders on branches →
 * merge to main — never all "main"). Data: window.morz.git via spaceStore.
 */
export function SpacesSidebar(): JSX.Element {
  const spaces = useSpaceStore((s) => s.spaces)
  const gitByRoot = useSpaceStore((s) => s.gitByRoot)
  const startWatching = useSpaceStore((s) => s.startWatching)
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})

  useEffect(() => {
    startWatching()
  }, [spaces, startWatching])

  return (
    <aside
      className="flex w-[248px] shrink-0 flex-col overflow-hidden border-r"
      style={{ background: colors.panel, borderColor: 'var(--color-line)' }}
    >
      <div className="flex items-center justify-between px-4 pb-1 pt-3">
        <span className="text-[10px] uppercase tracking-wider" style={{ color: colors.quartzDim }}>
          Spaces
        </span>
        <button
          className="flex cursor-pointer items-center gap-1 rounded-md border px-2 py-0.5 text-[10.5px] font-semibold transition-colors hover:brightness-110"
          style={{
            background: 'rgba(203,162,90,0.14)',
            borderColor: 'rgba(203,162,90,0.32)',
            color: colors.bronzeHot,
            fontFamily: 'var(--font-display)'
          }}
        >
          <IconPlus size={11} stroke={2} />
          New team
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-2 py-1.5">
        {spaces.map((space) => (
          <SpaceCard
            key={space.id}
            space={space}
            gitByRoot={gitByRoot}
            collapsed={collapsed[space.id] ?? false}
            onToggle={() => setCollapsed((c) => ({ ...c, [space.id]: !(c[space.id] ?? false) }))}
          />
        ))}
      </div>

      <div className="border-t pt-2" style={{ borderColor: 'var(--color-line)' }}>
        <div className="flex flex-wrap gap-x-3 gap-y-1 px-4 pb-3 text-[10px]" style={{ color: colors.quartzDim }}>
          <Legend color={statusColor.working} label="dirty" />
          <Legend color={statusColor.done} label="clean" />
          <Legend color={statusColor.idle} label="no data" />
        </div>
      </div>
    </aside>
  )
}

function SpaceCard({
  space,
  gitByRoot,
  collapsed,
  onToggle
}: {
  space: Space
  gitByRoot: Record<string, GitStatus>
  collapsed: boolean
  onToggle(): void
}): JSX.Element {
  const git = gitByRoot[space.root]

  if (collapsed) {
    return (
      <button
        onClick={onToggle}
        className="mt-1.5 flex w-full cursor-pointer items-center gap-1.5 rounded-xl px-3.5 py-2 text-left transition-colors hover:bg-[#37332B]"
        style={{ color: colors.quartzDim }}
      >
        <IconChevronRight size={12} stroke={1.5} />
        <span className="text-xs font-semibold" style={{ color: colors.quartz, fontFamily: 'var(--font-display)' }}>
          {space.name}
        </span>
        <span className="ml-auto">
          <BranchChip git={git} />
        </span>
      </button>
    )
  }

  return (
    <div
      className="mt-1.5 rounded-xl border px-2.5 py-2 first:mt-0"
      style={{ background: colors.card + '66', borderColor: 'var(--color-line)' }}
    >
      <button onClick={onToggle} className="flex w-full cursor-pointer items-center gap-1.5 px-1 text-left">
        <IconChevronDown size={12} stroke={1.5} style={{ color: colors.quartzDim }} />
        <span className="text-xs font-semibold" style={{ fontFamily: 'var(--font-display)', color: colors.quartz }}>
          {space.name}
        </span>
        <span className="ml-auto">
          <BranchChip git={git} />
        </span>
      </button>

      <motion.ul variants={staggerContainer} initial="hidden" animate="show" className="mt-1.5 space-y-0.5">
        {space.agents.map((agent) => (
          <motion.li key={agent.id} variants={staggerItem}>
            <AgentRow agent={agent} git={gitByRoot[agent.root]} />
          </motion.li>
        ))}
        {space.agents.length === 0 && (
          <li className="px-2 py-1 text-[10px]" style={{ color: colors.quartzDim }}>
            No agent worktrees
          </li>
        )}
      </motion.ul>
    </div>
  )
}

function AgentRow({ agent, git }: { agent: SpaceAgent; git: GitStatus | undefined }): JSX.Element {
  const dirty = (git?.files.length ?? 0) > 0
  const dot = !git || git.branch == null ? statusColor.idle : dirty ? statusColor.working : statusColor.done

  return (
    <button
      className="group flex w-full cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors"
      style={{ color: colors.quartz }}
      onMouseEnter={(e) => (e.currentTarget.style.background = colors.card)}
      onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
      title={agent.root}
    >
      <span className="size-2 shrink-0 rounded-full" style={{ background: dot }} />
      <span className="truncate text-xs">{agent.name}</span>
      <span className="ml-auto flex shrink-0 items-center gap-1">
        <span
          className="rounded-md border px-1.5 py-px text-[9px] font-medium"
          style={{ borderColor: 'var(--color-line-strong)', color: cliTint[agent.cli] }}
        >
          {cliLabel[agent.cli]}
        </span>
        <BranchChip git={git} small />
      </span>
    </button>
  )
}

function BranchChip({ git, small }: { git: GitStatus | undefined; small?: boolean }): JSX.Element {
  const dirtyCount = git?.files.length ?? 0
  return (
    <span
      className={`flex items-center gap-1 ${small ? 'text-[9px]' : 'text-[10px]'}`}
      style={{ color: colors.quartzDim }}
    >
      <IconGitBranch size={small ? 10 : 11} stroke={1.5} />
      <span className="max-w-[90px] truncate">{git?.branch ?? '—'}</span>
      {dirtyCount > 0 && <span style={{ color: colors.working }}>±{dirtyCount}</span>}
      {(git?.ahead ?? 0) > 0 && (
        <span className="flex items-center" style={{ color: colors.done }}>
          <IconArrowUp size={9} stroke={2} />
          {git!.ahead}
        </span>
      )}
      {(git?.behind ?? 0) > 0 && (
        <span className="flex items-center" style={{ color: colors.blocked }}>
          <IconArrowDown size={9} stroke={2} />
          {git!.behind}
        </span>
      )}
    </span>
  )
}

function Legend({ color, label }: { color: string; label: string }): JSX.Element {
  return (
    <span className="flex items-center gap-1">
      <span className="size-1.5 rounded-full" style={{ background: color }} />
      {label}
    </span>
  )
}
