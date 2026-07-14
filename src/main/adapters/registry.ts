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
