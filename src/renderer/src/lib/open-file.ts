import { emit } from './app-events'
import { slotsBridge, useSlotsStore } from '@/store/slotsStore'

export async function openFile(path: string, line = 1): Promise<void> {
  await useSlotsStore.getState().hydrate()
  const editor = useSlotsStore.getState().choices.editor
  if (editor === 'vscode' || editor === 'cursor') {
    const api = slotsBridge()
    if (!api) throw new Error('Integration slots bridge is unavailable')
    await api.openExternal(path, line)
    return
  }
  emit('open-file', { path, line })
}
