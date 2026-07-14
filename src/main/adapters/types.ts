/*
 * AgentAdapter (0.0.3, w5/adapters) — owner: Agent 4.
 * ONE interface over the three agent CLIs (claude / codex / agy). The
 * dispatcher talks to this contract only; per-CLI quirks (stream-json control
 * channel, exec-per-turn NDJSON, PTY bracketed paste) stay inside each adapter.
 * Event payloads are the normalized AdapterEvent union from shared/ipc.ts.
 */
import type { AdapterCli, AdapterEvent } from '../../shared/ipc'

export interface AdapterStartOpts {
  agentId: string
  cwd: string
  /** CLI-native session/thread id to resume (claude --resume / codex exec resume). */
  resume?: string
}

/** Tool-permission request surfaced to the owner. Only claude can raise these
 * today (stream-json control channel); codex/agy adapters never call the
 * listener — their permission models live inside the CLI. */
export interface AdapterPermissionReq {
  agentId: string
  requestId: string
  tool: string
  input: unknown
}

export type AdapterEventListener = (agentId: string, event: AdapterEvent) => void
export type AdapterPermissionListener = (req: AdapterPermissionReq) => void

export interface AgentAdapter {
  readonly cli: AdapterCli
  /** Register/spawn a lane. Idempotent per agentId (restart semantics per CLI). */
  start(opts: AdapterStartOpts): { agentId: string }
  /** Deliver a user prompt to the lane. No-op if the lane is unknown. */
  send(agentId: string, text: string): void
  /** Cancel the in-flight turn, keep the lane usable. */
  interrupt(agentId: string): void
  /** Tear the lane down (kill the process tree, forget state). */
  stop(agentId: string): void
  /** Subscribe to normalized events for ALL lanes of this adapter. Returns unsubscribe. */
  onEvent(listener: AdapterEventListener): () => void
  /** Subscribe to permission requests. Returns unsubscribe. */
  onPermission(listener: AdapterPermissionListener): () => void
}
