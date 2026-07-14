import { IconLink, IconPlugConnected, IconUnlink } from '@tabler/icons-react'
import { colors } from '@/lib/tokens'
import { useAssistantStore } from '@/store/assistantStore'
import { useModeStore } from '@/store/modeStore'
import { AssistantPanel } from './AssistantPanel'

const statusColor = {
  disconnected: colors.quartzDim,
  connecting: colors.bronzeHot,
  connected: colors.done,
  error: colors.error
} as const

const statusLabel = {
  disconnected: 'Disconnected',
  connecting: 'Connecting',
  connected: 'Connected',
  error: 'Connection error'
} as const

/** Provider picker and explicit connection flow; credentials remain in the provider-owned surface. */
export function AssistantSettings(): JSX.Element {
  const mode = useModeStore((state) => state.mode)
  const {
    providers,
    selectedProviderId,
    status,
    busy,
    error,
    selectProvider,
    connect,
    disconnect
  } = useAssistantStore()

  return (
    <section
      className="mt-4 rounded-xl border p-3"
      style={{ background: colors.panel, borderColor: 'var(--color-line)' }}
      aria-label="Assistant settings"
    >
      <div className="flex items-center gap-2">
        <span
          className="flex size-7 items-center justify-center rounded-lg border"
          style={{ borderColor: 'var(--color-line-strong)', color: colors.bronzeHot }}
        >
          <IconPlugConnected size={15} stroke={1.6} />
        </span>
        <div>
          <h3 className="text-xs font-semibold" style={{ fontFamily: 'var(--font-display)' }}>
            Bring your own assistant
          </h3>
          <p className="text-[10px]" style={{ color: colors.quartzDim }}>
            Hermes, OpenClaw, or Perplexity Comet
          </p>
        </div>
        <span
          className="ml-auto rounded-full border px-2 py-0.5 text-[9px] font-bold"
          style={{
            borderColor: `${statusColor[status.state]}55`,
            background: `${statusColor[status.state]}12`,
            color: statusColor[status.state]
          }}
        >
          {statusLabel[status.state]}
        </span>
      </div>

      {mode !== 'orchestrated' ? (
        <p className="mt-3 rounded-lg border px-3 py-2 text-[10.5px]" style={{
          borderColor: 'var(--color-line)',
          color: colors.quartzDim,
          background: 'rgba(0,0,0,0.08)'
        }}>
          Switch to Orchestrated mode to connect or ask an assistant. Manual mode makes zero assistant calls.
        </p>
      ) : (
        <>
          <div className="mt-3 flex gap-2">
            <label className="min-w-0 flex-1 text-[10px]" style={{ color: colors.quartzDim }}>
              Provider
              <select
                aria-label="Assistant provider"
                value={selectedProviderId}
                disabled={busy || status.state === 'connected'}
                onChange={(event) => selectProvider(event.target.value)}
                className="mt-1 w-full rounded-md border bg-black/10 px-2.5 py-2 text-[11px] outline-none focus:ring-1 disabled:opacity-60"
                style={{
                  borderColor: 'var(--color-line-strong)',
                  color: colors.quartz,
                  '--tw-ring-color': colors.bronze
                } as React.CSSProperties}
              >
                <option value="" disabled>Select a provider</option>
                {providers.map((provider) => (
                  <option key={provider.id} value={provider.id}>
                    {provider.name} · {provider.kind}
                  </option>
                ))}
              </select>
            </label>
            {status.state === 'connected' ? (
              <button
                type="button"
                aria-label="Disconnect and sign out assistant"
                disabled={busy}
                onClick={() => void disconnect()}
                className="mt-[18px] flex items-center gap-1 rounded-md border px-3 py-2 text-[10px] disabled:opacity-40"
                style={{ borderColor: 'var(--color-line-strong)', color: colors.quartzDim }}
              >
                <IconUnlink size={12} stroke={1.7} />
                Disconnect &amp; sign out
              </button>
            ) : (
              <button
                type="button"
                aria-label="Connect assistant"
                disabled={busy || !selectedProviderId}
                onClick={() => void connect()}
                className="mt-[18px] flex items-center gap-1 rounded-md px-3 py-2 text-[10px] font-bold disabled:opacity-40"
                style={{ background: colors.bronze, color: colors.page }}
              >
                <IconLink size={12} stroke={1.8} />
                Connect
              </button>
            )}
          </div>

          {selectedProviderId && (
            <p className="mt-1.5 text-[9.5px] leading-relaxed" style={{ color: colors.quartzDim }}>
              {providers.find((provider) => provider.id === selectedProviderId)?.description}
            </p>
          )}
          {error && status.state !== 'connected' && (
            <p role="alert" className="mt-1.5 text-[10px] leading-snug" style={{ color: colors.error }}>
              {error}
            </p>
          )}
          <AssistantPanel />
        </>
      )}
    </section>
  )
}
