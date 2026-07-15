import type { AssistantProvider } from '../../shared/ipc'

export interface LocalAssistantProvider extends AssistantProvider {
  kind: 'local'
  command: string
  handshakeArgs: string[]
  proposalArgs: string[]
  promptTransport: 'stdin' | 'argument' | 'file'
  output: 'text' | 'json-envelope'
}

export interface HostedAssistantProvider extends AssistantProvider {
  kind: 'hosted'
  loginUrl: string
  assistantUrl: string
  allowedHosts: string[]
  inputSelectors: string[]
  submitSelectors: string[]
  responseSelectors: string[]
}

export type AssistantProviderDescriptor = LocalAssistantProvider | HostedAssistantProvider

/** Thin, data-only registry. Commands are always passed to spawn as argv (never a shell string). */
export const ASSISTANT_PROVIDERS: readonly AssistantProviderDescriptor[] = [
  {
    id: 'hermes',
    name: 'Hermes',
    kind: 'local',
    description: 'Use your locally configured Nous Research Hermes assistant.',
    command: 'hermes',
    handshakeArgs: ['version'],
    proposalArgs: [
      'chat',
      '--safe-mode',
      '--toolsets',
      'clarify',
      '--max-turns',
      '1',
      '--quiet',
      '--source',
      'tool',
      '-q',
      '{prompt}'
    ],
    promptTransport: 'argument',
    output: 'text'
  },
  {
    id: 'openclaw',
    name: 'OpenClaw',
    kind: 'local',
    description: 'Use the default local OpenClaw agent and its existing authentication.',
    command: 'openclaw',
    handshakeArgs: ['status', '--json'],
    proposalArgs: ['infer', 'model', 'run', '--prompt', '{prompt}', '--json'],
    promptTransport: 'argument',
    output: 'json-envelope'
  },
  {
    id: 'comet',
    name: 'Perplexity Comet',
    kind: 'hosted',
    description: 'Sign in yourself in an isolated Perplexity pane; Morz never receives your credentials.',
    loginUrl: 'https://www.perplexity.ai/',
    assistantUrl: 'https://www.perplexity.ai/',
    allowedHosts: ['www.perplexity.ai', 'perplexity.ai'],
    inputSelectors: [
      'textarea[placeholder*="Ask"]',
      'textarea[placeholder*="follow-up"]',
      'textarea'
    ],
    submitSelectors: ['button[type="submit"]', 'button[aria-label*="Submit"]', 'button[aria-label*="Send"]'],
    responseSelectors: ['[data-testid="answer"]', '[data-testid="thread-message"]', '.prose']
  }
]

const STUB_PROVIDER: LocalAssistantProvider = {
  id: 'stub',
  name: 'Stub assistant',
  kind: 'local',
  description: 'Deterministic E2E provider.',
  command: 'stub',
  handshakeArgs: [],
  proposalArgs: [],
  promptTransport: 'stdin',
  output: 'text'
}

export function assistantProviderRegistry(includeStub = false): readonly AssistantProviderDescriptor[] {
  return includeStub ? [...ASSISTANT_PROVIDERS, STUB_PROVIDER] : ASSISTANT_PROVIDERS
}

export function publicAssistantProvider(provider: AssistantProviderDescriptor): AssistantProvider {
  return {
    id: provider.id,
    name: provider.name,
    kind: provider.kind,
    description: provider.description
  }
}
