import { useEffect } from 'react'
import { IconPlugConnected, IconRefresh } from '@tabler/icons-react'
import type { CliConnection } from '@shared/connections'
import { colors } from '@/lib/tokens'
import { useConnectionsStore } from '@/store/connectionsStore'

function connectionState(connection: CliConnection): { label: string; color: string } {
  if (!connection.installed) return { label: 'Not installed', color: colors.quartzDim }
  if (connection.authed === true) return { label: 'Connected', color: colors.done }
  if (connection.authed === false) return { label: 'Not logged in', color: colors.error }
  return { label: 'Authentication unknown', color: colors.bronzeHot }
}

function detail(value: string | null, fallback = 'Not reported'): string {
  return value?.trim() || fallback
}

export function ConnectionsSettings(): JSX.Element {
  const { connections, loading, refreshing, error, start, refresh } = useConnectionsStore()

  useEffect(() => start(), [start])

  return (
    <section className="max-w-[640px]" aria-label="CLI connections">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-bold" style={{ fontFamily: 'var(--font-display)' }}>
            Connections
          </h2>
          <p className="mt-1 text-xs leading-relaxed" style={{ color: colors.quartzDim }}>
            Morz detects the AI CLIs installed on this computer and reports only account details they expose locally.
          </p>
        </div>
        <button
          type="button"
          disabled={loading || refreshing}
          onClick={() => void refresh()}
          className="flex min-h-9 shrink-0 items-center gap-1.5 rounded-md border px-3 py-1.5 text-[10px] font-bold disabled:cursor-not-allowed disabled:opacity-45"
          style={{ borderColor: 'var(--color-line-strong)', color: colors.quartz }}
          aria-label="Refresh CLI connections"
        >
          <IconRefresh
            className={refreshing ? 'animate-spin motion-reduce:animate-none' : ''}
            size={12}
            stroke={1.8}
          />
          {refreshing ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>

      {error && (
        <p
          role="alert"
          className="mt-4 rounded-lg border px-3 py-2 text-[10.5px]"
          style={{ borderColor: `${colors.error}66`, color: colors.error, background: `${colors.error}0d` }}
        >
          {error}
        </p>
      )}

      {loading && connections.length === 0 ? (
        <p className="mt-4 text-xs" style={{ color: colors.quartzDim }} role="status">
          Checking installed CLIs…
        </p>
      ) : (
        <div className="mt-4 grid gap-2.5 sm:grid-cols-2">
          {connections.map((connection) => {
            const status = connectionState(connection)
            return (
              <article
                key={connection.id}
                data-testid={`connection-${connection.id}`}
                className="rounded-xl border p-3"
                style={{ background: colors.panel, borderColor: 'var(--color-line)' }}
              >
                <div className="flex items-start gap-2.5">
                  <span
                    className="flex size-8 shrink-0 items-center justify-center rounded-lg border"
                    style={{ borderColor: 'var(--color-line-strong)', color: status.color }}
                    aria-hidden="true"
                  >
                    <IconPlugConnected size={16} stroke={1.6} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <h3 className="truncate text-xs font-semibold" style={{ fontFamily: 'var(--font-display)' }}>
                      {connection.label}
                    </h3>
                    <p className="truncate font-mono text-[9px]" style={{ color: colors.quartzDim }}>
                      {connection.installed ? detail(connection.version, 'Version unavailable') : 'CLI not found on PATH'}
                    </p>
                  </div>
                  <span
                    className="rounded-full border px-2 py-0.5 text-[8.5px] font-bold"
                    style={{ borderColor: status.color, color: status.color, background: 'rgba(0,0,0,0.08)' }}
                  >
                    {status.label}
                  </span>
                </div>

                <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-2 border-t pt-2.5 text-[9.5px]" style={{ borderColor: 'var(--color-line)' }}>
                  <div className="min-w-0">
                    <dt style={{ color: colors.quartzDim }}>Plan</dt>
                    <dd className="truncate font-medium" title={connection.plan ?? undefined}>
                      {connection.installed ? detail(connection.plan) : 'Unavailable'}
                    </dd>
                  </div>
                  <div className="min-w-0">
                    <dt style={{ color: colors.quartzDim }}>Model</dt>
                    <dd className="truncate font-mono" title={connection.model ?? undefined}>
                      {connection.installed ? detail(connection.model) : 'Unavailable'}
                    </dd>
                  </div>
                </dl>
              </article>
            )
          })}
        </div>
      )}
    </section>
  )
}
