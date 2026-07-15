import { useEffect, useRef, useState } from 'react'
import { IconMicrophone } from '@tabler/icons-react'
import { colors } from '@/lib/tokens'
import {
  notifyVoiceFailure,
  useVoiceStore,
  voiceErrorMessage
} from '@/store/voiceStore'

interface VoiceInputProps {
  onText(text: string): void
}

function isWhisperWav(bytes: Uint8Array): boolean {
  if (bytes.length < 44) return false
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const text = (offset: number, length: number): string =>
    String.fromCharCode(...bytes.subarray(offset, offset + length))
  return (
    text(0, 4) === 'RIFF' &&
    text(8, 4) === 'WAVE' &&
    view.getUint16(20, true) === 1 &&
    view.getUint16(22, true) === 1 &&
    view.getUint32(24, true) === 16_000 &&
    view.getUint16(34, true) === 16
  )
}

function encodePcmWav(samples: Float32Array): Uint8Array {
  const bytes = new Uint8Array(44 + samples.length * 2)
  const view = new DataView(bytes.buffer)
  const write = (offset: number, value: string): void => {
    for (let index = 0; index < value.length; index += 1) {
      view.setUint8(offset + index, value.charCodeAt(index))
    }
  }
  write(0, 'RIFF')
  view.setUint32(4, bytes.length - 8, true)
  write(8, 'WAVE')
  write(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, 16_000, true)
  view.setUint32(28, 32_000, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  write(36, 'data')
  view.setUint32(40, samples.length * 2, true)
  for (let index = 0; index < samples.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, samples[index]))
    view.setInt16(44 + index * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true)
  }
  return bytes
}

async function toWhisperWav(blob: Blob): Promise<Uint8Array> {
  const input = new Uint8Array(await blob.arrayBuffer())
  if (isWhisperWav(input)) return input

  const context = new AudioContext()
  try {
    const decoded = await context.decodeAudioData(input.buffer.slice(0))
    const frames = Math.max(1, Math.ceil(decoded.duration * 16_000))
    const offline = new OfflineAudioContext(1, frames, 16_000)
    const source = offline.createBufferSource()
    source.buffer = decoded
    source.connect(offline.destination)
    source.start()
    const rendered = await offline.startRendering()
    return encodePcmWav(rendered.getChannelData(0))
  } finally {
    await context.close()
  }
}

export function VoiceInput({ onText }: VoiceInputProps): JSX.Element | null {
  const { settings, busy, initialize, transcribe } = useVoiceStore()
  const [recording, setRecording] = useState(false)
  const recorderRef = useRef<MediaRecorder | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const pressedRef = useRef(false)
  const canceledRef = useRef(false)

  useEffect(() => {
    void initialize()
  }, [initialize])

  const cleanup = (): void => {
    streamRef.current?.getTracks().forEach((track) => track.stop())
    streamRef.current = null
    recorderRef.current = null
    setRecording(false)
  }

  const cancel = (): void => {
    pressedRef.current = false
    canceledRef.current = true
    chunksRef.current = []
    const recorder = recorderRef.current
    if (recorder?.state === 'recording') recorder.stop()
    else cleanup()
  }

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && (recording || pressedRef.current)) {
        event.preventDefault()
        cancel()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [recording])

  useEffect(() => () => cancel(), [])

  const start = async (): Promise<void> => {
    if (busy || recording || pressedRef.current) return
    pressedRef.current = true
    canceledRef.current = false
    chunksRef.current = []
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      if (!pressedRef.current) {
        stream.getTracks().forEach((track) => track.stop())
        return
      }
      const mimeType = MediaRecorder.isTypeSupported?.('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : undefined
      const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream)
      streamRef.current = stream
      recorderRef.current = recorder
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunksRef.current.push(event.data)
      }
      recorder.onstop = () => {
        const canceled = canceledRef.current
        const blob = new Blob(chunksRef.current, { type: recorder.mimeType || 'audio/webm' })
        chunksRef.current = []
        cleanup()
        if (canceled || blob.size === 0) return
        void toWhisperWav(blob)
          .then((wav) => transcribe(wav))
          .then((text) => {
            if (text) onText(text)
          })
          .catch((reason: unknown) => {
            const detail = voiceErrorMessage(reason)
            notifyVoiceFailure('Voice recording failed', detail)
          })
      }
      recorder.start()
      setRecording(true)
    } catch (reason) {
      pressedRef.current = false
      cleanup()
      const detail = voiceErrorMessage(reason)
      notifyVoiceFailure('Microphone unavailable', detail)
    }
  }

  const stop = (): void => {
    pressedRef.current = false
    const recorder = recorderRef.current
    if (recorder?.state === 'recording') recorder.stop()
  }

  if (!settings?.configured) return null

  return (
    <div className="flex shrink-0 items-center gap-1" aria-live="polite">
      <button
        type="button"
        aria-label="Hold to dictate"
        aria-pressed={recording}
        disabled={busy}
        onPointerDown={(event) => {
          if (event.button !== 0) return
          event.preventDefault()
          event.currentTarget.setPointerCapture(event.pointerId)
          void start()
        }}
        onPointerUp={(event) => {
          event.preventDefault()
          stop()
        }}
        onPointerCancel={cancel}
        onKeyDown={(event) => {
          if ((event.key === ' ' || event.key === 'Enter') && !event.repeat) {
            event.preventDefault()
            void start()
          }
        }}
        onKeyUp={(event) => {
          if (event.key === ' ' || event.key === 'Enter') {
            event.preventDefault()
            stop()
          }
        }}
        className="flex size-7 items-center justify-center rounded-md border outline-none focus:ring-1 disabled:opacity-40"
        style={{
          borderColor: recording ? colors.error : 'var(--color-line-strong)',
          background: recording ? `${colors.error}22` : 'transparent',
          color: recording ? colors.error : colors.quartzDim,
          '--tw-ring-color': colors.bronze
        } as React.CSSProperties}
        title="Hold to dictate · Esc cancels"
      >
        <IconMicrophone size={13} stroke={1.8} />
      </button>
      {recording && (
        <span className="text-[9px]" style={{ color: colors.error }}>
          Recording…
        </span>
      )}
      {!recording && busy && (
        <span className="text-[9px]" style={{ color: colors.bronzeHot }}>
          Transcribing…
        </span>
      )}
    </div>
  )
}
