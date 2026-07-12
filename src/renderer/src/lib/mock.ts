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
  agy: 'Antigravity',
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

export interface CliUsage {
  cli: CliKind
  /** % of the current rate-limit window consumed (membership-dependent). */
  used: number
  resetIn: string
  plan: string
}

/* Hourly/rolling limit consumption per CLI — depends on each membership. */
export const cliUsages: CliUsage[] = [
  { cli: 'claude', used: 62, resetIn: '2h 10m', plan: 'Max' },
  { cli: 'codex', used: 41, resetIn: '3h 45m', plan: 'Pro' },
  { cli: 'agy', used: 78, resetIn: '55m', plan: 'Pro' },
  { cli: 'opencode', used: 12, resetIn: '4h', plan: 'BYOK' }
]

export interface PaletteAction {
  id: string
  group: string
  label: string
  hint?: string
}

/* ── P2 surfaces ─────────────────────────────────────────────── */

export interface TreeNode {
  name: string
  kind: 'dir' | 'file'
  change?: 'M' | 'A' | 'D'
  children?: TreeNode[]
}

export const fileTree: TreeNode[] = [
  {
    name: 'src',
    kind: 'dir',
    children: [
      {
        name: 'api',
        kind: 'dir',
        children: [
          { name: 'limiter.ts', kind: 'file', change: 'M' },
          { name: 'limiter.test.ts', kind: 'file', change: 'A' },
          { name: 'routes.ts', kind: 'file' }
        ]
      },
      {
        name: 'db',
        kind: 'dir',
        children: [
          { name: 'schema.sql', kind: 'file', change: 'M' },
          { name: 'migrate.ts', kind: 'file', change: 'M' }
        ]
      },
      { name: 'index.ts', kind: 'file' }
    ]
  },
  {
    name: 'docs',
    kind: 'dir',
    children: [{ name: 'phase-5.md', kind: 'file' }]
  },
  { name: 'package.json', kind: 'file' },
  { name: 'README.md', kind: 'file' }
]

export interface ChangedFile {
  path: string
  change: 'M' | 'A' | 'D'
  staged: boolean
  agent: string
}

export const changedFiles: ChangedFile[] = [
  { path: 'src/api/limiter.ts', change: 'M', staged: true, agent: 'builder-1' },
  { path: 'src/api/limiter.test.ts', change: 'A', staged: true, agent: 'builder-1' },
  { path: 'src/db/schema.sql', change: 'M', staged: false, agent: 'builder-2' },
  { path: 'src/db/migrate.ts', change: 'M', staged: false, agent: 'builder-2' }
]

export interface DiffLine {
  kind: 'ctx' | 'add' | 'del' | 'hunk'
  text: string
}

export const limiterDiff: DiffLine[] = [
  { kind: 'hunk', text: '@@ -12,6 +12,9 @@ export function createApi(app: Express)' },
  { kind: 'ctx', text: "import { tokenBucket } from './util/bucket'" },
  { kind: 'ctx', text: '' },
  { kind: 'add', text: 'export const limiter = tokenBucket(60, 60_000)' },
  { kind: 'add', text: 'app.use(limiter)' },
  { kind: 'ctx', text: 'app.use(json())' },
  { kind: 'hunk', text: '@@ -40,4 +43,8 @@ export function createApi(app: Express)' },
  { kind: 'del', text: 'const RATE = Infinity // TODO' },
  { kind: 'add', text: 'const RATE = 60 // requests / minute / key' },
  { kind: 'ctx', text: 'export default createApi' }
]

export interface Finding {
  id: string
  severity: 'high' | 'medium' | 'low'
  file: string
  line: number
  title: string
  detail: string
  refutedBy: string
}

export const findings: Finding[] = [
  {
    id: 'f1',
    severity: 'high',
    file: 'src/api/limiter.ts',
    line: 14,
    title: 'Limiter keyed globally, not per client',
    detail:
      'tokenBucket(60, 60_000) creates one shared bucket. One noisy client exhausts the window for everyone. Key the bucket by API key or IP.',
    refutedBy: 'reviewer (Codex) — cross-model'
  },
  {
    id: 'f2',
    severity: 'medium',
    file: 'src/db/migrate.ts',
    line: 8,
    title: 'Migration lacks a down() path',
    detail: 'users.plan column is added with no rollback. A failed deploy leaves the schema stranded.',
    refutedBy: 'reviewer (Codex) — cross-model'
  },
  {
    id: 'f3',
    severity: 'low',
    file: 'src/api/limiter.test.ts',
    line: 31,
    title: 'Burst test never asserts recovery',
    detail: 'The test drains the bucket but never verifies refill after the window elapses.',
    refutedBy: 'reviewer (Codex) — cross-model'
  }
]

export interface DagNode {
  id: string
  label: string
  cli: CliKind
  wave: 1 | 2
  status: 'done' | 'working' | 'blocked' | 'pending'
  dod: string
}

export const dagNodes: DagNode[] = [
  { id: 'n1', label: 'decompose phase 5', cli: 'claude', wave: 1, status: 'done', dod: 'tasks.md written' },
  { id: 'n2', label: 'pricing formulas', cli: 'agy', wave: 1, status: 'done', dod: 'curve verified' },
  { id: 'n3', label: 'rate limiter', cli: 'codex', wave: 2, status: 'working', dod: 'tests green' },
  { id: 'n4', label: 'plan migration', cli: 'codex', wave: 2, status: 'blocked', dod: 'migration applied' },
  { id: 'n5', label: 'refute + gate', cli: 'codex', wave: 2, status: 'pending', dod: 'no open findings' }
]

export const dagEdges: [string, string][] = [
  ['n1', 'n3'],
  ['n1', 'n4'],
  ['n2', 'n4'],
  ['n3', 'n5'],
  ['n4', 'n5']
]

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
