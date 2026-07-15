import { create } from 'zustand'
import type { VoiceBridge, VoiceSettingsSnapshot } from '@shared/ipc'

interface VoiceState {
  settings: VoiceSettingsSnapshot | null
  busy: boolean
  error: string
  testResult: string
  initialize(): Promise<void>
  chooseEngine(): Promise<void>
  clearEngine(): Promise<void>
  testTranscription(): Promise<void>
  transcribe(audio: Uint8Array): Promise<string | null>
}

let initialized = false

function bridge(): VoiceBridge | undefined {
  return (window as unknown as { morzVoice?: VoiceBridge }).morzVoice
}

export function voiceErrorMessage(reason: unknown): string {
  const message = reason instanceof Error ? reason.message : String(reason)
  return message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '')
}

export function notifyVoiceFailure(title: string, detail: string): void {
  window.morz.notify?.emit({
    id: `voice:${title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
    level: 'error',
    source: 'app',
    title,
    detail
  })
}

export const useVoiceStore = create<VoiceState>((set) => ({
  settings: null,
  busy: false,
  error: '',
  testResult: '',

  initialize: async () => {
    if (initialized) return
    initialized = true
    const api = bridge()
    if (!api) return
    try {
      set({ settings: await api.settings() })
    } catch (reason) {
      initialized = false
      const error = voiceErrorMessage(reason)
      set({ error })
      notifyVoiceFailure('Voice settings failed', error)
    }
  },

  chooseEngine: async () => {
    const api = bridge()
    if (!api) return
    set({ busy: true, error: '', testResult: '' })
    try {
      set({ settings: await api.chooseEngine() })
    } catch (reason) {
      const error = voiceErrorMessage(reason)
      set({ error })
      notifyVoiceFailure('Voice engine is invalid', error)
    } finally {
      set({ busy: false })
    }
  },

  clearEngine: async () => {
    const api = bridge()
    if (!api) return
    set({ busy: true, error: '', testResult: '' })
    try {
      set({ settings: await api.clearEngine() })
    } catch (reason) {
      const error = voiceErrorMessage(reason)
      set({ error })
      notifyVoiceFailure('Voice settings failed', error)
    } finally {
      set({ busy: false })
    }
  },

  testTranscription: async () => {
    const api = bridge()
    if (!api) return
    set({ busy: true, error: '', testResult: '' })
    try {
      const testResult = await api.testTranscription()
      if (testResult !== null) set({ testResult })
    } catch (reason) {
      const error = voiceErrorMessage(reason)
      set({ error })
      notifyVoiceFailure('Test transcription failed', error)
    } finally {
      set({ busy: false })
    }
  },

  transcribe: async (audio) => {
    const api = bridge()
    if (!api) return null
    set({ busy: true, error: '' })
    try {
      return await api.transcribe(audio)
    } catch (reason) {
      const error = voiceErrorMessage(reason)
      set({ error })
      notifyVoiceFailure('Voice transcription failed', error)
      return null
    } finally {
      set({ busy: false })
    }
  }
}))
