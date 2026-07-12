import { contextBridge } from 'electron'

// Morz IPC bridge (renderer <-> main <-> pty-host).
// Phase 1 expands this: pty spawn/inject/resize/read, spaces, orchestrator, mailbox.
// Keep the surface small and typed (see src/shared/types.ts -> MorzApi).
const api = {
  version: '0.1.0'
}

contextBridge.exposeInMainWorld('morz', api)

export type ExposedApi = typeof api
