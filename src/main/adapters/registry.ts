/*
 * Adapter registry (0.0.3, w5/adapters) — owner: Agent 4.
 * cli name → AgentAdapter. The dispatcher resolves lanes through here and
 * never imports a concrete adapter. NOTE: importing this module pulls in
 * claude.ts and therefore electron — main-process only (the smoke script
 * imports codex.ts/agy.ts directly instead).
 */
import type { AdapterCli } from '../../shared/ipc'
import type { AgentAdapter } from './types'
import { claudeAdapter } from './claude'
import { codexAdapter } from './codex'
import { agyAdapter } from './agy'

export const adapters: Record<AdapterCli, AgentAdapter> = {
  claude: claudeAdapter,
  codex: codexAdapter,
  agy: agyAdapter
}

export function getAdapter(cli: AdapterCli): AgentAdapter {
  return adapters[cli]
}

// w8/routing — deterministic consult stub, gated to the E2E process only.
export function installE2eConsultStub(): void {
  if (process.env.MORZ_E2E !== '1' || process.env.MORZ_E2E_CONSULT_STUB !== '1') return
  const listeners = new Set<Parameters<AgentAdapter['onEvent']>[0]>()
  const active = new Set<string>()
  adapters.codex = {
    cli: 'codex',
    start(opts) {
      active.add(opts.agentId)
      return { agentId: opts.agentId }
    },
    send(agentId) {
      queueMicrotask(() => {
        if (!active.has(agentId)) return
        for (const listener of listeners) {
          listener(agentId, {
            type: 'message',
            role: 'assistant',
            text: 'MORZ_E2E consult answer: verify the routing contract.'
          })
          listener(agentId, { type: 'result' })
        }
      })
    },
    interrupt(agentId) {
      active.delete(agentId)
    },
    stop(agentId) {
      active.delete(agentId)
    },
    onEvent(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    onPermission() {
      return () => {}
    }
  }
}
// end w8/routing
