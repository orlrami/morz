import { IconGitBranch } from '@tabler/icons-react'
import { useEffect } from 'react'
import { cliUsages, cliTint, cliLabel } from '@/lib/mock'
import { colors, statusColor } from '@/lib/tokens'
import { useCostStore } from '@/store/costStore'
import type { CostRunMeter, CostUsageTotals } from '@shared/ipc'
import { ModeDialCompact } from './ModeDialCompact'

interface StatusBarProps {
  onOpenCommit?: () => void
}

/*
 * Bottom status bar: branch, fleet counts, live cost/token usage, per-CLI
 * rate-limit meters, and the control dial. Unknown usage stays explicitly
 * unknown: a grey dash is safer than a fabricated zero.
 */
export function StatusBar({ onOpenCommit }: StatusBarProps): JSX.Element {
  const snapshot = useCostStore((state) => state.snapshot)
  const breach = useCostStore((state) => state.breach)
  const startCostMeter = useCostStore((state) => state.start)
  const resume = useCostStore((state) => state.resume)
  const stop = useCostStore((state) => state.stop)

  useEffect(() => startCostMeter(), [startCostMeter])

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
        className="flex h-7 shrink-0 items-center gap-4 border-t px-3.5 text-[11px]"
        style={{
          background: colors.panel,
          borderColor: 'var(--color-line)',
          color: colors.quartzDim
        }}
      >
        <button
          className="flex cursor-pointer items-center gap-1 font-mono text-[10.5px] hover:brightness-125"
          style={{ color: colors.quartzDim }}
          onClick={onOpenCommit}
          title="Open commit panel"
        >
          <IconGitBranch size={11} stroke={1.5} />
          main ↑2
        </button>
        <Count color={statusColor.working} label="2 working" />
        <Count color={statusColor.blocked} label="1 blocked" />
        <Count color={statusColor.done} label="1 done" />

        <div className="ml-auto flex min-w-0 items-center gap-3">
          <SessionMeter usage={snapshot?.session ?? null} />
          <RunMeter run={snapshot?.activeRun ?? null} />
          <span className="h-3 w-px" style={{ background: 'var(--color-line)' }} />

          {cliUsages.map((usage) => (
            <span
              key={usage.cli}
              className="flex items-center gap-1.5"
              title={`${cliLabel[usage.cli]} ${usage.plan} — ${usage.used}% of window used · resets in ${usage.resetIn}`}
            >
              <span
                className="text-[9.5px] font-medium"
                style={{ color: cliTint[usage.cli] }}
              >
                {cliLabel[usage.cli]}
              </span>
              <span
                className="h-[5px] w-9 overflow-hidden rounded-full"
                style={{ background: 'rgba(238,230,217,0.10)' }}
                role="meter"
                aria-valuenow={usage.used}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-label={`${cliLabel[usage.cli]} usage`}
              >
                <span
                  className="block h-full rounded-full"
                  style={{
                    width: `${usage.used}%`,
                    background: usage.used >= 75 ? statusColor.blocked : cliTint[usage.cli]
                  }}
                />
              </span>
            </span>
          ))}

          <ModeDialCompact />
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
