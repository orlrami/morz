import { useEffect, useState } from 'react'
import { IconRefresh, IconRocket } from '@tabler/icons-react'
import { colors } from '@/lib/tokens'
import type { UpdaterBridge, UpdaterSnapshot, UpdaterStatus } from '@shared/ipc'

const STATUS_LABELS: Record<UpdaterStatus, string> = {
  disabled: 'Off',
  idle: 'Ready',
  checking: 'Checking',
  available: 'Available',
  downloading: 'Downloading',
  ready: 'Restart ready',
  'up-to-date': 'Up to date',
  error: 'Unavailable'
}

function updaterApi(): UpdaterBridge | null {
  return (window as unknown as { morzUpdater?: UpdaterBridge }).morzUpdater ?? null
}

export function UpdateSettings(): JSX.Element {
  const [snapshot, setSnapshot] = useState<UpdaterSnapshot | null>(null)
  const [checking, setChecking] = useState(false)

  useEffect(() => {
    const api = updaterApi()
    if (!api) return
    let mounted = true
    void api.status().then((value) => {
      if (mounted) setSnapshot(value)
    })
    const unsubscribe = api.onChanged((value) => {
      if (mounted) setSnapshot(value)
    })
    return () => {
      mounted = false
      unsubscribe()
    }
  }, [])

  const checkNow = async (): Promise<void> => {
    const api = updaterApi()
    if (!api || !snapshot?.enabled) return
    setChecking(true)
    try {
      setSnapshot(await api.check())
    } finally {
      setChecking(false)
    }
  }

  const status = snapshot?.status ?? 'disabled'
  const busy = checking || status === 'checking' || status === 'downloading'
  const positive = status === 'up-to-date' || status === 'ready'

  return (
    <section
      className="mt-4 rounded-xl border p-3"
      style={{ background: colors.panel, borderColor: 'var(--color-line)' }}
      aria-label="Update settings"
    >
      <div className="flex items-center gap-2">
        <span
          className="flex size-7 items-center justify-center rounded-lg border"
          style={{ borderColor: 'var(--color-line-strong)', color: colors.bronzeHot }}
        >
          <IconRocket size={15} stroke={1.6} />
        </span>
        <div>
          <h3 className="text-xs font-semibold" style={{ fontFamily: 'var(--font-display)' }}>
            Morz updates
          </h3>
          <p className="text-[10px]" style={{ color: colors.quartzDim }}>
            Version {snapshot?.version ?? '—'} · Stable channel
          </p>
        </div>
        <span
          className="ml-auto rounded-full border px-2 py-0.5 text-[9px] font-bold"
          style={{
            borderColor: positive ? `${colors.done}55` : 'var(--color-line-strong)',
            color: positive ? colors.done : status === 'error' ? colors.error : colors.quartzDim
          }}
          aria-live="polite"
        >
          {STATUS_LABELS[status]}
        </span>
      </div>

      <p className="mt-2 text-[9.5px] leading-relaxed" style={{ color: colors.quartzDim }}>
        {snapshot?.detail ?? 'Reading update status…'}
      </p>

      <div className="mt-2.5 flex items-center gap-2 border-t pt-2.5" style={{ borderColor: 'var(--color-line)' }}>
        <button
          type="button"
          aria-label="Check for updates"
          disabled={!snapshot?.enabled || busy}
          onClick={() => void checkNow()}
          className="flex min-h-9 items-center gap-1.5 rounded-md px-3 py-1.5 text-[10px] font-bold disabled:cursor-not-allowed disabled:opacity-40"
          style={{ background: colors.bronze, color: colors.page }}
        >
          <IconRefresh className={busy ? 'animate-spin' : ''} size={12} stroke={1.8} />
          {busy ? 'Checking…' : 'Check for updates'}
        </button>
        {typeof snapshot?.progress === 'number' && (
          <span className="font-mono text-[9.5px]" style={{ color: colors.quartzDim }}>
            {snapshot.progress}%
          </span>
        )}
      </div>
    </section>
  )
}
