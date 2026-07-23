import { useEffect, useState } from 'react'
import {
  IconAlertTriangle,
  IconPlayerStop,
  IconRefresh,
  IconTrash,
  IconUsersGroup
} from '@tabler/icons-react'
import type { RunSummary } from '@shared/ipc'
import type { MorzNotifyApi } from '@shared/notify'
import type { AgentRunState, RunState, RunStatus } from '@shared/spawn-plan'
import { colors } from '@/lib/tokens'
import { getRunApi, subscribeRuns, useRunsStore, useSpaceRuns } from '@/store/runsStore'

const TERMINAL_RUN_STATES: readonly RunState[] = ['done', 'aborted']

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

const RUN_STATE_COLOR: Record<RunState, string> = {
  draft: colors.quartzDim,
  proposed: colors.quartzDim,
  approved: colors.bronze,
  dispatching: colors.bronzeHot,
  running: colors.working,
  merging: colors.bronzeHot,
  done: colors.done,
  aborted: colors.error
}

function getNotify(): MorzNotifyApi | undefined {
  return (window as unknown as { morz?: { notify?: MorzNotifyApi } }).morz?.notify
}

function shortPath(path: string | null | undefined): string {
  if (!path) return '—'
  const parts = path.split(/[\\/]/)
  return parts.slice(-2).join('\\')
}

function formatCreated(createdAt: string): string {
  const time = new Date(createdAt)
  return Number.isNaN(time.getTime()) ? createdAt : time.toLocaleString()
}

function notifyFailure(runId: string, action: string, error: unknown): string {
  const detail = error instanceof Error ? error.message : `${action} failed`
  getNotify()?.emit({
    id: `run-${runId}-${action.toLowerCase().replace(/\s+/g, '-')}-failed`,
    level: 'error',
    source: 'dispatch',
    title: `${action} failed`,
    detail
  })
  return detail
}

