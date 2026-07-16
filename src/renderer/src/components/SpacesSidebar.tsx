import { useEffect, useMemo, useState } from 'react'
import {
  IconAlertTriangle,
  IconArrowDown,
  IconArrowUp,
  IconFolderPlus,
  IconGitBranch,
  IconPencil,
  IconTrash
} from '@tabler/icons-react'
import type { DialogBridge, GitStatus, RunSummary } from '@shared/ipc'
import type { AgentRunDetail, AgentRunState, RunStatus } from '@shared/spawn-plan'
import { cliLabel, cliTint } from '@/lib/cli'
import { colors, statusColor } from '@/lib/tokens'
import { useLaneStore, type ClaudeLaneInfo } from '@/store/laneStore'
import { getRunApi, subscribeRuns, useRunsStore } from '@/store/runsStore'
import { useSpaceStore, type Space } from '@/store/spaceStore'

interface SpaceMenu {
  space: Space
  x: number
  y: number
}

interface RenameDraft {
  space: Space
  name: string
}

interface ScopedRun {
  summary: RunSummary
  status: RunStatus
}

interface DispatchedAgent {
  key: string
  agentId: string
  state: AgentRunState
  detail: AgentRunDetail
}

const AGENT_STATE_COLOR: Record<AgentRunState, string> = {
  queued: colors.quartzDim,
  spawning: colors.bronze,
  running: colors.working,
  blocked: colors.blocked,
  'rate-limited': colors.warning,
  review: colors.bronzeHot,
  done: colors.done,
  failed: colors.error,
  cancelled: colors.quartzDim
}

function dialogBridge(): DialogBridge | undefined {
  return (window as unknown as { morzDialog?: DialogBridge }).morzDialog
}

