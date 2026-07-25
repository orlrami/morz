export type ContextProjectType = 'node' | 'python' | 'generic'

export type ContextFileKind =
  | 'claude'
  | 'agents'
  | 'gemini'
  | 'status'
  | 'readme'
  | 'claude-settings'
  | 'mcp'
  | 'codex-config'
  | 'opencode'

export type ContextFileStatus = 'present' | 'missing' | 'stale'

export interface ContextSpaceInput {
  id: string
  name: string
  root: string
}

export interface ContextFileState {
  kind: ContextFileKind
  label: string
  state: ContextFileStatus
  relativePath: string
  path: string
  lastTouchedAt: string | null
}

export interface ContextSpaceMatrix {
  id: string
  name: string
  root: string
  projectType: ContextProjectType
  staleCutoffAt: string | null
  files: ContextFileState[]
}

export interface ContextMatrix {
  scannedAt: string
  spaces: ContextSpaceMatrix[]
}

export interface ContextProposal {
  proposalId: string
  hash: string
  spaceId: string
  spaceName: string
  path: string
  relativePath: string
  label: string
  unifiedDiff: string
}

export interface ContextApplyResult {
  path: string
  backupPath: string | null
  created: boolean
}

export const ContextHubApi = {
  scan: 'context-hub:scan',
  proposeTemplate: 'context-hub:propose-template',
  proposeSharedBlock: 'context-hub:propose-shared-block',
  proposeMemoryBlock: 'context-hub:propose-memory-block',
  proposeStatusBlock: 'context-hub:propose-status-block',
  applyProposal: 'context-hub:apply-proposal',
  testStats: 'context-hub:test-stats'
} as const

export interface ContextTemplateInput {
  spaceId: string
  kind: 'claude' | 'agents' | 'status'
}

export interface ContextSharedBlockInput {
  name: string
  content: string
  spaceIds: string[]
  kind: 'claude' | 'agents' | 'gemini' | 'status' | 'readme'
}

export interface ContextMemoryBlockInput {
  spaceIds: string[]
}

export interface ContextStatusBlockInput {
  spaceIds: string[]
}

export interface ContextHubBridge {
  scan(spaces: ContextSpaceInput[]): Promise<ContextMatrix>
  proposeTemplate(input: ContextTemplateInput): Promise<ContextProposal>
  proposeSharedBlock(input: ContextSharedBlockInput): Promise<ContextProposal[]>
  proposeMemoryBlock(input: ContextMemoryBlockInput): Promise<ContextProposal[]>
  proposeStatusBlock(input: ContextStatusBlockInput): Promise<ContextProposal[]>
  applyProposal(proposalId: string): Promise<ContextApplyResult>
  testStats?(): Promise<{ scans: number }>
}