export function RunsPanel(): JSX.Element {
  const { available, loading, error, statuses, selectedRunId, ingest, selectRun, setError } =
    useRunsStore()
  // w14/orch-scoped — the panel sees only the active space's runs
  const runs = useSpaceRuns()
  const [action, setAction] = useState<'stop' | 'cleanup' | null>(null)

  useEffect(() => subscribeRuns(), [])

  if (!available) {
    return (
      <EmptyState
        icon={<IconAlertTriangle size={20} stroke={1.5} />}
        title="Orchestration unavailable"
        detail="This build does not expose the run monitor bridge."
      />
    )
  }

  if (loading && runs.length === 0) {
    return (
      <EmptyState
        icon={<IconRefresh className="animate-spin" size={20} stroke={1.5} />}
        title="Loading runs"
        detail="Reading the orchestration ledger…"
      />
    )
  }

  if (!loading && runs.length === 0 && !error) {
    return (
      <EmptyState
        icon={<IconUsersGroup size={20} stroke={1.5} />}
        title="No runs yet"
        detail="Dispatch an approved plan and its live team will appear here."
      />
    )
  }

  const selected = runs.find((run) => run.runId === selectedRunId) ?? runs[0]
  const status = selected ? statuses[selected.runId] : undefined

  const stop = async (): Promise<void> => {
    if (
      !selected ||
      !window.confirm(`Stop ${selected.runTag}? This kills every agent process.`)
    ) {
      return
    }
    const api = getRunApi()
    if (!api) return
    setAction('stop')
    setError(null)
    try {
      const next = await api.stopRun(selected.runId)
      ingest(next)
      const killed = Object.values(next.agents).filter((state) => state === 'cancelled').length
      getNotify()?.emit({
        id: `run-${selected.runId}-stopped`,
        level: 'success',
        source: 'dispatch',
        title: `Run stopped, ${killed} agent${killed === 1 ? '' : 's'} killed`
      })
    } catch (reason) {
      setError(notifyFailure(selected.runId, 'Stop run', reason))
    } finally {
      setAction(null)
    }
  }

  const cleanup = async (): Promise<void> => {
    if (
      !selected ||
      !window.confirm(`Cleanup ${selected.runTag}? This removes its worktrees and branches.`)
    ) {
      return
    }
    const api = getRunApi()
    if (!api) return
    const count = Object.values(status?.agentsDetail ?? {}).filter((detail) => detail.worktree).length
    setAction('cleanup')
    setError(null)
    try {
      const next = await api.cleanup(selected.runId)
      ingest(next)
      getNotify()?.emit({
        id: `run-${selected.runId}-cleaned`,
        level: 'success',
        source: 'dispatch',
        title: 'Run cleanup complete',
        detail: `${count} worktree${count === 1 ? '' : 's'} removed`
      })
    } catch (reason) {
      setError(notifyFailure(selected.runId, 'Cleanup run', reason))
    } finally {
      setAction(null)
    }
  }

  return (
    <section className="flex min-h-0 flex-1 flex-col" aria-label="Runs monitor">
      {error && (
        <div
          className="border-b px-3 py-2 text-[10px]"
          style={{ borderColor: 'var(--color-line)', color: colors.error }}
          role="alert"
        >
          {error}
        </div>
      )}

      <div
        className="max-h-[168px] shrink-0 space-y-1 overflow-y-auto border-b p-2"
        style={{ borderColor: 'var(--color-line)' }}
      >
        {runs.map((run) => {
          const active = run.runId === selected?.runId
          const tint = RUN_STATE_COLOR[run.state]
          return (
            <button
              key={run.runId}
              type="button"
              onClick={() => selectRun(run.runId)}
              className="w-full rounded-lg border px-2.5 py-2 text-left transition-colors"
              style={{
                background: active ? colors.card : 'transparent',
                borderColor: active ? `${tint}99` : 'var(--color-line)'
              }}
              aria-pressed={active}
            >
              <span className="flex items-center gap-1.5">
                <span className="size-2 shrink-0 rounded-full" style={{ background: tint }} />
                <span
                  className="min-w-0 flex-1 truncate text-[10.5px] font-semibold"
                  style={{ color: colors.quartz }}
                >
                  {run.goal}
                </span>
                <span className="shrink-0 font-mono text-[8.5px] uppercase" style={{ color: tint }}>
                  {run.state}
                </span>
              </span>
              <span
                className="mt-1 flex items-center justify-between gap-2 font-mono text-[8.5px]"
                style={{ color: colors.quartzDim }}
              >
                <span className="truncate">{run.runTag}</span>
                <time className="shrink-0" dateTime={run.createdAt}>
                  {formatCreated(run.createdAt)}
                </time>
              </span>
            </button>
          )
        })}
      </div>

      {selected && (
        <RunDetail
          summary={selected}
          status={status}
          action={action}
          onStop={() => void stop()}
          onCleanup={() => void cleanup()}
        />
      )}
    </section>
  )
}