function normalizedPath(value: string): string {
  const normalized = value.trim().replace(/\//g, '\\').replace(/\\+$/, '')
  return normalized.toLocaleLowerCase()
}

function parentPath(value: string): string {
  const normalized = normalizedPath(value)
  const separator = normalized.lastIndexOf('\\')
  return separator < 0 ? '' : normalized.slice(0, separator)
}

function baseName(value: string): string {
  const normalized = normalizedPath(value)
  const separator = normalized.lastIndexOf('\\')
  return separator < 0 ? normalized : normalized.slice(separator + 1)
}

function pathIsInside(root: string, candidate: string): boolean {
  const normalizedRoot = normalizedPath(root)
  const normalizedCandidate = normalizedPath(candidate)
  return (
    normalizedRoot.length > 0 &&
    (normalizedCandidate === normalizedRoot || normalizedCandidate.startsWith(`${normalizedRoot}\\`))
  )
}

/*
 * RunStatus does not expose spaceRoot. Dispatcher-created worktrees are real
 * sibling directories named <runTag>-<agentId>, so that contract is the only
 * honest renderer-side association available without adding a new IPC.
 */
function runBelongsToSpace(summary: RunSummary, status: RunStatus, root: string): boolean {
  const expectedParent = parentPath(root)
  const expectedPrefix = `${summary.runTag.toLocaleLowerCase()}-`
  return Object.values(status.agentsDetail ?? {}).some((detail) => {
    if (!detail.worktree) return false
    return (
      parentPath(detail.worktree) === expectedParent &&
      baseName(detail.worktree).startsWith(expectedPrefix)
    )
  })
}

function shortPath(value: string): string {
  const parts = value.split(/[\\/]/).filter(Boolean)
  return parts.slice(-2).join('\\')
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
  const lanes = useLaneStore((state) => state.lanes)
  const runs = useRunsStore((state) => state.runs)
  const statuses = useRunsStore((state) => state.statuses)
  const ingestRun = useRunsStore((state) => state.ingest)
  const [menu, setMenu] = useState<SpaceMenu | null>(null)
  const [renameDraft, setRenameDraft] = useState<RenameDraft | null>(null)
  const [pickerError, setPickerError] = useState<string | null>(null)

  useEffect(() => {
    startWatching()
  }, [spaces, startWatching])

  useEffect(() => subscribeRuns(), [])

  /* Hydrate every ledger row so the sidebar is not limited to the Runs tab selection. */
  useEffect(() => {
    const api = getRunApi()
    if (!api) return
    let cancelled = false
    for (const run of runs) {
      if (useRunsStore.getState().statuses[run.runId]) continue
      void api
        .runStatus(run.runId)
        .then((status) => {
          if (!cancelled && status) ingestRun(status)
        })
        .catch(() => undefined)
    }
    return () => {
      cancelled = true
    }
  }, [ingestRun, runs])

  const activeSpace = spaces.find((space) => space.id === activeSpaceId)
  const activeRoot = activeSpace?.root ?? ''
  const activeGit = activeSpace ? gitByRoot[activeSpace.root] : undefined
  const activeLanes = useMemo(
    () => lanes.filter((lane) => pathIsInside(activeRoot, lane.cwd)),
    [activeRoot, lanes]
  )
  const activeRuns = useMemo<ScopedRun[]>(
    () =>
      runs.flatMap((summary) => {
        const status = statuses[summary.runId]
        return status && runBelongsToSpace(summary, status, activeRoot)
          ? [{ summary, status }]
          : []
      }),
    [activeRoot, runs, statuses]
  )
  const dispatchedAgents = useMemo<DispatchedAgent[]>(
    () =>
      activeRuns.flatMap(({ summary, status }) =>
        Object.entries(status.agents).flatMap(([agentId, state]) => {
          const detail = status.agentsDetail?.[agentId]
          return detail ? [{ key: `${summary.runId}:${agentId}`, agentId, state, detail }] : []
        })
      ),
    [activeRuns]
  )
  const worktrees = useMemo(() => {
    const byPath = new Map<string, { path: string; branch: string }>()
    for (const agent of dispatchedAgents) {
      if (agent.detail.worktree) {
        byPath.set(normalizedPath(agent.detail.worktree), {
          path: agent.detail.worktree,
          branch: agent.detail.branch
        })
      }
    }
    return [...byPath.values()]
  }, [dispatchedAgents])

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
      aria-label="Spaces sidebar"
      className="flex w-[248px] shrink-0 flex-col overflow-hidden border-r"
      style={{ background: colors.panel, borderColor: 'var(--color-line)' }}
    >
      <div className="min-h-0 flex-1 overflow-y-auto">
        <section aria-label="Active space details" className="px-3 pb-3 pt-3">
          <SectionLabel>Active space</SectionLabel>
          {activeSpace ? (
            <ActiveSpaceDetails
              space={activeSpace}
              git={activeGit}
              lanes={activeLanes}
              agents={dispatchedAgents}
              worktrees={worktrees}
            />
          ) : (
            <p className="rounded-lg border px-3 py-4 text-[10.5px]" style={emptyStateStyle}>
              Open an available space to see its working state.
            </p>
          )}
        </section>

        <section
          aria-label="Space list"
          className="border-t px-2 pb-3 pt-3"
          style={{ borderColor: 'var(--color-line)' }}
        >
          <div className="flex items-center justify-between px-2 pb-1">
            <SectionLabel>Spaces</SectionLabel>
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
            <p role="alert" className="px-2 pb-1 text-[10px]" style={{ color: colors.error }}>
              {pickerError}
            </p>
          )}

          {spaces.length === 0 && (
            <div className="px-3 py-8 text-center">
              <IconFolderPlus
                className="mx-auto"
                size={22}
                stroke={1.2}
                style={{ color: colors.quartzDim }}
              />
              <p className="mt-2 text-xs" style={{ color: colors.quartz }}>
                Open a folder to start
              </p>
            </div>
          )}

          <div className="space-y-1.5 pt-1">
            {spaces.map((space) => (
              <SpaceCard
                key={space.id}
                space={space}
                git={gitByRoot[space.root]}
                active={activeSpaceId === space.id}
                unavailable={!!unavailableRoots[space.root]}
                ready={ready}
                onActivate={() => setActiveSpace(space.id)}
                onContextMenu={(event) => {
                  event.preventDefault()
                  if (!ready) return
                  setMenu({ space, x: event.clientX, y: event.clientY })
                }}
              />
            ))}
          </div>
        </section>
      </div>

      <div className="shrink-0 border-t px-4 py-2" style={{ borderColor: 'var(--color-line)' }}>
        <div className="flex flex-wrap gap-x-3 gap-y-1 text-[10px]" style={{ color: colors.quartzDim }}>
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

