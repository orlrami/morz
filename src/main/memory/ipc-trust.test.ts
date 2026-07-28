import assert from 'node:assert/strict'
import test from 'node:test'
import { assertTrustedMemorySender, type MemoryIpcSenderEvent } from './ipc-trust'

function event(
  frameUrl: string,
  options: { childFrame?: boolean } = {}
): MemoryIpcSenderEvent {
  const mainFrame = { url: frameUrl }
  return {
    senderFrame: options.childFrame ? { url: frameUrl } : mainFrame,
    sender: { mainFrame }
  }
}

test('memory IPC accepts only the main file or localhost renderer frame', () => {
  assert.doesNotThrow(() => assertTrustedMemorySender(event('file:///C:/Morz/index.html')))
  assert.doesNotThrow(() => assertTrustedMemorySender(event('http://localhost:5173/')))
  assert.doesNotThrow(() => assertTrustedMemorySender(event('https://127.0.0.1:5173/')))
})

test('memory IPC rejects child frames and remote renderer origins', () => {
  assert.throws(
    () => assertTrustedMemorySender(event('file:///C:/Morz/index.html', { childFrame: true })),
    /Memory rejected an untrusted frame/
  )
  assert.throws(
    () => assertTrustedMemorySender(event('https://attacker.example/')),
    /Memory rejected an untrusted renderer origin/
  )
  assert.throws(
    () => assertTrustedMemorySender({
      senderFrame: null,
      sender: { mainFrame: { url: 'file:///C:/Morz/index.html' } }
    }),
    /Memory rejected an untrusted frame/
  )
})
