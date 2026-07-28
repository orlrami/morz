export interface MemoryIpcSenderEvent {
  senderFrame: { url: string } | null
  sender: { mainFrame: { url: string } }
}

export function assertTrustedMemorySender(event: MemoryIpcSenderEvent): void {
  if (!event.senderFrame || event.senderFrame !== event.sender.mainFrame) {
    throw new Error('Memory rejected an untrusted frame')
  }
  const url = new URL(event.senderFrame.url)
  const localDev =
    (url.protocol === 'http:' || url.protocol === 'https:') &&
    (url.hostname === 'localhost' || url.hostname === '127.0.0.1')
  if (url.protocol !== 'file:' && !localDev) {
    throw new Error('Memory rejected an untrusted renderer origin')
  }
}