const emptyStateStyle = {
  background: colors.card + '66',
  borderColor: 'var(--color-line)',
  color: colors.quartzDim
}

function SectionLabel({ children }: { children: React.ReactNode }): JSX.Element {
  return (
    <h2 className="mb-1.5 text-[10px] uppercase tracking-wider" style={{ color: colors.quartzDim }}>
      {children}
    </h2>
  )
}

function ActiveSpaceDetails({
  space,
  git,
  lanes,
  agents,
  worktrees
}: {
  space: Space
  git: GitStatus | undefined
  lanes: ClaudeLaneInfo[]
  agents: DispatchedAgent[]
  worktrees: { path: string; branch: string }[]
}): JSX.Element {
  const empty = lanes.length === 0 && agents.length === 0
  return (
    <div className="rounded-xl border p-2.5" style={{ background: colors.card + '66', borderColor: colors.bronze }}>
      <div className="min-w-0">
        <h3
          className="truncate text-xs font-bold"
          style={{ color: colors.quartz, fontFamily: 'var(--font-display)' }}
        >
          {space.name}
        </h3>
        <p className="mt-0.5 truncate font-mono text-[8.5px]" style={{ color: colors.quartzDim }} title={space.root}>
          {space.root}
        </p>
      </div>

      <div className="mt-2 rounded-lg border px-2 py-1.5" style={{ borderColor: 'var(--color-line)' }}>
        <p className="text-[8.5px] uppercase tracking-wider" style={{ color: colors.quartzDim }}>
          Repository
        </p>
        <div className="mt-1" data-testid="active-space-branch">
          <BranchChip git={git} />
        </div>
      </div>

      {worktrees.length > 0 && (
        <DetailSection label="Worktrees">
          {worktrees.map((worktree) => (
            <WorktreeRow key={normalizedPath(worktree.path)} {...worktree} />
          ))}
        </DetailSection>
      )}

      {lanes.length > 0 && (
        <DetailSection label="Lanes">
          {lanes.map((lane) => (
            <LaneRow key={lane.paneId} lane={lane} git={git} />
          ))}
        </DetailSection>
      )}

      {agents.length > 0 && (
        <DetailSection label="Dispatched agents">
          {agents.map((agent) => (
            <AgentRow key={agent.key} agent={agent} />
          ))}
        </DetailSection>
      )}

      {empty && (
        <p className="mt-2 rounded-lg border px-2 py-3 text-center text-[10px]" style={emptyStateStyle}>
          No agents running here yet
        </p>
      )}
    </div>
  )
}

function DetailSection({ children, label }: { children: React.ReactNode; label: string }): JSX.Element {
  return (
    <section className="mt-2">
      <h4 className="mb-1 text-[8.5px] uppercase tracking-wider" style={{ color: colors.quartzDim }}>
        {label}
      </h4>
      <div className="space-y-1">{children}</div>
    </section>
  )
}

function WorktreeRow({ path, branch }: { path: string; branch: string }): JSX.Element {
  return (
    <div className="rounded-lg border px-2 py-1.5" style={{ borderColor: 'var(--color-line)' }} title={path}>
      <span className="flex items-center gap-1 font-mono text-[9px]" style={{ color: colors.quartz }}>
        <IconGitBranch size={10} stroke={1.5} />
        <span className="truncate">{branch}</span>
      </span>
      <span className="mt-0.5 block truncate font-mono text-[8px]" style={{ color: colors.quartzDim }}>
        {shortPath(path)}
      </span>
    </div>
  )
}

