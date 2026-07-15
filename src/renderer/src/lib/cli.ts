import { colors } from './tokens'

export type SupportedCli = 'claude' | 'codex' | 'agy' | 'opencode'

export const cliTint: Record<SupportedCli, string> = {
  claude: colors.agentClaude,
  codex: colors.agentCodex,
  agy: colors.agentGemini,
  opencode: colors.agentOpenCode
}

export const cliLabel: Record<SupportedCli, string> = {
  claude: 'Claude',
  codex: 'Codex',
  agy: 'Antigravity',
  opencode: 'OpenCode'
}
