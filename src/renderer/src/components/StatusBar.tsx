import { IconGitBranch } from '@tabler/icons-react'
import { useEffect } from 'react'
import { colors, statusColor } from '@/lib/tokens'
import { useCostStore } from '@/store/costStore'
import { useLaneStore } from '@/store/laneStore'
import { useLayoutStore } from '@/store/layoutStore'
import { subscribeRuns, useRunsStore } from '@/store/runsStore'
import { useSpaceStore } from '@/store/spaceStore'
import type { CostRunMeter, CostUsageTotals } from '@shared/ipc'
import { ModeDialCompact } from './ModeDialCompact'
import { NotificationCenter } from './NotificationCenter'

interface StatusBarProps {
  onOpenCommit?: () => void
}

/*
 * Bottom status bar (w15 premium), three groups: left context (branch/dirty,
 * panes · lanes, live-agents count) — CENTER the autonomy dial — right cost
 * and token meters + notification bell. Unknown usage stays explicitly unknown.
 */
export function StatusBar({ onOpenCommit }: StatusBarProps): JSX.Element {
  const snapshot = useCostStore((state) => state.snapshot)
  const breach = useCostStore((state) => state.breach)
  const startCostMeter = useCostStore((state) => state.start)
  const resume = useCostStore((state) => state.resume)
  const stop = useCostStore((state) => state.stop)
  const lanes = useLaneStore((state) => state.lanes)
  const panes = useLayoutStore((state) => state.panes)
  const statuses = useRunsStore((state) => state.statuses)
  /* w15/shell-layout — track the ACTIVE space (the old spaces[0] pick predates
   * real space switching and shows the wrong branch after a tab change). */
  const activeRoot = useSpaceStore(
    (state) => state.spaces.find((s) => s.id === state.activeSpaceId)?.root ?? ''
  )
  const git = useSpaceStore((state) => state.gitByRoot[activeRoot])

  useEffect(() => startCostMeter(), [startCostMeter])
  useEffect(() => subscribeRuns(), [])

  const agentStates = Object.values(statuses).flatMap((status) => Object.values(status.agents))
  const activeAgents =
    lanes.length + agentStates.filter((state) => ['spawning', 'running', 'review'].includes(state)).length
  const dirty = (git?.files.length ?? 0) > 0
  const branchLabel = git
    ? `${git.branch ?? 'detached'}${git.ahead ? ` ↑${git.ahead}` : ''}${git.behind ? ` ↓${git.behind}` : ''}`
    : 'Branch unavailable'

  return (
    <>
      {breach && (
        <aside
          className="fixed bottom-9 left-1/2 z-50 flex -translate-x-1/2 items-center gap-3 rounded-md border px-3 py-2 text-xs shadow-xl"
          style={{ background: colors.card, borderColor: colors.error, color: colors.quartz }}
          role="alert"
          aria-live="assertive"
        >
          <span className="size-2 shrink-0 rounded-full" style={{ background: colors.error }} />
          <strong className="whitespace-nowrap font-medium">Run paused: cost cap reached</strong>
          <button
            className="whitespace-nowrap rounded border px-2 py-1 font-mono text-[10px] hover:brightness-125 focus-visible:outline focus-visible:outline-2"
            style={{ borderColor: colors.bronze, color: colors.bronzeHot }}
            onClick={() => void resume()}
          >
            Resume (raises cap 25%)
          </button>
          <button
            className="rounded border px-2 py-1 font-mono text-[10px] hover:brightness-125 focus-visible:outline focus-visible:outline-2"
            style={{ borderColor: colors.error, color: colors.error }}
            onClick={() => void stop()}
          >
            Stop
          </button>
        </aside>
      )}

      <footer
        className="relative flex h-7 shrink-0 items-center gap-4 border-t px-3.5 text-[11px]"
        style={{
          background: colors.panel,
          borderColor: 'var(--color-line)',
          color: colors.quartzDim
        }}
      >
        {/* w15/integration-slots — with lazygit/gitui chosen there is no Morz
          * commit panel to open, so the branch chip degrades to a label. */}
        {onOpenCommit ? (
          <button
            className="flex cursor-pointer items-center gap-1 font-mono text-[10.5px] hover:brightness-125"
            style={{ color: colors.quartzDim }}
            onClick={onOpenCommit}
            title={dirty ? 'Open commit panel (working tree dirty)' : 'Open commit panel'}
          >
            <IconGitBranch size={11} stroke={1.5} />
            {branchLabel}
            {dirty && (
              <span
                className="size-1.5 rounded-full"
                style={{ background: statusColor.working }}
                aria-label="Working tree dirty"
              />
            )}
          </button>
        ) : (
          <span
            className="flex items-center gap-1 font-mono text-[10.5px]"
            style={{ color: colors.quartzDim }}
          >
            <IconGitBranch size={11} stroke={1.5} />
            {branchLabel}
            {dirty && (
              <span
                className="size-1.5 rounded-full"
                style={{ background: statusColor.working }}
                aria-label="Working tree dirty"
              />
            )}
          </span>
        )}
        <span className="whitespace-nowrap font-mono text-[10px]" data-testid="fleet-count">
          {panes.length} pane{panes.length === 1 ? '' : 's'} · {lanes.length} lane
          {lanes.length === 1 ? '' : 's'}
        </span>
        {activeAgents > 0 && (
          <Count color={statusColor.working} label={`${activeAgents} agent${activeAgents === 1 ? '' : 's'}`} />
        )}

        {/* center group — the autonomy dial owns the middle of the bar */}
        <div className="absolute left-1/2 -translate-x-1/2">
          <ModeDialCompact />
        </div>

        <div className="ml-auto flex min-w-0 items-center gap-3">
          <SessionMeter usage={snapshot?.session ?? null} />
          <RunMeter run={snapshot?.activeRun ?? null} />
          <span className="h-3 w-px" style={{ background: 'var(--color-line)' }} />
          {/* w6/errors: persistent background notices */}
          <NotificationCenter />
        </div>
      </footer>
    </>
  )
}

