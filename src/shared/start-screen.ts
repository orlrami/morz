import type { CliId } from './connections'

export type StartSession = 'shell' | CliId
export type StartModel = 'inherit' | string

export interface StartModelOption {
  value: string
  label: string
}

export const START_MODEL_CATALOGS: Readonly<Record<CliId, readonly StartModelOption[]>> = {
  claude: [
    { value: 'fable', label: 'Fable 5' },
    { value: 'opus', label: 'Opus 4.8' },
    { value: 'sonnet', label: 'Sonnet 4.6' },
    { value: 'haiku', label: 'Haiku 4.5' }
  ],
  codex: [
    { value: 'gpt-5.5', label: 'GPT-5.5' },
    { value: 'gpt-5.4', label: 'GPT-5.4' }
  ],
  agy: [
    { value: 'gemini-3.5-flash', label: 'Gemini 3.5 Flash' },
    { value: 'gemini-3.1-pro', label: 'Gemini 3.1 Pro' },
    { value: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6' },
    { value: 'claude-opus-4-6', label: 'Claude Opus 4.6' },
    { value: 'gpt-oss-120b', label: 'GPT-OSS 120B' }
  ],
  opencode: [
    {
      value: 'anthropic/claude-sonnet-4-5',
      label: 'Anthropic / Claude Sonnet 4.5'
    }
  ]
}

export interface StartLaunchSpec {
  shell?: CliId
  argv: string[]
  command: string
  inheritsCliDefault: boolean
}

const MAX_GOAL_LENGTH = 16_000

function displayArg(value: string): string {
  if (/^[A-Za-z0-9_./:@+-]+$/.test(value)) return value
  return JSON.stringify(value)
}

export function buildStartLaunch(
  session: StartSession,
  model: StartModel,
  rawGoal: string
): StartLaunchSpec {
  const goal = rawGoal.trim().slice(0, MAX_GOAL_LENGTH)
  if (session === 'shell') {
    return { argv: [], command: 'Your default shell', inheritsCliDefault: true }
  }

  const argv: string[] = []
  if (model !== 'inherit') {
    argv.push(session === 'codex' ? '-m' : '--model', model)
  }
  if (goal) argv.push(goal)

  return {
    shell: session,
    argv,
    command: [session, ...argv].map(displayArg).join(' '),
    inheritsCliDefault: model === 'inherit'
  }
}
