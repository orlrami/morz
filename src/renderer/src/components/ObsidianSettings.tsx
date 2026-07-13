import { useEffect, useState } from 'react'
import { colors } from '@/lib/tokens'
import type { ObsidianBridge, ObsidianStatus } from '@shared/ipc'

const inputClass =
  'mt-1.5 w-full rounded-lg border bg-transparent px-2.5 py-2 text-xs outline-none transition-colors focus:border-[#CBA25A]'

function bridge(): ObsidianBridge | undefined {
  return (window as unknown as { morzObsidian?: ObsidianBridge }).morzObsidian
}

function errorMessage(error: unknown): string {
  if (!(error instanceof Error)) return 'Obsidian request failed.'
  return error.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '')
}

export function ObsidianSettings(): JSX.Element {
  const [status, setStatus] = useState<ObsidianStatus>({ state: 'not-connected' })
  const [baseUrl, setBaseUrl] = useState('https://127.0.0.1:27124')
  const [apiKey, setApiKey] = useState('')
  const [adrFolder, setAdrFolder] = useState(() => localStorage.getItem('morz.obsidian.adr-folder') ?? 'Decisions')
  const [notePath, setNotePath] = useState('')
  const [noteResult, setNoteResult] = useState('')
  const [busy, setBusy] = useState<'connect' | 'read' | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    const api = bridge()
    if (!api) {
      setStatus({ state: 'offline', error: 'Obsidian bridge is unavailable.' })
      return
    }
    void api
      .status()
      .then((next) => {
        setStatus(next)
        if (next.baseUrl) setBaseUrl(next.baseUrl)
      })
      .catch((caught) => {
        setStatus({ state: 'offline', error: errorMessage(caught) })
      })
  }, [])

  const connect = async (): Promise<void> => {
    const api = bridge()
    if (!api) return
    setBusy('connect')
    setError('')
    try {
      const next = await api.connect(baseUrl, apiKey)
      setStatus(next)
      setApiKey('')
    } catch (caught) {
      setStatus({ state: 'offline', baseUrl })
      setError(errorMessage(caught))
    } finally {
      setBusy(null)
    }
  }

  const testRead = async (): Promise<void> => {
    const api = bridge()
    if (!api) return
    setBusy('read')
    setError('')
    setNoteResult('')
    try {
      setNoteResult(await api.readNote(notePath))
    } catch (caught) {
      setError(errorMessage(caught))
    } finally {
      setBusy(null)
    }
  }

  const stateLabel =
    status.state === 'connected' ? 'Connected' : status.state === 'offline' ? 'Offline' : 'Not connected'
  const stateColor =
    status.state === 'connected' ? colors.done : status.state === 'offline' ? colors.error : colors.quartzDim

  return (
    <div className="mt-5 rounded-xl border p-3" style={{ background: colors.panel, borderColor: 'var(--color-line)' }}>
      <div className="flex items-start gap-3">
        <div>
          <h3 className="text-xs font-semibold" style={{ fontFamily: 'var(--font-display)' }}>
            Obsidian
          </h3>
          <p className="mt-0.5 text-[10.5px] leading-relaxed" style={{ color: colors.quartzDim }}>
            Optional · connects only to your local, user-owned vault.
          </p>
        </div>
        <span
          className="ml-auto inline-flex items-center gap-1.5 rounded-full border px-2 py-1 text-[10px]"
          style={{ borderColor: 'var(--color-line-strong)', color: stateColor }}
          aria-live="polite"
        >
          <span className="size-1.5 rounded-full" style={{ background: stateColor }} />
          {stateLabel}
        </span>
      </div>

      <div className="mt-3 grid gap-2.5 sm:grid-cols-2">
        <label className="text-[10.5px]" style={{ color: colors.quartzDim }}>
          Obsidian base URL
          <input
            className={inputClass}
            style={{ borderColor: 'var(--color-line-strong)', color: colors.quartz }}
            value={baseUrl}
            onChange={(event) => setBaseUrl(event.target.value)}
            spellCheck={false}
          />
        </label>
        <label className="text-[10.5px]" style={{ color: colors.quartzDim }}>
          Obsidian API key
          <input
            className={inputClass}
            style={{ borderColor: 'var(--color-line-strong)', color: colors.quartz }}
            type="password"
            autoComplete="off"
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
          />
        </label>
      </div>
      <p className="mt-2 text-[9.5px] leading-relaxed" style={{ color: colors.quartzDim }}>
        HTTPS requires trusting the plugin certificate. Or enable its localhost HTTP server on port 27123.
      </p>
      <button
        type="button"
        onClick={() => void connect()}
        disabled={busy !== null || !baseUrl.trim() || !apiKey}
        className="mt-2.5 rounded-lg px-3 py-1.5 text-[10.5px] font-semibold disabled:cursor-not-allowed disabled:opacity-40"
        style={{ background: colors.bronze, color: colors.page }}
      >
        {busy === 'connect' ? 'Connecting…' : 'Connect to Obsidian'}
      </button>

      <div className="mt-3 border-t pt-3" style={{ borderColor: 'var(--color-line)' }}>
        <label className="block text-[10.5px]" style={{ color: colors.quartzDim }}>
          ADR folder
          <input
            className={inputClass}
            style={{ borderColor: 'var(--color-line-strong)', color: colors.quartz }}
            value={adrFolder}
            onChange={(event) => {
              setAdrFolder(event.target.value)
              localStorage.setItem('morz.obsidian.adr-folder', event.target.value)
            }}
            placeholder="Decisions"
          />
        </label>
      </div>

      <div className="mt-3 border-t pt-3" style={{ borderColor: 'var(--color-line)' }}>
        <div className="flex items-end gap-2">
          <label className="min-w-0 flex-1 text-[10.5px]" style={{ color: colors.quartzDim }}>
            Test note path
            <input
              className={inputClass}
              style={{ borderColor: 'var(--color-line-strong)', color: colors.quartz }}
              value={notePath}
              onChange={(event) => setNotePath(event.target.value)}
              placeholder="Notes/example.md"
            />
          </label>
          <button
            type="button"
            onClick={() => void testRead()}
            disabled={busy !== null || status.state !== 'connected' || !notePath.trim()}
            className="rounded-lg border px-2.5 py-2 text-[10.5px] disabled:cursor-not-allowed disabled:opacity-40"
            style={{ borderColor: 'var(--color-line-strong)', color: colors.quartz }}
          >
            {busy === 'read' ? 'Reading…' : 'Test read'}
          </button>
        </div>
        {noteResult && (
          <pre
            data-testid="obsidian-test-read-result"
            className="mt-2 max-h-28 overflow-auto whitespace-pre-wrap rounded-lg border p-2 text-[10px] leading-relaxed"
            style={{ borderColor: 'var(--color-line)', color: colors.quartzDim }}
          >
            {noteResult}
          </pre>
        )}
      </div>

      {(error || status.error) && (
        <p className="mt-2 text-[10px] leading-relaxed" style={{ color: colors.error }} role="alert">
          {error || status.error}
        </p>
      )}
    </div>
  )
}