function RunDetail({
  summary,
  status,
  action,
  onStop,
  onCleanup
}: {
  summary: RunSummary
  status?: RunStatus
  action: 'stop' | 'cleanup' | null
  onStop(): void
  onCleanup(): void
}): JSX.Element {
  const terminal = TERMINAL_RUN_STATES.includes(status?.state ?? summary.state)
  const details = status?.agentsDetail ?? {}
  const agents = Object.entries(status?.agents ?? {})
  const hasWorktrees = Object.values(details).some((detail) => detail.worktree)

  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-3">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <h2
            className="text-xs font-bold leading-snug"
            style={{ color: colors.quartz, fontFamily: 'var(--font-display)' }}
          >
            {summary.goal}
          </h2>
          <p
            className="mt-0.5 truncate font-mono text-[9px]"
            style={{ color: colors.quartzDim }}
            title={summary.runId}
          >
            {summary.runTag}
          </p>
        </div>
        <span
          className="rounded px-1.5 py-0.5 font-mono text-[8.5px] font-bold uppercase"
          style={{
            color: RUN_STATE_COLOR[status?.state ?? summary.state],
            background: `${RUN_STATE_COLOR[status?.state ?? summary.state]}1f`
          }}
        >
          {status?.state ?? summary.state}
        </span>
      </div>

      {!status && (
        <p className="mt-4 text-[10px]" style={{ color: colors.quartzDim }}>
          Loading agent detail…
        </p>
      )}

      {status && agents.length === 0 && (
        <p className="mt-4 text-[10px]" style={{ color: colors.quartzDim }}>
          No agents recorded.
        </p>
      )}

      {agents.length > 0 && (
        <div className="mt-3 space-y-1.5">
          {agents.map(([agentId, state]) => {
            const detail = details[agentId]
            const tint = AGENT_STATE_COLOR[state]
            return (
              <article
                key={agentId}
                className="rounded-lg border p-2.5"
                style={{ background: colors.card + '99', borderColor: 'var(--color-line)' }}
                data-testid="run-agent"
                data-agent-state={state}
              >
                <div className="flex items-center gap-1.5">
                  <span
                    className="size-2 shrink-0 rounded-full"
                    style={{ background: tint, boxShadow: `0 0 7px ${tint}55` }}
                  />
                  <span
                    className="min-w-0 flex-1 truncate font-mono text-[10.5px] font-semibold"
                    style={{ color: colors.quartz }}
                  >
                    {agentId}
                  </span>
                  <span className="font-mono text-[8.5px] uppercase" style={{ color: colors.quartzDim }}>
                    {detail?.cli ?? '—'}
                  </span>
                  <span
                    className="rounded px-1.5 py-px font-mono text-[8.5px] uppercase"
                    style={{ color: tint, background: `${tint}1f` }}
                  >
                    {state}
                  </span>
                </div>
                <dl className="mt-2 grid grid-cols-[42px_minmax(0,1fr)] gap-x-2 gap-y-0.5 font-mono text-[8.5px] leading-relaxed">
                  <dt style={{ color: colors.quartzDim }}>pane</dt>
                  <dd className="truncate" style={{ color: colors.quartz }} title={detail?.paneId}>
                    {detail?.paneId || '—'}
                  </dd>
                  <dt style={{ color: colors.quartzDim }}>branch</dt>
                  <dd className="truncate" style={{ color: colors.quartz }} title={detail?.branch}>
                    {detail?.branch ?? '—'}
                  </dd>
                  <dt style={{ color: colors.quartzDim }}>port</dt>
                  <dd style={{ color: colors.quartz }}>{detail?.port ?? '—'}</dd>
                  <dt style={{ color: colors.quartzDim }}>tree</dt>
                  <dd
                    className="truncate"
                    style={{ color: colors.quartz }}
                    title={detail?.worktree ?? undefined}
                  >
                    {shortPath(detail?.worktree)}
                  </dd>
                </dl>
              </article>
            )
          })}
        </div>
      )}

      {status && (
        <div className="mt-3 border-t pt-3" style={{ borderColor: 'var(--color-line)' }}>
          {!terminal && (
            <button
              type="button"
              onClick={onStop}
              disabled={action !== null}
              className="flex w-full items-center justify-center gap-1.5 rounded-md px-2.5 py-1.5 text-[10.5px] font-bold disabled:opacity-40"
              style={{ background: colors.error, color: colors.quartz }}
              aria-label="Stop run"
            >
              <IconPlayerStop size={13} stroke={1.8} />
              {action === 'stop' ? 'Stopping…' : 'Stop'}
            </button>
          )}
          {terminal && hasWorktrees && (
            <button
              type="button"
              onClick={onCleanup}
              disabled={action !== null}
              className="flex w-full items-center justify-center gap-1.5 rounded-md border px-2.5 py-1.5 text-[10.5px] font-bold disabled:opacity-40"
              style={{ borderColor: 'var(--color-line-strong)', color: colors.quartz }}
              aria-label="Cleanup run"
            >
              <IconTrash size={13} stroke={1.8} />
              {action === 'cleanup' ? 'Cleaning…' : 'Cleanup'}
            </button>
          )}
          {terminal && !hasWorktrees && (
            <p className="text-center text-[10px]" style={{ color: colors.done }}>
              Worktrees cleaned
            </p>
          )}
        </div>
      )}
    </div>
  )
}

function EmptyState({
  icon,
  title,
  detail
}: {
  icon: React.ReactNode
  title: string
  detail: string
}): JSX.Element {
  return (
    <div
      className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center"
      style={{ color: colors.quartzDim }}
    >
      {icon}
      <p
        className="text-xs font-semibold"
        style={{ color: colors.quartz, fontFamily: 'var(--font-display)' }}
      >
        {title}
      </p>
      <p className="max-w-[230px] text-[10.5px] leading-relaxed">{detail}</p>
    </div>
  )
}
