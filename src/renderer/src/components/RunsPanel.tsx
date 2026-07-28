import { useEffect, useState } from 'react'
import {
  IconAlertTriangle,
  IconPlayerStop,
  IconRefresh,
  IconTrash,
  IconX,
  IconUsersGroup
} from '@tabler/icons-react'
import type { ClearedRun, RunHistoryBridge, RunSummary } from '@shared/ipc'
import type { MorzNotifyApi } from '@shared/notify'
import type { AgentActivity } from '@shared/agent-title-status'
import type { AgentRunState, RunState, RunStatus } from '@shared/spawn-plan'
import { colors } from '@/lib/tokens'
import {
  getRunApi,
  getLaunchRunHistoryPolicy,
  RUN_HISTORY_POLICIES,
  subscribeRuns,
  useRunsStore,
  useSpaceRuns,
  type RunHistoryPolicy
} from '@/store/runsStore'
import { selectActiveSpaceRoot, useSpaceStore } from '@/store/spaceStore'

const TERMINAL_RUN_STATES: readonly RunState[] = ['done', 'aborted']
const appliedHistoryRoots = new Set<string>()
const launchHistoryPolicy = getLaunchRunHistoryPolicy()

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

/* w17/adapter-seam — what the CLI is doing right now, observed from its own
 * terminal titles. Separate from the lifecycle state: an agent can be `running`
 * in the ledger while its activity is `waiting` on the owner's approval. */
const ACTIVITY_COLOR: Record<AgentActivity, string> = {
  working: colors.working,
  waiting: colors.blocked,
  idle: colors.quartzDim
}

