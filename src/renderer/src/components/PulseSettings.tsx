import { useEffect, type ReactNode } from 'react'
import { IconClock, IconPlayerPlay, IconSun, IconX } from '@tabler/icons-react'
import { colors } from '@/lib/tokens'
import { useModeStore } from '@/store/modeStore'
import { latestPulseBrief, usePulseStore } from '@/store/pulseStore'

function formatNext(value: number | null): string {
  if (value === null) return 'Not scheduled'
  return new Intl.DateTimeFormat(undefined, {
    weekday: 'short',
    hour: 'numeric',
    minute: '2-digit'
  }).format(new Date(value))
}

function markdownLines(markdown: string): ReactNode[] {
  return markdown.split('\n').map((line, index) => {
    if (line.startsWith('### ')) return <h6 key={index} className="mt-3 text-[11px] font-semibold">{line.slice(4)}</h6>
    if (line.startsWith('## ')) return <h5 key={index} className="mt-4 text-xs font-bold">{line.slice(3)}</h5>
    if (line.startsWith('# ')) return <h4 key={index} className="text-sm font-bold">{line.slice(2)}</h4>
    if (/^\d+\. /.test(line)) return <p key={index} className="pl-2">{line}</p>
    if (line.startsWith('- ')) return <p key={index} className="pl-2">• {line.slice(2)}</p>
    if (!line.trim()) return <span key={index} className="block h-2" />
    return <p key={index}>{line}</p>
  })
}

export function PulseSettings(): JSX.Element {
  const mode = useModeStore((state) => state.mode)
  const snapshot = usePulseStore((state) => state.snapshot)
  const loading = usePulseStore((state) => state.loading)
  const running = usePulseStore((state) => state.running)
  const error = usePulseStore((state) => state.error)
  const noticeTitle = usePulseStore((state) => state.noticeTitle)
  const viewerOpen = usePulseStore((state) => state.viewerOpen)
  const initialize = usePulseStore((state) => state.initialize)
  const configure = usePulseStore((state) => state.configure)
  const runNow = usePulseStore((state) => state.runNow)
  const setViewerOpen = usePulseStore((state) => state.setViewerOpen)
  const settings = snapshot?.settings
  const brief = latestPulseBrief(snapshot)

  useEffect(() => {
    void initialize()
  }, [initialize])

  const enabled = settings?.enabled ?? false
  const unavailable = mode === 'manual'

  return (
    <div
      className="mt-5 rounded-xl border p-3"
      style={{ background: colors.panel, borderColor: 'var(--color-line)' }}
      aria-label="Daily Pulse settings"
    >
      <div className="flex items-start gap-3">
        <span
          className="flex size-8 shrink-0 items-center justify-center rounded-lg border"
          style={{ borderColor: 'var(--color-line-strong)', color: colors.bronzeHot }}
        >
          <IconSun size={16} stroke={1.6} />
        </span>
        <div>
          <h3 className="text-xs font-semibold" style={{ fontFamily: 'var(--font-display)' }}>
            Daily Pulse
          </h3>
          <p className="mt-0.5 text-[10.5px] leading-relaxed" style={{ color: colors.quartzDim }}>
            One cheap morning pass over the active Space, task board, and unread bus inboxes.
          </p>
        </div>
        <span
          className="ml-auto rounded-full border px-2 py-1 text-[10px]"
          style={{
            borderColor: 'var(--color-line-strong)',
            color: enabled && !unavailable ? colors.done : colors.quartzDim
          }}
        >
          {unavailable ? 'Manual mode' : enabled ? 'Scheduled' : 'Off'}
        </span>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-3 border-t pt-3" style={{ borderColor: 'var(--color-line)' }}>
        <label className="flex min-h-8 cursor-pointer items-center gap-2 text-[10.5px]">
          <input
            type="checkbox"
            aria-label="Enable Daily Pulse"
            checked={enabled}
            disabled={loading}
            onChange={(event) => void configure(event.target.checked, settings?.time ?? '08:00')}
            className="size-3.5 accent-[#CBA25A]"
          />
          Enable Daily Pulse
        </label>
        <label className="ml-auto flex items-center gap-2 text-[10.5px]" style={{ color: colors.quartzDim }}>
          <IconClock size={13} stroke={1.5} />
          Local time
          <input
            type="time"
            aria-label="Daily Pulse time"
            value={settings?.time ?? '08:00'}
            disabled={loading}
            onChange={(event) => void configure(enabled, event.target.value)}
            className="rounded-md border bg-transparent px-2 py-1 font-mono text-[10.5px] outline-none focus:border-[#CBA25A]"
            style={{ borderColor: 'var(--color-line-strong)', color: colors.quartz }}
          />
        </label>
      </div>

      <div className="mt-3 flex items-center gap-2">
        <button
          type="button"
          aria-label="Run Daily Pulse now"
          disabled={!enabled || unavailable || running || loading}
          onClick={() => void runNow()}
          className="flex min-h-8 items-center gap-1.5 rounded-lg px-3 py-1.5 text-[10.5px] font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-40"
          style={{ background: colors.bronze, color: colors.page }}
        >
          <IconPlayerPlay size={12} stroke={1.8} />
          {running ? 'Building brief…' : 'Run now'}
        </button>
        <span className="text-[10px]" style={{ color: colors.quartzDim }}>
          {formatNext(settings?.nextFire ?? null)}
        </span>
        {brief && !viewerOpen && (
          <button
            type="button"
            onClick={() => setViewerOpen(true)}
            className="ml-auto text-[10px] underline decoration-dotted underline-offset-4"
            style={{ color: colors.bronzeHot }}
          >
            Open last brief
          </button>
        )}
      </div>

      {unavailable && (
        <p className="mt-2 text-[10px] leading-relaxed" style={{ color: colors.quartzDim }}>
          Pulse stays inert in Manual. Choose Assisted or Orchestrated before enabling a run.
        </p>
      )}
      {error && <p className="mt-2 text-[10px] leading-relaxed" style={{ color: colors.error }} role="alert">{error}</p>}
      {noticeTitle && (
        <button
          type="button"
          onClick={() => setViewerOpen(true)}
          className="mt-3 w-full rounded-lg border px-2.5 py-2 text-left text-[10.5px]"
          style={{ borderColor: 'rgba(92, 171, 126, 0.45)', color: colors.done }}
        >
          {noticeTitle}
        </button>
      )}

      {brief && viewerOpen && (
        <section className="mt-3 overflow-hidden rounded-lg border" style={{ borderColor: 'var(--color-line-strong)' }}>
          <div className="flex items-center gap-2 border-b px-3 py-2" style={{ borderColor: 'var(--color-line)' }}>
            <div>
              <p className="text-[10.5px] font-semibold">Last brief</p>
              <p className="text-[9px]" style={{ color: colors.quartzDim }}>
                {new Date(brief.createdAt).toLocaleString()} · {brief.trigger}
              </p>
            </div>
            <button
              type="button"
              aria-label="Close Daily Pulse brief"
              onClick={() => setViewerOpen(false)}
              className="ml-auto rounded-md p-1"
              style={{ color: colors.quartzDim }}
            >
              <IconX size={13} stroke={1.5} />
            </button>
          </div>
          <article
            data-testid="pulse-brief"
            className="max-h-80 overflow-y-auto px-3 py-3 text-[10.5px] leading-relaxed"
            style={{ color: colors.quartz }}
          >
            {markdownLines(brief.markdown)}
          </article>
        </section>
      )}
    </div>
  )
}
