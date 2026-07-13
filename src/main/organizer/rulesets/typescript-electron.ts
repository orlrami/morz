import type { RuleDefinition } from '../rules'

export const typescriptElectronRules: RuleDefinition[] = [
  {
    id: 'boundaries/main-to-renderer',
    source: 'typescript-electron',
    cite: 'https://www.electronjs.org/docs/latest/tutorial/process-model',
    explanation: 'Electron main and renderer code execute with different privileges and trust boundaries. Main-process modules must not import renderer implementation modules; shared contracts belong in an explicitly shared layer so privileged code never acquires browser-only dependencies or accidentally collapses context-isolation boundaries.'
  }
]
