import { useEffect } from 'react'
import {
  IconClock,
  IconHistory,
  IconPin,
  IconPinFilled,
  IconPlayerPlay,
  IconRefresh,
  IconRobot
} from '@tabler/icons-react'
import { colors } from '@/lib/tokens'
import { selectActiveSpaceRoot, useSpaceStore } from '@/store/spaceStore'
import { useSessionsStore } from '@/store/sessionsStore'
import type { SessionHistoryRecord } from '@shared/ipc'

function formatTime(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return 'Unknown time'
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  }).format(date)
}

function SessionCard({
  record,
  live,
  busy,
  resumable,
  onPin,
  onResume
}: {
  record: SessionHistoryRecord
  live: boolean
  busy: boolean
  resumable: boolean
  onPin(): void
  onResume(): void
}): JSX.Element {
  return (
    <article
      data-session-record={record.id}
      data-session-live={live ? 'true' : 'false'}
      data-session-pinned={record.pinned ? 'true' : 'false'}
      className="group relative overflow-hidden rounded-xl border px-4 py-3 transition-colors duration-200"
      style={{
        background: record.pinned
          ? `linear-gradient(90deg, ${colors.bronze}18 0%, ${colors.card} 34%)`
          : live
            ? `${colors.bronze}12`
            : colors.card,
        borderColor: live || record.pinned ? `${colors.bronze}66` : 'var(--color-line)',
        boxShadow: record.pinned ? `inset 3px 0 0 ${colors.bronze}` : undefined
      }}
    >
      <div className="flex min-w-0 items-start gap-3">
        <span
          className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border"
          style={{ background: colors.panel, borderColor: 'var(--color-line-strong)', color: colors.bronzeHot }}
        >
          <IconHistory size={16} stroke={1.5} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h2 className="truncate text-sm font-semibold" style={{ fontFamily: 'var(--font-display)' }}>
              {record.title}
            </h2>
            {live && (
              <span
                className="inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[9px] font-bold uppercase tracking-[0.12em]"
                style={{ color: colors.bronzeHot, borderColor: `${colors.bronze}66`, background: `${colors.bronze}14` }}
              >
                <span className="h-1.5 w-1.5 rounded-full" style={{ background: colors.bronzeHot }} />
                Live
              </span>
            )}
            {record.source === 'claude' && !live && (
              <span className="shrink-0 text-[9px] font-semibold uppercase tracking-[0.12em]" style={{ color: colors.agentClaude }}>
                Claude
              </span>
            )}
          </div>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-[10px]" style={{ color: colors.quartzDim }}>
            <time dateTime={record.startedAt} className="inline-flex items-center gap-1.5">
              <IconClock size={12} stroke={1.5} />
              {formatTime(record.startedAt)}
            </time>
            <span className="inline-flex items-center gap-1.5">
              <IconRobot size={12} stroke={1.5} />
              {record.agentsUsed.length > 0 ? record.agentsUsed.join(' · ') : 'No agents yet'}
            </span>
          </div>
          {record.summary && (
            <p className="mt-2 line-clamp-2 text-[11px] leading-relaxed" style={{ color: colors.quartzDim }}>
              {record.summary}
            </p>
          )}
          <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
            {record.model && (
              <span
                data-testid="session-model"
                className="inline-flex rounded-full border px-2 py-0.5 font-mono text-[9px] font-semibold"
                style={{
                  color: colors.agentClaude,
                  borderColor: `${colors.agentClaude}55`,
                  background: `${colors.agentClaude}10`
                }}
              >
                {record.model}
              </span>
            )}
            <button
              type="button"
              onClick={onPin}
              disabled={busy}
              aria-label={`${record.pinned ? 'Unpin' : 'Pin'} ${record.title}`}
              aria-pressed={record.pinned}
              className="ml-auto inline-flex min-h-7 cursor-pointer items-center gap-1.5 rounded-md border px-2.5 py-1 text-[11px] font-semibold transition-[filter,opacity] hover:brightness-110 disabled:cursor-wait disabled:opacity-50"
              style={{
                color: record.pinned ? colors.bronzeHot : colors.quartz,
                borderColor: record.pinned ? `${colors.bronze}66` : 'var(--color-line-strong)',
                background: record.pinned ? `${colors.bronze}18` : colors.panel
              }}
            >
              {record.pinned ? <IconPinFilled size={12} /> : <IconPin size={12} stroke={1.6} />}
              {record.pinned ? 'Pinned' : 'Pin'}
            </button>
            <button
              type="button"
              onClick={onResume}
              disabled={busy || !resumable}
              title={resumable ? undefined : 'no native CLI session recorded'}
              aria-label={`Resume ${record.title}`}
              className="inline-flex min-h-7 cursor-pointer items-center gap-1.5 rounded-md border px-2.5 py-1 text-[11px] font-semibold transition-[filter,opacity] hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-70"
              style={{
                color: resumable ? colors.bronzeHot : colors.quartzFaint,
                borderColor: resumable ? `${colors.bronze}66` : 'var(--color-line-strong)',
                background: resumable ? `${colors.bronze}12` : colors.panel
              }}
            >
              <IconPlayerPlay size={12} stroke={1.8} />
              Resume
            </button>
          </div>
        </div>
      </div>
    </article>
  )
}

