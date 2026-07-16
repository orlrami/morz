import { useEffect, useState } from 'react'
import {
  IconDeviceFloppy,
  IconKey,
  IconPlayerPlay,
  IconSparkles,
  IconTrash
} from '@tabler/icons-react'
import type { ReportProvider } from '@shared/report'
import { colors } from '@/lib/tokens'
import { useReportStore } from '@/store/reportStore'

const PROVIDERS: ReadonlyArray<{ id: ReportProvider; label: string }> = [
  { id: 'claude-cli', label: 'Claude CLI (default)' },
  { id: 'openai', label: 'OpenAI' },
  { id: 'gemini', label: 'Google Gemini' },
  { id: 'openrouter', label: 'OpenRouter' },
  { id: 'anthropic-key', label: 'Anthropic API key' }
]

export function ReportSettings(): JSX.Element {
  const {
    config,
    busy,
    error,
    testResult,
    initialize,
    selectProvider,
    saveModel,
    saveKey,
    clearKey,
    testProvider
  } = useReportStore()
  const [model, setModel] = useState('')
  const [key, setKey] = useState('')

  useEffect(() => {
    void initialize()
  }, [initialize])

  useEffect(() => {
    setModel(config?.model ?? '')
    setKey('')
  }, [config?.model, config?.provider, config?.hasKey])

  const provider = config?.provider ?? 'claude-cli'
  const usesKey = provider !== 'claude-cli'

  const storeKey = async (): Promise<void> => {
    const pending = key
    try {
      await saveKey(provider, pending)
    } finally {
      setKey('')
    }
  }

  return (
    <section className="max-w-[560px]" aria-label="Report AI settings">
      <div className="flex items-center gap-2">
        <span
          className="flex size-8 items-center justify-center rounded-lg border"
          style={{ borderColor: 'var(--color-line-strong)', color: colors.bronzeHot }}
        >
          <IconSparkles size={16} stroke={1.6} />
        </span>
        <div>
          <h2 className="text-sm font-bold" style={{ fontFamily: 'var(--font-display)' }}>
            AI reports
          </h2>
          <p className="text-[10px]" style={{ color: colors.quartzDim }}>
            One summarizer for every “explain this” surface
          </p>
        </div>
        <span
          className="ml-auto rounded-full border px-2 py-0.5 text-[9px] font-bold"
          style={{
            borderColor: config?.configured ? `${colors.done}55` : 'var(--color-line-strong)',
            color: config?.configured ? colors.done : colors.quartzDim
          }}
        >
          {config?.configured ? 'Configured' : 'Not configured'}
        </span>
      </div>

      <p className="mt-3 text-[10.5px] leading-relaxed" style={{ color: colors.quartzDim }}>
        Claude CLI uses your existing local login. Provider keys are write-only, encrypted by the
        operating system, and never returned to this screen.
      </p>

      <div
        className="mt-4 space-y-3 rounded-xl border p-3.5"
        style={{ background: colors.panel, borderColor: 'var(--color-line)' }}
      >
        <label className="block text-[10px] font-semibold" htmlFor="report-provider">
          Report provider
        </label>
        <select
          id="report-provider"
          aria-label="Report AI provider"
          value={provider}
          disabled={busy || !config}
          onChange={(event) => void selectProvider(event.target.value as ReportProvider)}
          className="min-h-9 w-full rounded-md border px-2.5 text-xs outline-none disabled:opacity-40"
          style={{
            background: colors.card,
            borderColor: 'var(--color-line-strong)',
            color: colors.quartz
          }}
        >
          {PROVIDERS.map((option) => (
            <option key={option.id} value={option.id}>{option.label}</option>
          ))}
        </select>

        {usesKey ? (
          <>
            <div>
              <label className="block text-[10px] font-semibold" htmlFor="report-model">
                Model
              </label>
              <div className="mt-1 flex gap-2">
                <input
                  id="report-model"
                  value={model}
                  disabled={busy}
                  onChange={(event) => setModel(event.target.value)}
                  spellCheck={false}
                  className="min-h-9 min-w-0 flex-1 rounded-md border px-2.5 font-mono text-[10.5px] outline-none disabled:opacity-40"
                  style={{
                    background: colors.card,
                    borderColor: 'var(--color-line-strong)',
                    color: colors.quartz
                  }}
                />
                <button
                  type="button"
                  disabled={busy || !model.trim() || model === config?.model}
                  onClick={() => void saveModel(model)}
                  className="flex min-h-9 items-center gap-1 rounded-md border px-2.5 text-[10px] disabled:opacity-40"
                  style={{ borderColor: 'var(--color-line-strong)', color: colors.quartz }}
                >
                  <IconDeviceFloppy size={12} stroke={1.7} />
                  Save model
                </button>
              </div>
            </div>

            <div>
              <label className="block text-[10px] font-semibold" htmlFor="report-api-key">
                API key {config?.hasKey ? '· stored securely' : '· required'}
              </label>
              <div className="mt-1 flex gap-2">
                <input
                  id="report-api-key"
                  type="password"
                  value={key}
                  disabled={busy}
                  autoComplete="new-password"
                  spellCheck={false}
                  placeholder={config?.hasKey ? 'Enter a replacement key' : 'Paste key'}
                  onChange={(event) => setKey(event.target.value)}
                  className="min-h-9 min-w-0 flex-1 rounded-md border px-2.5 font-mono text-[10.5px] outline-none disabled:opacity-40"
                  style={{
                    background: colors.card,
                    borderColor: 'var(--color-line-strong)',
                    color: colors.quartz
                  }}
                />
                <button
                  type="button"
                  aria-label="Store report API key"
                  disabled={busy || key.length < 8}
                  onClick={() => void storeKey()}
                  className="flex min-h-9 items-center gap-1 rounded-md px-2.5 text-[10px] font-bold disabled:opacity-40"
                  style={{ background: colors.bronze, color: colors.page }}
                >
                  <IconKey size={12} stroke={1.7} />
                  Store key
                </button>
                {config?.hasKey && (
                  <button
                    type="button"
                    aria-label="Remove report API key"
                    disabled={busy}
                    onClick={() => void clearKey(provider)}
                    className="flex min-h-9 items-center rounded-md border px-2 disabled:opacity-40"
                    style={{ borderColor: 'var(--color-line-strong)', color: colors.quartzDim }}
                  >
                    <IconTrash size={12} stroke={1.7} />
                  </button>
                )}
              </div>
            </div>
          </>
        ) : (
          <p
            className="rounded-md border px-2.5 py-2 text-[10px] leading-relaxed"
            style={{ borderColor: 'var(--color-line)', color: colors.quartzDim }}
          >
            Morz runs <code>claude -p</code> headlessly with your existing Claude login. No key is
            stored by Morz.
          </p>
        )}

        <button
          type="button"
          disabled={busy || !config?.configured}
          onClick={() => void testProvider()}
          className="flex min-h-9 items-center gap-1.5 rounded-md border px-3 text-[10px] font-semibold disabled:opacity-40"
          style={{ borderColor: 'var(--color-line-strong)', color: colors.quartz }}
        >
          <IconPlayerPlay size={12} stroke={1.7} />
          {busy ? 'Testing…' : 'Test provider'}
        </button>
      </div>

      <div role="status" aria-live="polite" aria-atomic="true">
        {testResult && (
          <pre
            className="mt-3 max-h-48 overflow-auto whitespace-pre-wrap rounded-lg border p-3 text-[10px] leading-relaxed"
            style={{
              background: colors.card,
              borderColor: testResult.ok ? `${colors.done}55` : `${colors.error}55`,
              color: testResult.ok ? colors.done : colors.error
            }}
          >
            {testResult.text}
          </pre>
        )}
      </div>
      {error && (
        <p role="alert" className="mt-2 text-[10px] leading-snug" style={{ color: colors.error }}>
          {error}
        </p>
      )}
    </section>
  )
}