function formatUsd(value: number | null): string {
  return value === null ? '—' : `$${value.toFixed(value < 0.01 ? 4 : 2)}`
}

function formatTokens(value: number | null): string {
  if (value === null) return '—'
  if (value < 1_000) return `${value} tok`
  const digits = value % 1_000 === 0 ? 0 : 1
  return `${(value / 1_000).toFixed(digits)}k tok`
}

function SessionMeter({ usage }: { usage: CostUsageTotals | null }): JSX.Element {
  const usd = usage?.usd ?? null
  const tokens = usage?.tokens ?? null
  const noData = usd === null && tokens === null
  return (
    <span
      className="whitespace-nowrap font-mono text-[9.5px]"
      style={{ color: colors.quartzDim }}
      data-testid="session-cost-meter"
      title={noData ? 'Session usage: no data' : 'Session cost and token usage'}
    >
      Session {noData ? '—' : `${formatUsd(usd)} · ${formatTokens(tokens)}`}
    </span>
  )
}

function RunMeter({ run }: { run: CostRunMeter | null }): JSX.Element {
  const tokenRatio =
    run?.caps.maxTokens && run.usage.tokens !== null
      ? run.usage.tokens / run.caps.maxTokens
      : null
  const usdRatio =
    run?.caps.maxUsd && run.usage.usd !== null ? run.usage.usd / run.caps.maxUsd : null
  const useTokens =
    tokenRatio !== null
      ? usdRatio === null || tokenRatio >= usdRatio
      : run?.caps.maxTokens !== null && run?.caps.maxUsd === null
  const ratio = useTokens ? tokenRatio : usdRatio
  const percent = ratio === null ? null : Math.min(100, Math.round(ratio * 100))
  const fill = ratio !== null && ratio >= 1 ? colors.error : ratio !== null && ratio >= 0.8 ? colors.bronze : colors.quartzDim
  const noData = !run || (run.usage.usd === null && run.usage.tokens === null)

  return (
    <span
      className="flex items-center gap-1.5 whitespace-nowrap font-mono text-[9.5px]"
      style={{ color: colors.quartzDim }}
      data-testid="active-run-cost-meter"
      title={run ? `Active run ${run.runId}` : 'Active run usage: no data'}
    >
      Run {noData ? '—' : `${formatUsd(run.usage.usd)} · ${formatTokens(run.usage.tokens)}`}
      {run && (run.caps.maxTokens !== null || run.caps.maxUsd !== null) && (
        <span
          className="h-[5px] w-12 overflow-hidden rounded-full"
          style={{ background: 'rgba(238,230,217,0.10)' }}
          role="meter"
          aria-valuenow={percent ?? undefined}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={useTokens ? 'Active run token cap' : 'Active run cost cap'}
          data-testid="active-run-cap-progress"
        >
          <span
            className="block h-full rounded-full transition-[width] duration-150"
            style={{ width: `${percent ?? 0}%`, background: fill }}
          />
        </span>
      )}
    </span>
  )
}

function Count({ color, label }: { color: string; label: string }): JSX.Element {
  return (
    <span className="flex items-center gap-1.5">
      <span className="size-1.5 rounded-full" style={{ background: color }} />
      {label}
    </span>
  )
}