export function SessionsPanel(): JSX.Element {
  const spaceRoot = useSpaceStore(selectActiveSpaceRoot)
  const sessions = useSessionsStore((state) => state.sessions)
  const current = useSessionsStore((state) => state.current)
  const loading = useSessionsStore((state) => state.loading)
  const error = useSessionsStore((state) => state.error)
  const busyId = useSessionsStore((state) => state.busyId)
  const resumeAvailability = useSessionsStore((state) => state.resumeAvailability)
  const refresh = useSessionsStore((state) => state.refresh)
  const pin = useSessionsStore((state) => state.pin)
  const resume = useSessionsStore((state) => state.resume)

  useEffect(() => {
    void refresh(spaceRoot)
  }, [refresh, spaceRoot])

  return (
    <section
      aria-label="Session history"
      className="flex min-h-0 flex-1 flex-col overflow-hidden"
      style={{ background: colors.page }}
    >
      <header className="flex items-center gap-3 border-b px-6 py-4" style={{ borderColor: 'var(--color-line)' }}>
        <div className="min-w-0 flex-1">
          <h1 className="text-base font-bold" style={{ fontFamily: 'var(--font-display)' }}>
            Recent sessions
          </h1>
          <p className="mt-0.5 truncate font-mono text-[10px]" style={{ color: colors.quartzDim }}>
            {spaceRoot || 'Open a project space to begin'}
          </p>
        </div>
        <button
          type="button"
          onClick={() => void refresh(spaceRoot)}
          disabled={!spaceRoot || loading}
          aria-label="Refresh sessions"
          className="flex h-8 w-8 cursor-pointer items-center justify-center rounded-lg border transition-colors hover:bg-[#37332B] disabled:cursor-not-allowed disabled:opacity-40"
          style={{ color: colors.quartzDim, borderColor: 'var(--color-line-strong)' }}
        >
          <IconRefresh size={15} stroke={1.5} className={loading ? 'animate-spin' : undefined} />
        </button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
        {error && (
          <div className="rounded-xl border px-4 py-3 text-xs" role="alert" style={{ color: colors.error, borderColor: `${colors.error}55` }}>
            {error}
          </div>
        )}
        {!error && !spaceRoot && (
          <div className="flex h-full items-center justify-center text-xs" style={{ color: colors.quartzDim }}>
            Open a project space to see its work history.
          </div>
        )}
        {!error && spaceRoot && !loading && sessions.length === 0 && (
          <div className="flex h-full items-center justify-center text-xs" style={{ color: colors.quartzDim }}>
            A session appears when a pane opens in this space.
          </div>
        )}
        {sessions.length > 0 && (
          <div className="mx-auto flex w-full max-w-3xl flex-col gap-2.5">
            {sessions.map((record) => (
              <SessionCard
                key={record.id}
                record={record}
                live={record.source === 'morz' && record.endedAt === null && record.id === current?.id}
                busy={busyId === record.id}
                resumable={resumeAvailability[record.id] === true}
                onPin={() => void pin(record.id, !record.pinned)}
                onResume={() => void resume(record.id)}
              />
            ))}
          </div>
        )}
      </div>
    </section>
  )
}
