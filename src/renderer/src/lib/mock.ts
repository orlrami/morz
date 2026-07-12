/*
 * Phase-0 mock data. Honest placeholders for the coded prototype —
 * mirrors the approved design board so every surface shows real product content.
 * Replaced by live PTY/orchestrator state in Phase 1/2.
 */
import type { AgentStatus } from './tokens'
import { colors } from './tokens'

export type CliKind = 'claude' | 'codex' | 'agy' | 'opencode'

export const cliTint: Record<CliKind, string> = {
  claude: colors.agentClaude,
  codex: colors.agentCodex,
  agy: colors.agentGemini,
  opencode: colors.agentOpenCode
}

export const cliLabel: Record<CliKind, string> = {
  claude: 'Claude',
  codex: 'Codex',
  agy: 'agy',
  opencode: 'OpenCode'
}

export interface MockAgent {
  id: string
  name: string
  cli: CliKind
  model: string
  status: AgentStatus
  worktree: string
  activity: string
}

export interface MockSpace {
  id: string
  name: string
  branch: string
  agents: MockAgent[]
}

export const spaces: MockSpace[] = [
  {
    id: 'morz-core',
    name: 'morz-core',
    branch: 'main',
    agents: [
      {
        id: 'planner',
        name: 'planner',
        cli: 'claude',
        model: 'Opus',
        status: 'working',
        worktree: 'main',
        activity: 'Decomposing phase 5 · wave 2 of 2'
      },
      {
        id: 'builder-1',
        name: 'builder-1',
        cli: 'codex',
        model: 'gpt-5.5',
        status: 'working',
        worktree: 'wt/builder-1',
        activity: 'Writing burst-window tests for the rate limiter'
      },
      {
        id: 'builder-2',
        name: 'builder-2',
        cli: 'codex',
        model: 'gpt-5.5',
        status: 'blocked',
        worktree: 'wt/builder-2',
        activity: 'Waiting for approval — write to src/db/migrate.ts'
      },
      {
        id: 'math',
        name: 'math',
        cli: 'agy',
        model: 'Gemini',
        status: 'done',
        worktree: 'wt/math',
        activity: 'Returned pricing curve — verified by reviewer'
      },
      {
        id: 'reviewer',
        name: 'reviewer',
        cli: 'codex',
        model: 'high',
        status: 'idle',
        worktree: 'main',
        activity: 'Ready — refutes each diff before merge'
      }
    ]
  },
  { id: 'api-service', name: 'api-service', branch: 'feat/auth', agents: [] }
]

export interface MockBlock {
  id: string
  cmd: string
  output: { text: string; kind: 'plain' | 'add' | 'del' | 'path' }[][]
  exit: number
  cwd: string
  time: string
}

export const builder1Blocks: MockBlock[] = [
  {
    id: 'b1',
    cmd: 'codex exec "add rate limiter to src/api/limiter.ts"',
    output: [
      [{ text: '+ export const limiter = tokenBucket(60, 60_000)', kind: 'add' }],
      [
        { text: '+ app.use(limiter)', kind: 'add' },
        { text: '   · 2 files changed', kind: 'plain' }
      ]
    ],
    exit: 0,
    cwd: 'wt/builder-1',
    time: '1.9s'
  },
  {
    id: 'b2',
    cmd: 'npm test -- limiter',
    output: [
      [
        { text: 'PASS  ', kind: 'plain' },
        { text: '7 passed', kind: 'add' },
        { text: ' · 0 failed · 1.2s', kind: 'plain' }
      ]
    ],
    exit: 0,
    cwd: 'wt/builder-1',
    time: '1.2s'
  }
]

export const builder2Blocks: MockBlock[] = [
  {
    id: 'b3',
    cmd: 'git status',
    output: [
      [
        { text: 'modified: ', kind: 'plain' },
        { text: 'src/db/schema.sql', kind: 'path' }
      ],
      [
        { text: 'modified: ', kind: 'plain' },
        { text: 'src/db/migrate.ts', kind: 'path' }
      ]
    ],
    exit: 0,
    cwd: 'wt/builder-2',
    time: '0.1s'
  }
]

export interface BusEvent {
  id: string
  tag: 'HANDOFF' | 'DONE' | 'BLOCKED'
  text: string
}

export const busEvents: BusEvent[] = [
  { id: 'e1', tag: 'HANDOFF', text: 'planner → builder-1: task T-12 ready' },
  { id: 'e2', tag: 'DONE', text: 'math: pricing curve returned (verified)' },
  { id: 'e3', tag: 'BLOCKED', text: 'builder-2: awaiting migration approval' }
]

export interface PlanRow {
  id: string
  role: string
  task: string
  cli: CliKind
}

export const spawnPlan: PlanRow[] = [
  { id: 'p1', role: 'planner', task: 'decompose phase 5', cli: 'claude' },
  { id: 'p2', role: 'builder ×2', task: 'implement tasks', cli: 'codex' },
  { id: 'p3', role: 'math', task: 'pricing formulas', cli: 'agy' },
  { id: 'p4', role: 'reviewer', task: 'refute + gate', cli: 'codex' }
]

export interface PaletteAction {
  id: string
  group: string
  label: string
  hint?: string
}

export const paletteActions: PaletteAction[] = [
  { id: 'a1', group: 'agent', label: 'agent: focus builder-2 (blocked)', hint: 'needs you' },
  { id: 'a2', group: 'agent', label: 'agent: interrupt builder-1' },
  { id: 'a3', group: 'spawn', label: 'spawn: team from plan — 5 agents, 2 waves' },
  { id: 'a4', group: 'spawn', label: 'spawn: single Codex agent in new worktree' },
  { id: 'a5', group: 'skill', label: 'skill: review staged diff' },
  { id: 'a6', group: 'skill', label: 'skill: generate commit message' },
  { id: 'a7', group: 'view', label: 'view: toggle file explorer' },
  { id: 'a8', group: 'view', label: 'view: open commit panel' }
]
