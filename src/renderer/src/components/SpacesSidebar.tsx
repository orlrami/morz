import { useEffect, useState } from 'react'
import { motion } from 'framer-motion'
import {
  IconAlertTriangle,
  IconArrowDown,
  IconArrowUp,
  IconChevronDown,
  IconChevronRight,
  IconFolderPlus,
  IconGitBranch,
  IconPencil,
  IconTrash
} from '@tabler/icons-react'
import type { DialogBridge, GitStatus } from '@shared/ipc'
import { cliTint, cliLabel } from '@/lib/mock'
import { colors, statusColor } from '@/lib/tokens'
import { staggerContainer, staggerItem } from '@/lib/springs'
import { useSpaceStore, type Space, type SpaceAgent } from '@/store/spaceStore'

interface SpaceMenu {
  space: Space
  x: number
  y: number
}

interface RenameDraft {
  space: Space
  name: string
}

function dialogBridge(): DialogBridge | undefined {
  return (window as unknown as { morzDialog?: DialogBridge }).morzDialog
}

export function SpacesSidebar(): JSX.Element {
  const spaces = useSpaceStore((state) => state.spaces)
  const activeSpaceId = useSpaceStore((state) => state.activeSpaceId)
  const unavailableRoots = useSpaceStore((state) => state.unavailableRoots)
  const gitByRoot = useSpaceStore((state) => state.gitByRoot)
  const ready = useSpaceStore((state) => state.ready)
  const addSpace = useSpaceStore((state) => state.addSpace)
  const removeSpace = useSpaceStore((state) => state.removeSpace)
  const renameSpace = useSpaceStore((state) => state.renameSpace)
  const setActiveSpace = useSpaceStore((state) => state.setActiveSpace)
  const startWatching = useSpaceStore((state) => state.startWatching)
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  const [menu, setMenu] = useState<SpaceMenu | null>(null)
  const [renameDraft, setRenameDraft] = useState<RenameDraft | null>(null)
  const [pickerError, setPickerError] = useState<string | null>(null)

  useEffect(() => {
    startWatching()
  }, [spaces, startWatching])

  const openFolder = async (): Promise<void> => {
    if (!ready) return
    try {
      const root = await dialogBridge()?.pickFolder()
      if (root) addSpace(root)
      setPickerError(null)
    } catch {
      setPickerError('Could not open the folder picker.')
    }
  }

  const beginRename = (space: Space): void => {
    setRenameDraft({ space, name: space.name })
    setMenu(null)
  }


  const saveRename = (): void => {
    if (!renameDraft?.name.trim()) return
    renameSpace(renameDraft.space.id, renameDraft.name)
    setRenameDraft(null)
  }

  const remove = (space: Space): void => {
    if (
      window.confirm(
        `Remove ${space.name} from Morz? This only removes the space; files on disk will not be changed.`
      )
    ) {
      removeSpace(space.id)
    }
    setMenu(null)
  }

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
          type="button"
          onClick={() => void openFolder()}
          disabled={!ready}
          className="flex cursor-pointer items-center gap-1 rounded-md border px-2 py-0.5 text-[10.5px] font-semibold transition-colors hover:brightness-110 focus-visible:outline focus-visible:outline-2 disabled:cursor-not-allowed disabled:opacity-40"
          style={{
            background: 'rgba(203,162,90,0.14)',
            borderColor: 'rgba(203,162,90,0.32)',
            color: colors.bronzeHot,
            fontFamily: 'var(--font-display)'
          }}
        >
          <IconFolderPlus size={11} stroke={2} />
          Open folder
        </button>
      </div>

      {pickerError && (
        <p role="alert" className="px-4 pb-1 text-[10px]" style={{ color: colors.error }}>
          {pickerError}
        </p>
      )}

      <div className="flex-1 overflow-y-auto px-2 py-1.5">
        {spaces.length === 0 && (
          <div className="px-3 py-8 text-center">
            <IconFolderPlus className="mx-auto" size={22} stroke={1.2} style={{ color: colors.quartzDim }} />
            <p className="mt-2 text-xs" style={{ color: colors.quartz }}>
              Open a folder to start
            </p>
            <button
              type="button"
              onClick={() => void openFolder()}
              disabled={!ready}
              aria-label="Open a folder to start"
              className="mt-3 cursor-pointer rounded-lg border px-3 py-1.5 text-[10.5px] font-semibold hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
              style={{ borderColor: 'var(--color-line-strong)', color: colors.bronzeHot }}
            >
              Open folder
            </button>
          </div>
        )}
        {spaces.map((space) => (
          <SpaceCard
            key={space.id}
            space={space}
            gitByRoot={gitByRoot}
            collapsed={collapsed[space.id] ?? false}
            active={activeSpaceId === space.id}
            unavailable={!!unavailableRoots[space.root]}
            ready={ready}
            onActivate={() => setActiveSpace(space.id)}
            onToggle={() => setCollapsed((current) => ({ ...current, [space.id]: !current[space.id] }))}
            onContextMenu={(event) => {
              event.preventDefault()
              if (!ready) return
              setMenu({ space, x: event.clientX, y: event.clientY })
            }}
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

      {menu && (
        <div
          className="fixed inset-0 z-50"
          onClick={() => setMenu(null)}
          onContextMenu={(event) => {
            event.preventDefault()
            setMenu(null)
          }}
        >
          <div
            role="menu"
            className="absolute min-w-[160px] rounded-lg border py-1 shadow-xl"
            style={{
              left: Math.min(menu.x, window.innerWidth - 176),
              top: Math.min(menu.y, window.innerHeight - 100),
              background: colors.panel,
              borderColor: 'var(--color-line-strong)'
            }}
            onClick={(event) => event.stopPropagation()}
          >
            <MenuButton label={`Rename ${menu.space.name}`} onClick={() => beginRename(menu.space)}>
              <IconPencil size={13} stroke={1.5} />
              Rename
            </MenuButton>
            <MenuButton label={`Remove ${menu.space.name}`} onClick={() => remove(menu.space)} danger>
              <IconTrash size={13} stroke={1.5} />
              Remove
            </MenuButton>
          </div>
        </div>
      )}

      {renameDraft && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/45"
          onMouseDown={() => setRenameDraft(null)}
        >
          <form
            role="dialog"
            aria-label="Rename space"
            className="w-[320px] rounded-xl border p-4 shadow-2xl"
            style={{ background: colors.panel, borderColor: 'var(--color-line-strong)' }}
            onMouseDown={(event) => event.stopPropagation()}
            onSubmit={(event) => {
              event.preventDefault()
              saveRename()
            }}
          >
            <label htmlFor="space-name" className="text-xs font-semibold" style={{ color: colors.quartz }}>
              Space name
            </label>
            <input
              id="space-name"
              aria-label="Space name"
              autoFocus
              value={renameDraft.name}
              onChange={(event) => setRenameDraft({ ...renameDraft, name: event.target.value })}
              className="mt-2 w-full rounded-lg border px-3 py-2 text-xs outline-none focus:ring-2"
              style={{
                background: colors.card,
                borderColor: 'var(--color-line-strong)',
                color: colors.quartz,
                ['--tw-ring-color' as string]: 'rgba(203,162,90,0.35)'
              }}
            />
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setRenameDraft(null)}
                className="cursor-pointer rounded-lg border px-3 py-1.5 text-[10.5px]"
                style={{ borderColor: 'var(--color-line-strong)', color: colors.quartzDim }}
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={!renameDraft.name.trim()}
                className="cursor-pointer rounded-lg px-3 py-1.5 text-[10.5px] font-semibold disabled:cursor-not-allowed disabled:opacity-40"
                style={{ background: colors.bronze, color: colors.page }}
              >
                Save
              </button>
            </div>
          </form>
        </div>
      )}
    </aside>
  )
}

