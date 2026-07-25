import { defaultModulesEnabled, type ModuleId } from './modules'

export type OnboardingTargetId =
  | 'claude'
  | 'codex'
  | 'agy'
  | 'opencode'
  | 'lazygit'
  | 'gitui'
  | 'code'
  | 'cursor'
  | 'ollama'

export type OnboardingSlotId = 'git' | 'review' | 'editor'
export type OnboardingMode = 'manual' | 'assisted' | 'orchestrated'

export interface OnboardingTarget {
  id: OnboardingTargetId
  label: string
  executable: string
  getUrl: string
  models: readonly { value: string; label: string }[]
}

const INHERIT_MODEL = { value: 'inherit', label: 'Inherit CLI default' } as const

export const ONBOARDING_TARGETS: readonly OnboardingTarget[] = [
  {
    id: 'claude',
    label: 'Claude Code',
    executable: 'claude',
    getUrl: 'https://claude.ai/code',
    models: [
      INHERIT_MODEL,
      { value: 'fable', label: 'Fable' },
      { value: 'opus', label: 'Opus' },
      { value: 'sonnet', label: 'Sonnet' },
      { value: 'haiku', label: 'Haiku' }
    ]
  },
  {
    id: 'codex',
    label: 'Codex',
    executable: 'codex',
    getUrl: 'https://openai.com/codex/',
    models: [
      INHERIT_MODEL,
      { value: 'gpt-5.5', label: 'GPT-5.5' },
      { value: 'gpt-5.4', label: 'GPT-5.4' }
    ]
  },
  {
    id: 'agy',
    label: 'Antigravity',
    executable: 'agy',
    getUrl: 'https://antigravity.google/',
    models: [
      INHERIT_MODEL,
      { value: 'gemini-3.5-flash', label: 'Gemini 3.5 Flash' },
      { value: 'gemini-3.1-pro', label: 'Gemini 3.1 Pro' },
      { value: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6' },
      { value: 'claude-opus-4-6', label: 'Claude Opus 4.6' },
      { value: 'gpt-oss-120b', label: 'GPT-OSS 120B' }
    ]
  },
  {
    id: 'opencode',
    label: 'OpenCode',
    executable: 'opencode',
    getUrl: 'https://opencode.ai/',
    models: [
      INHERIT_MODEL,
      { value: 'anthropic/claude-sonnet-4-5', label: 'Anthropic / Claude Sonnet 4.5' },
      { value: 'openai/gpt-5.4', label: 'OpenAI / GPT-5.4' }
    ]
  },
  {
    id: 'lazygit',
    label: 'lazygit',
    executable: 'lazygit',
    getUrl: 'https://github.com/jesseduffield/lazygit',
    models: [INHERIT_MODEL]
  },
  {
    id: 'gitui',
    label: 'gitui',
    executable: 'gitui',
    getUrl: 'https://github.com/extrawurst/gitui',
    models: [INHERIT_MODEL]
  },
  {
    id: 'code',
    label: 'VS Code',
    executable: 'code',
    getUrl: 'https://code.visualstudio.com/',
    models: [INHERIT_MODEL]
  },
  {
    id: 'cursor',
    label: 'Cursor',
    executable: 'cursor',
    getUrl: 'https://cursor.com/',
    models: [INHERIT_MODEL]
  },
  {
    id: 'ollama',
    label: 'Ollama',
    executable: 'ollama',
    getUrl: 'https://ollama.com/',
    models: [INHERIT_MODEL]
  }
]

export interface OnboardingDetection {
  id: OnboardingTargetId
  installed: boolean
  version: string | null
}

export interface OnboardingSnapshot {
  completed: boolean
  modules: Record<ModuleId, boolean>
  models: Record<OnboardingTargetId, string>
  slots: Record<OnboardingSlotId, string>
  autonomy: OnboardingMode
}

export interface SlotProvider {
  id: string
  label: string
  requiresBin?: OnboardingTargetId
}

export interface OnboardingSlot {
  id: OnboardingSlotId
  label: string
  providers: readonly SlotProvider[]
}

export const ONBOARDING_SLOTS: readonly OnboardingSlot[] = [
  {
    id: 'git',
    label: 'Git surface',
    providers: [
      { id: 'terminal', label: 'Plain git' },
      { id: 'morz-commit', label: 'Morz Commit' },
      { id: 'lazygit', label: 'lazygit', requiresBin: 'lazygit' },
      { id: 'gitui', label: 'gitui', requiresBin: 'gitui' }
    ]
  },
  {
    id: 'review',
    label: 'Code review',
    providers: [
      { id: 'off', label: 'Off' },
      { id: 'morz-reviewer', label: 'Morz Reviewer' },
      { id: 'coderabbit', label: 'CodeRabbit' },
      { id: 'greptile', label: 'Greptile' },
      { id: 'copilot', label: 'GitHub Copilot' }
    ]
  },
  {
    id: 'editor',
    label: 'Editor',
    providers: [
      { id: 'morz', label: 'Morz IDE' },
      { id: 'vscode', label: 'VS Code', requiresBin: 'code' },
      { id: 'cursor', label: 'Cursor', requiresBin: 'cursor' }
    ]
  }
]

export function minimalOnboardingSnapshot(completed = false): OnboardingSnapshot {
  return {
    completed,
    modules: defaultModulesEnabled(),
    models: Object.fromEntries(ONBOARDING_TARGETS.map((target) => [target.id, 'inherit'])) as Record<
      OnboardingTargetId,
      string
    >,
    slots: { git: 'terminal', review: 'off', editor: 'morz' },
    autonomy: 'manual'
  }
}

export const OnboardingApi = {
  get: 'onboarding:get',
  detect: 'onboarding:detect',
  save: 'onboarding:save'
} as const

export interface MorzOnboardingApi {
  get(): Promise<OnboardingSnapshot>
  detect(): Promise<OnboardingDetection[]>
  save(snapshot: OnboardingSnapshot): Promise<OnboardingSnapshot>
}