function LaneRow({ lane, git }: { lane: ClaudeLaneInfo; git: GitStatus | undefined }): JSX.Element {
  return (
    <div className="rounded-lg border px-2 py-1.5" style={{ borderColor: 'var(--color-line)' }} title={lane.cwd}>
      <div className="flex min-w-0 items-center gap-1.5">
        <span className="size-1.5 shrink-0 rounded-full" style={{ background: colors.working }} />
        <span className="min-w-0 flex-1 truncate text-[10px]" style={{ color: colors.quartz }}>
          {lane.agentId}
        </span>
        <CliBadge cli="claude" />
      </div>
      <p className="mt-0.5 truncate font-mono text-[8px]" style={{ color: colors.quartzDim }}>
        {git?.branch ?? 'branch unavailable'} · {shortPath(lane.cwd)}
      </p>
    </div>
  )
}

function AgentRow({ agent }: { agent: DispatchedAgent }): JSX.Element {
  const tint = AGENT_STATE_COLOR[agent.state]
  return (
    <div
      className="rounded-lg border px-2 py-1.5"
      style={{ borderColor: 'var(--color-line)' }}
      title={agent.detail.worktree ?? agent.detail.branch}
    >
      <div className="flex min-w-0 items-center gap-1.5">
        <span className="size-1.5 shrink-0 rounded-full" style={{ background: tint }} />
        <span className="min-w-0 flex-1 truncate text-[10px]" style={{ color: colors.quartz }}>
          {agent.agentId}
        </span>
        <CliBadge cli={agent.detail.cli} />
        <span className="font-mono text-[8px] uppercase" style={{ color: tint }}>
          {agent.state}
        </span>
      </div>
      <p className="mt-0.5 truncate font-mono text-[8px]" style={{ color: colors.quartzDim }}>
        {agent.detail.branch}
        {agent.detail.worktree ? ` · ${shortPath(agent.detail.worktree)}` : ''}
      </p>
    </div>
  )
}

function CliBadge({ cli }: { cli: keyof typeof cliTint }): JSX.Element {
  return (
    <span
      className="shrink-0 rounded-md border px-1.5 py-px text-[8px] font-medium"
      style={{ borderColor: 'var(--color-line-strong)', color: cliTint[cli] }}
    >
      {cliLabel[cli]}
    </span>
  )
}

function SpaceCard({
  space,
  git,
  active,
  unavailable,
  ready,
  onActivate,
  onContextMenu
}: {
  space: Space
  git: GitStatus | undefined
  active: boolean
  unavailable: boolean
  ready: boolean
  onActivate(): void
  onContextMenu(event: React.MouseEvent): void
}): JSX.Element {
  const unavailableTitle = unavailable ? `${space.root} is unavailable` : space.root
  return (
    <div
      data-space-name={space.name}
      data-active={active ? 'true' : 'false'}
      onContextMenu={onContextMenu}
      className={`rounded-xl border px-2.5 py-2 ${unavailable ? 'opacity-50 grayscale' : ''}`}
      style={{ background: colors.card + '66', borderColor: active ? colors.bronze : 'var(--color-line)' }}
      title={unavailableTitle}
    >
      <button
        type="button"
        onClick={onActivate}
        disabled={unavailable || !ready}
        aria-label={`Activate ${space.name}`}
        aria-current={active ? 'true' : undefined}
        className="flex w-full min-w-0 cursor-pointer items-center gap-1.5 text-left disabled:cursor-not-allowed"
      >
        <span
          className="min-w-0 flex-1 truncate text-xs font-semibold"
          style={{ fontFamily: 'var(--font-display)', color: colors.quartz }}
        >
          {space.name}
        </span>
        {unavailable && <IconAlertTriangle size={12} stroke={1.5} style={{ color: colors.warning }} />}
        <BranchChip git={git} small />
      </button>
    </div>
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

function BranchChip({ git, small }: { git: GitStatus | undefined; small?: boolean }): JSX.Element {
  const dirtyCount = git?.files.length ?? 0
  return (
    <span
      className={`flex min-w-0 items-center gap-1 font-mono ${small ? 'text-[8.5px]' : 'text-[9.5px]'}`}
      style={{ color: colors.quartzDim }}
    >
      <IconGitBranch size={small ? 10 : 11} stroke={1.5} />
      <span className={small ? 'max-w-[72px] truncate' : 'max-w-[126px] truncate'}>
        {git?.branch ?? '—'}
      </span>
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