function MenuButton({
  children,
  label,
  onClick,
  danger = false
}: {
  children: React.ReactNode
  label: string
  onClick(): void
  danger?: boolean
}): JSX.Element {
  return (
    <button
      type="button"
      role="menuitem"
      aria-label={label}
      onClick={onClick}
      className="flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-left text-[11px] hover:bg-[#37332B]"
      style={{ color: danger ? colors.error : colors.quartz }}
    >
      {children}
    </button>
  )
}

function SpaceCard({
  space,
  gitByRoot,
  collapsed,
  active,
  unavailable,
  ready,
  onActivate,
  onToggle,
  onContextMenu
}: {
  space: Space
  gitByRoot: Record<string, GitStatus>
  collapsed: boolean
  active: boolean
  unavailable: boolean
  ready: boolean
  onActivate(): void
  onToggle(): void
  onContextMenu(event: React.MouseEvent): void
}): JSX.Element {
  const git = gitByRoot[space.root]
  const unavailableTitle = unavailable ? `${space.root} is unavailable` : space.root

  return (
    <div
      data-space-name={space.name}
      data-active={active ? 'true' : 'false'}
      onContextMenu={onContextMenu}
      className={`mt-1.5 rounded-xl border px-2.5 py-2 first:mt-0 ${unavailable ? 'opacity-50 grayscale' : ''}`}
      style={{
        background: colors.card + '66',
        borderColor: active ? colors.bronze : 'var(--color-line)'
      }}
      title={unavailableTitle}
    >
      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={onToggle}
          className="cursor-pointer rounded p-0.5 hover:bg-[#37332B]"
          aria-label={`${collapsed ? 'Expand' : 'Collapse'} ${space.name}`}
          style={{ color: colors.quartzDim }}
        >
          {collapsed ? <IconChevronRight size={12} stroke={1.5} /> : <IconChevronDown size={12} stroke={1.5} />}
        </button>
        <button
          type="button"
          onClick={onActivate}
          disabled={unavailable || !ready}
          aria-label={`Activate ${space.name}`}
          aria-current={active ? 'true' : undefined}
          className="flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 px-0.5 text-left disabled:cursor-not-allowed"
        >
          <span className="truncate text-xs font-semibold" style={{ fontFamily: 'var(--font-display)', color: colors.quartz }}>
            {space.name}
          </span>
          {unavailable && <IconAlertTriangle size={12} stroke={1.5} style={{ color: colors.warning }} />}
          <span className="ml-auto">
            <BranchChip git={git} />
          </span>
        </button>
      </div>

      {!collapsed && (
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
      )}
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
      onMouseEnter={(event) => (event.currentTarget.style.background = colors.card)}
      onMouseLeave={(event) => (event.currentTarget.style.background = 'transparent')}
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
    <span className={`flex items-center gap-1 ${small ? 'text-[9px]' : 'text-[10px]'}`} style={{ color: colors.quartzDim }}>
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
