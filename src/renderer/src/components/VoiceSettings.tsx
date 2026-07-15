import { useEffect } from 'react'
import { IconMicrophone, IconPlayerPlay, IconTrash } from '@tabler/icons-react'
import { colors } from '@/lib/tokens'
import { useVoiceStore } from '@/store/voiceStore'

export function VoiceSettings(): JSX.Element {
  const {
    settings,
    busy,
    error,
    testResult,
    initialize,
    chooseEngine,
    clearEngine,
    testTranscription
  } = useVoiceStore()

  useEffect(() => {
    void initialize()
  }, [initialize])

  const configured = settings?.configured ?? false

  return (
    <section
      className="mt-4 rounded-xl border p-3"
      style={{ background: colors.panel, borderColor: 'var(--color-line)' }}
      aria-label="Voice settings"
    >
      <div className="flex items-center gap-2">
        <span
          className="flex size-7 items-center justify-center rounded-lg border"
          style={{ borderColor: 'var(--color-line-strong)', color: colors.bronzeHot }}
        >
          <IconMicrophone size={15} stroke={1.6} />
        </span>
        <div>
          <h3 className="text-xs font-semibold" style={{ fontFamily: 'var(--font-display)' }}>
            Local voice dictation
          </h3>
          <p className="text-[10px]" style={{ color: colors.quartzDim }}>
            Optional · audio stays on this machine
          </p>
        </div>
        <span
          className="ml-auto rounded-full border px-2 py-0.5 text-[9px] font-bold"
          style={{
            borderColor: configured ? `${colors.done}55` : 'var(--color-line-strong)',
            color: configured ? colors.done : colors.quartzDim
          }}
        >
          {configured ? 'Configured' : 'Not configured'}
        </span>
      </div>

      <p className="mt-2 text-[9.5px] leading-relaxed" style={{ color: colors.quartzDim }}>
        Choose your own local whisper.cpp <code>main.exe</code>/<code>whisper-cli</code>, or a
        CLI that accepts a WAV path and prints plain text. Morz records and converts to the engine
        expectation: 16 kHz mono 16-bit PCM WAV. Models are not bundled.
      </p>

      {settings?.enginePath && (
        <p
          className="mt-2 truncate rounded-md border px-2 py-1 font-mono text-[9px]"
          style={{ borderColor: 'var(--color-line)', color: colors.quartzDim }}
          title={settings.enginePath}
        >
          {settings.enginePath}
        </p>
      )}

      <div className="mt-2.5 flex flex-wrap gap-2">
        <button
          type="button"
          aria-label="Choose Whisper engine"
          disabled={busy}
          onClick={() => void chooseEngine()}
          className="rounded-md px-3 py-1.5 text-[10px] font-bold disabled:opacity-40"
          style={{ background: colors.bronze, color: colors.page }}
        >
          {configured ? 'Change engine' : 'Choose engine'}
        </button>
        {configured && (
          <>
            <button
              type="button"
              disabled={busy}
              onClick={() => void testTranscription()}
              className="flex items-center gap-1 rounded-md border px-2.5 py-1.5 text-[10px] disabled:opacity-40"
              style={{ borderColor: 'var(--color-line-strong)', color: colors.quartz }}
            >
              <IconPlayerPlay size={11} stroke={1.7} />
              Test transcription
            </button>
            <button
              type="button"
              aria-label="Remove voice engine"
              disabled={busy}
              onClick={() => void clearEngine()}
              className="flex items-center gap-1 rounded-md border px-2.5 py-1.5 text-[10px] disabled:opacity-40"
              style={{ borderColor: 'var(--color-line-strong)', color: colors.quartzDim }}
            >
              <IconTrash size={11} stroke={1.7} />
              Remove
            </button>
          </>
        )}
      </div>

      {testResult && (
        <p
          className="mt-2 rounded-md border px-2 py-1.5 text-[10px]"
          style={{ borderColor: 'var(--color-line)', color: colors.done }}
          aria-live="polite"
        >
          {testResult}
        </p>
      )}
      {error && (
        <p role="alert" className="mt-2 text-[10px] leading-snug" style={{ color: colors.error }}>
          {error}
        </p>
      )}
    </section>
  )
}
