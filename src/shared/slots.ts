export type SlotId = 'git' | 'review' | 'editor'
export type SlotProviderKind = 'builtin' | 'pane' | 'external' | 'handoff'

export interface SlotProvider {
  id: string
  label: string
  kind: SlotProviderKind
  requiresBin?: string
  installUrl?: string
  statusUrl?: string
}

export interface SlotDef {
  id: SlotId
  providers: SlotProvider[]
}

export type SlotChoices = Record<SlotId, string>
export type SlotAvailability = Record<string, boolean>

export const DEFAULT_SLOT_CHOICES: SlotChoices = {
  git: 'terminal',
  review: 'off',
  editor: 'morz'
}

export const SLOTS: readonly SlotDef[] = [
  {
    id: 'git',
    providers: [
      { id: 'terminal', label: 'Terminal', kind: 'builtin' },
      { id: 'morz-commit', label: 'Morz Commit', kind: 'builtin' },
      {
        id: 'lazygit',
        label: 'lazygit',
        kind: 'pane',
        requiresBin: 'lazygit',
        installUrl: 'https://github.com/jesseduffield/lazygit#installation'
      },
      {
        id: 'gitui',
        label: 'GitUI',
        kind: 'pane',
        requiresBin: 'gitui',
        installUrl: 'https://github.com/gitui-org/gitui#installation'
      }
    ]
  },
  {
    id: 'review',
    providers: [
      { id: 'off', label: 'Off', kind: 'builtin' },
      { id: 'morz-reviewer', label: 'Morz Reviewer', kind: 'builtin' },
      {
        id: 'coderabbit',
        label: 'CodeRabbit',
        kind: 'external',
        installUrl: 'https://www.coderabbit.ai/',
        statusUrl: 'https://app.coderabbit.ai/'
      },
      {
        id: 'greptile',
        label: 'Greptile',
        kind: 'external',
        installUrl: 'https://www.greptile.com/',
        statusUrl: 'https://app.greptile.com/'
      },
      {
        id: 'copilot',
        label: 'GitHub Copilot',
        kind: 'external',
        installUrl: 'https://github.com/features/copilot',
        statusUrl: 'https://github.com/pulls'
      }
    ]
  },
  {
    id: 'editor',
    providers: [
      { id: 'morz', label: 'Morz', kind: 'builtin' },
      {
        id: 'vscode',
        label: 'VS Code',
        kind: 'handoff',
        requiresBin: 'code',
        installUrl: 'https://code.visualstudio.com/download'
      },
      {
        id: 'cursor',
        label: 'Cursor',
        kind: 'handoff',
        requiresBin: 'cursor',
        installUrl: 'https://www.cursor.com/downloads'
      }
    ]
  }
] as const

export function findSlot(id: SlotId): SlotDef {
  return SLOTS.find((slot) => slot.id === id)!
}

export function findSlotProvider(slotId: SlotId, providerId: string): SlotProvider | undefined {
  return findSlot(slotId).providers.find((provider) => provider.id === providerId)
}

export const SlotsApi = {
  get: 'slots:get',
  set: 'slots:set',
  availability: 'slots:availability',
  openExternal: 'slots:open-external',
  testExternalOpens: 'slots:test-external-opens'
} as const

export interface SlotsBridge {
  get(): Promise<SlotChoices>
  set(id: SlotId, providerId: string): Promise<SlotChoices>
  availability(): Promise<SlotAvailability>
  openExternal(path: string, line?: number): Promise<void>
}

export interface SlotExternalOpen {
  command: string
  args: string[]
}

export interface SlotsTestBridge {
  externalOpens(): Promise<SlotExternalOpen[]>
}
