import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { SpawnPlan } from '../../shared/spawn-plan'
import {
  extractSpawnPlanBlock,
  parseClaudeStreamOutput,
  planGoal,
  validateSpawnPlan
} from './planner'
import { assertPlanEditAllowed, hashSpawnPlan } from './plan-store'

const basePlan: SpawnPlan = {
  version: '1.0',
  id: '00000000-0000-4000-8000-000000000001',
  goal: 'Ship the planner',
  agents: [
    {
      agentId: 'builder',
      cli: 'claude',
      role: 'Planner builder',
      branch: 'run/planner/builder',
      worktree: null,
      cwd: '',
      promptSeed: 'Implement the planner and verify it.',
      dependsOn: [],
      port: null
    }
  ],
  spaceRoot: 'C:\\Projects\\morz-planner',
  caps: { maxUsd: null, maxTokens: null },
  createdAt: '2026-07-14T12:00:00.000Z',
  planHash: '0'.repeat(64)
}

function fenced(plan: unknown): string {
  return `\`\`\`json\n${JSON.stringify(plan)}\n\`\`\``
}

test('extractSpawnPlanBlock accepts exactly one JSON fence and rejects prose wrappers', () => {
  assert.deepEqual(extractSpawnPlanBlock(fenced(basePlan)), basePlan)
  assert.throws(() => extractSpawnPlanBlock(`Here is the plan:\n${fenced(basePlan)}`), /exactly/)
})

test('validateSpawnPlan accepts the shared contract and rejects unsafe planner fields', () => {
  const valid = validateSpawnPlan(basePlan)
  assert.equal(valid.ok, true)

  const invalid = structuredClone(basePlan) as SpawnPlan
  invalid.agents[0].branch = '../main'
  invalid.agents[0].worktree = 'C:\\owned'
  invalid.agents[0].port = 4444
  const result = validateSpawnPlan(invalid)
  assert.equal(result.ok, false)
  assert.match(result.issues.join('\n'), /branch/)
  assert.match(result.issues.join('\n'), /worktree/)
  assert.match(result.issues.join('\n'), /port/)

  const extraField = { ...basePlan, dispatchWithoutApproval: true }
  const extraResult = validateSpawnPlan(extraField)
  assert.equal(extraResult.ok, false)
  assert.match(extraResult.issues.join('\n'), /unknown field/)
})

test('parseClaudeStreamOutput reads JSONL events rather than regex-parsing terminal prose', () => {
  const output = [
    JSON.stringify({ type: 'system', subtype: 'init' }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: fenced(basePlan) }] } }),
    JSON.stringify({ type: 'result', result: fenced(basePlan) })
  ].join('\n')
  assert.equal(parseClaudeStreamOutput(output), fenced(basePlan))
  assert.throws(() => parseClaudeStreamOutput('{not-json}\n'), /invalid stream-json/)
})

test('planGoal retries one schema violation and returns a canonical non-placeholder hash', async () => {
  let calls = 0
  const plan = await planGoal('Ship the planner', 'C:\\Projects\\morz-planner', {
    createId: () => '00000000-0000-4000-8000-000000000001',
    now: () => '2026-07-14T12:00:00.000Z',
    runClaude: async () => {
      calls += 1
      if (calls === 1) return fenced({ ...basePlan, agents: [] })
      return fenced(basePlan)
    }
  })

  assert.equal(calls, 2)
  assert.equal(plan.planHash, hashSpawnPlan(plan))
  assert.notEqual(plan.planHash, '0'.repeat(64))
})

test('hashSpawnPlan is key-order stable and changes when an editable prompt changes', () => {
  const reordered = {
    planHash: basePlan.planHash,
    createdAt: basePlan.createdAt,
    caps: basePlan.caps,
    spaceRoot: basePlan.spaceRoot,
    agents: basePlan.agents,
    goal: basePlan.goal,
    id: basePlan.id,
    version: basePlan.version
  } as SpawnPlan
  assert.equal(hashSpawnPlan(basePlan), hashSpawnPlan(reordered))

  const edited = structuredClone(basePlan)
  edited.agents[0].promptSeed = 'A materially different prompt.'
  assert.notEqual(hashSpawnPlan(basePlan), hashSpawnPlan(edited))
})

test('plan edits allow prompt changes and removal but reject immutable field rewrites', () => {
  const promptEdit = structuredClone(basePlan)
  promptEdit.agents[0].promptSeed = 'New prompt'
  assert.doesNotThrow(() => assertPlanEditAllowed(basePlan, promptEdit))

  const goalRewrite = structuredClone(basePlan)
  goalRewrite.goal = 'A different goal'
  assert.throws(() => assertPlanEditAllowed(basePlan, goalRewrite), /immutable/)

  const branchRewrite = structuredClone(basePlan)
  branchRewrite.agents[0].branch = 'run/attacker'
  assert.throws(() => assertPlanEditAllowed(basePlan, branchRewrite), /immutable/)
})