const ACTIVITY_LABEL: Record<AgentActivity, string> = {
  working: 'working',
  waiting: 'waiting for you',
  idle: 'idle'
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

function getRunClearApi(): RunHistoryBridge | undefined {
  const api = (window as unknown as { morzRunHistory?: RunHistoryBridge }).morzRunHistory
  return api &&
    typeof api.clearRun === 'function' &&
    typeof api.clearFinished === 'function' &&
    typeof api.applyPolicy === 'function'
    ? api
    : undefined
}

function announceCleared(results: readonly ClearedRun[], title: string): void {
  const retained = results.filter((result) => result.hasWorktrees).length
  getNotify()?.emit({
    id: `runs-cleared-${Date.now()}`,
    level: 'success',
    source: 'dispatch',
    title,
    detail:
      retained > 0
        ? `${retained} cleared run${retained === 1 ? '' : 's'} still ${retained === 1 ? 'has' : 'have'} worktrees; cleanup remains separate.`
        : undefined
  })
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
  const {
    available,
    loading,
    error,
    statuses,
    selectedRunId,
    historyPolicy,
    ingest,
    selectRun,
    evictRuns,
    setHistoryPolicy,
    setError
  } = useRunsStore()
  const activeSpaceRoot = useSpaceStore(selectActiveSpaceRoot)
  // w14/orch-scoped — the panel sees only the active space's runs
  const runs = useSpaceRuns()
  const [action, setAction] = useState<'stop' | 'cleanup' | null>(null)
  const [historyAction, setHistoryAction] = useState<'clear' | 'clear-finished' | 'policy' | null>(
    null
  )

  useEffect(() => subscribeRuns(), [])
  useEffect(() => {
    if (loading || !activeSpaceRoot || appliedHistoryRoots.has(activeSpaceRoot)) return
    const api = getRunClearApi()
    if (!api) return
    if (launchHistoryPolicy === 'forever') {
      appliedHistoryRoots.add(activeSpaceRoot)
      return
    }
    // Reserve the root before awaiting IPC so live run updates cannot start a
    // concurrent policy pass. Failures release it in catch for a later retry.
    appliedHistoryRoots.add(activeSpaceRoot)

    const applyPolicy = async (): Promise<void> => {
      setHistoryAction('policy')
      setError(null)
      try {
        const results = await api.applyPolicy(activeSpaceRoot, launchHistoryPolicy)
        evictRuns(results.map((result) => result.runId))
        if (results.length > 0) announceCleared(results, 'Run history policy applied')
      } catch (reason) {
        appliedHistoryRoots.delete(activeSpaceRoot)
        setError(notifyFailure('history', 'Apply run history policy', reason))
      } finally {
        setHistoryAction(null)
      }
    }
    void applyPolicy()
  }, [activeSpaceRoot, evictRuns, loading, runs, setError, launchHistoryPolicy])

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

  const empty = !loading && runs.length === 0 && !error
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

  const clear = async (): Promise<void> => {
    if (!selected || !status || !TERMINAL_RUN_STATES.includes(status.state)) return
    const hasWorktrees = Object.values(status.agentsDetail ?? {}).some((detail) => detail.worktree)
    const warning = hasWorktrees
      ? ' Its worktrees and branches will remain. Use Cleanup first if you want them removed.'
      : ''
    if (!window.confirm(`Clear ${selected.runTag} from history?${warning}`)) return
    const api = getRunClearApi()
    if (!api) return
    setHistoryAction('clear')
    setError(null)
    try {
      const result = await api.clearRun(selected.runId)
      evictRuns([result.runId])
      announceCleared([result], 'Run cleared from history')
    } catch (reason) {
      setError(notifyFailure(selected.runId, 'Clear run', reason))
    } finally {
      setHistoryAction(null)
    }
  }

  const clearFinished = async (): Promise<void> => {
    const count = runs.filter((run) => TERMINAL_RUN_STATES.includes(run.state)).length
    if (
      count === 0 ||
      !activeSpaceRoot ||
      !window.confirm(
        `Clear ${count} finished run${count === 1 ? '' : 's'} from this space's history? Worktrees and branches will remain until explicitly cleaned.`
      )
    ) {
      return
    }
    const api = getRunClearApi()
    if (!api) return
    setHistoryAction('clear-finished')
    setError(null)
    try {
      const results = await api.clearFinished(activeSpaceRoot)
      evictRuns(results.map((result) => result.runId))
      announceCleared(results, `${results.length} finished run${results.length === 1 ? '' : 's'} cleared`)
    } catch (reason) {
      setError(notifyFailure('history', 'Clear finished runs', reason))
    } finally {
      setHistoryAction(null)
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
        className="flex shrink-0 items-center gap-2 border-b px-2 py-1.5"
        style={{ borderColor: 'var(--color-line)' }}
      >
        <label className="flex min-w-0 flex-1 items-center gap-1.5">
          <span className="shrink-0 text-[9px] font-semibold" style={{ color: colors.quartzDim }}>
            History
          </span>
          <select
            aria-label="Run history policy"
            value={historyPolicy}
            onChange={(event) => setHistoryPolicy(event.target.value as RunHistoryPolicy)}
            className="min-w-0 flex-1 rounded border bg-transparent px-1.5 py-1 text-[9px] outline-none focus-visible:ring-1"
            style={{ borderColor: 'var(--color-line-strong)', color: colors.quartz }}
            title="Saved now; applied when this space is loaded on the next launch"
          >
            {RUN_HISTORY_POLICIES.map((policy) => (
              <option key={policy.value} value={policy.value}>
                {policy.label}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          onClick={() => void clearFinished()}
          disabled={
            historyAction !== null ||
            !activeSpaceRoot ||
            !runs.some((run) => TERMINAL_RUN_STATES.includes(run.state))
          }
          className="shrink-0 rounded border px-2 py-1 text-[9px] font-semibold disabled:opacity-40"
          style={{ borderColor: 'var(--color-line-strong)', color: colors.quartz }}
        >
          {historyAction === 'clear-finished' ? 'Clearing…' : 'Clear finished'}
        </button>
      </div>

      {empty ? (
        <EmptyState
          icon={<IconUsersGroup size={20} stroke={1.5} />}
          title="No runs yet"
          detail="Dispatch an approved plan and its live team will appear here."
        />
      ) : (
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
      )}

      {!empty && selected && (
        <RunDetail
          summary={selected}
          status={status}
          action={action}
          historyAction={historyAction}
          onStop={() => void stop()}
          onCleanup={() => void cleanup()}
          onClear={() => void clear()}
        />
      )}
    </section>
  )
}

function RunDetail({
  summary,
  status,
  action,
  historyAction,
  onStop,
  onCleanup,
  onClear
}: {
  summary: RunSummary
  status?: RunStatus
  action: 'stop' | 'cleanup' | null
  historyAction: 'clear' | 'clear-finished' | 'policy' | null
  onStop(): void
  onCleanup(): void
  onClear(): void
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
                {detail?.activity && (
                  <p
                    className="mt-1.5 flex items-center gap-1 text-[9px]"
                    style={{ color: ACTIVITY_COLOR[detail.activity] }}
                    data-testid="agent-activity"
                    data-activity={detail.activity}
                    title="Observed from this pane's terminal title"
                  >
                    <span
                      className="size-1.5 shrink-0 rounded-full"
                      style={{ background: ACTIVITY_COLOR[detail.activity] }}
                    />
                    {ACTIVITY_LABEL[detail.activity]}
                  </p>
                )}
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

      {status && (status.usage.tokens !== null || status.usage.usd !== null) && (
        <dl
          className="mt-3 flex items-center gap-3 border-t pt-2 font-mono text-[8.5px]"
          style={{ borderColor: 'var(--color-line)' }}
          data-testid="run-usage"
        >
          {status.usage.tokens !== null && (
            <div className="flex items-center gap-1">
              <dt style={{ color: colors.quartzDim }}>tokens</dt>
              <dd style={{ color: colors.quartz }} data-testid="run-usage-tokens">
                {status.usage.tokens.toLocaleString()}
                {status.usage.partial ? '+' : ''}
              </dd>
            </div>
          )}
          {status.usage.usd !== null && (
            <div className="flex items-center gap-1">
              <dt style={{ color: colors.quartzDim }}>usd</dt>
              <dd style={{ color: colors.quartz }}>{status.usage.usd.toFixed(4)}</dd>
            </div>
          )}
          {status.usage.partial && (
            <span
              style={{ color: colors.warning }}
              data-testid="run-usage-partial"
              title="A transcript read was abandoned during teardown, so the real figure is higher."
            >
              at least
            </span>
          )}
        </dl>
      )}

      {status && (
        <div className="mt-3 space-y-2 border-t pt-3" style={{ borderColor: 'var(--color-line)' }}>
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
          {terminal && (
            <button
              type="button"
              onClick={onClear}
              disabled={action !== null || historyAction !== null}
              className="flex w-full items-center justify-center gap-1.5 rounded-md px-2.5 py-1.5 text-[10.5px] font-bold disabled:opacity-40"
              style={{ background: `${colors.quartzDim}22`, color: colors.quartz }}
              aria-label="Clear run"
              title="Remove from history only; worktree cleanup remains separate"
            >
              <IconX size={13} stroke={1.8} />
              {historyAction === 'clear' ? 'Clearing…' : 'Clear'}
            </button>
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
