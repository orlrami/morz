import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { SpawnPlan } from '../../shared/spawn-plan'
import {
  extractSpawnPlanBlock,
  parseClaudeStreamOutput,
  planGoal,
  planGoalWithEngine,
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
  assert.deepEqual(valid.warnings, [])

  const invalid = structuredClone(basePlan) as SpawnPlan
  invalid.agents[0].worktree = 'C:\\owned'
  invalid.agents[0].port = 4444
  const result = validateSpawnPlan(invalid)
  assert.equal(result.ok, false)
  assert.match(result.issues.join('\n'), /worktree/)
  assert.match(result.issues.join('\n'), /port/)

  const extraField = { ...basePlan, dispatchWithoutApproval: true }
  const extraResult = validateSpawnPlan(extraField)
  assert.equal(extraResult.ok, false)
  assert.match(extraResult.issues.join('\n'), /unknown field/)
})

test('validateSpawnPlan repairs overlong roles and unsafe branches with warnings', () => {
  const verbose = structuredClone(basePlan) as SpawnPlan
  verbose.agents[0].role = 'planner builder '.repeat(40) // 640 chars
  verbose.agents[0].branch = '../Main Branch!.lock'
  const result = validateSpawnPlan(verbose)
  assert.equal(result.ok, true)
  assert.equal(result.value?.agents[0].role.length, 200)
  assert.equal(result.value?.agents[0].branch, 'main-branch-lock')
  assert.match(result.warnings.join('\n'), /role/)
  assert.match(result.warnings.join('\n'), /branch/)

  const colliding = structuredClone(basePlan) as SpawnPlan
  colliding.agents.push({ ...structuredClone(colliding.agents[0]), agentId: 'reviewer' })
  const deduped = validateSpawnPlan(colliding)
  assert.equal(deduped.ok, true)
  assert.equal(deduped.value?.agents[1].branch, 'run/planner/builder-2')
  assert.match(deduped.warnings.join('\n'), /duplicated/)
})

test('validateSpawnPlan still hard-rejects genuinely broken agent shapes', () => {
  const noAgentId = structuredClone(basePlan) as SpawnPlan
  delete (noAgentId.agents[0] as Partial<SpawnPlan['agents'][0]>).agentId
  assert.equal(validateSpawnPlan(noAgentId).ok, false)

  const badCli = structuredClone(basePlan)
  ;(badCli.agents[0] as { cli: string }).cli = 'rm-rf'
  assert.equal(validateSpawnPlan(badCli).ok, false)

  const emptySeed = structuredClone(basePlan)
  emptySeed.agents[0].promptSeed = ''
  assert.equal(validateSpawnPlan(emptySeed).ok, false)
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

test('a repaired plan is accepted on the first attempt without consuming the retry', async () => {
  let calls = 0
  const result = await planGoalWithEngine('Ship the planner', 'C:\\Projects\\morz-planner', 'claude', {
    createId: () => '00000000-0000-4000-8000-000000000001',
    now: () => '2026-07-14T12:00:00.000Z',
    runClaude: async () => {
      calls += 1
      const verbose = structuredClone(basePlan) as SpawnPlan
      verbose.goal = '*' // Main-substituted goal placeholder
      verbose.agents[0].role = 'x'.repeat(500)
      verbose.agents[0].branch = 'Feature/Über Branch'
      return fenced(verbose)
    }
  })

  assert.equal(calls, 1)
  assert.equal(result.engine, 'claude')
  assert.equal(result.plan.goal, 'Ship the planner')
  assert.equal(result.plan.agents[0].role.length, 200)
  assert.equal(result.plan.agents[0].branch, 'feature/-ber-branch')
  assert.ok(result.warnings.length >= 2)
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

// w14/multi-agent-plan
test('validateSpawnPlan drops self-edges and breaks dependsOn cycles with warnings', () => {
  const selfDep = structuredClone(basePlan) as SpawnPlan
  selfDep.agents[0].dependsOn = ['builder', 'external-task']
  const selfResult = validateSpawnPlan(selfDep)
  assert.equal(selfResult.ok, true)
  assert.deepEqual(selfResult.value?.agents[0].dependsOn, ['external-task'])
  assert.match(selfResult.warnings.join('\n'), /self-edge/)

  const cyclic = structuredClone(basePlan) as SpawnPlan
  cyclic.agents.push({
    ...structuredClone(cyclic.agents[0]),
    agentId: 'reviewer',
    branch: 'run/planner/reviewer'
  })
  cyclic.agents[0].dependsOn = ['reviewer']
  cyclic.agents[1].dependsOn = ['builder']
  const cycleResult = validateSpawnPlan(cyclic)
  assert.equal(cycleResult.ok, true)
  assert.deepEqual(cycleResult.value?.agents[0].dependsOn, [])
  assert.deepEqual(cycleResult.value?.agents[1].dependsOn, [])
  assert.match(cycleResult.warnings.join('\n'), /cycle/)

  const acyclic = structuredClone(cyclic) as SpawnPlan
  acyclic.agents[0].dependsOn = []
  acyclic.agents[1].dependsOn = ['builder']
  const acyclicResult = validateSpawnPlan(acyclic)
  assert.deepEqual(acyclicResult.value?.agents[1].dependsOn, ['builder'])
  assert.deepEqual(acyclicResult.warnings, [])
})

test('the planner surfaces recommendedTeamSize + rationale and threads team constraints', async () => {
  const prompts: string[] = []
  const result = await planGoalWithEngine(
    'Build a Tetris game',
    'C:\\Projects\\morz-planner',
    'claude',
    {
      createId: () => '00000000-0000-4000-8000-000000000001',
      now: () => '2026-07-14T12:00:00.000Z',
      runClaude: async (prompt) => {
        prompts.push(prompt)
        return fenced({
          ...structuredClone(basePlan),
          goal: '*',
          recommendedTeamSize: 3,
          rationale: 'architecture, implementation, and math split by strength'
        })
      }
    },
    { teamSize: 3, team: [{ role: 'Builder', cli: 'codex' }] }
  )

  assert.equal(result.recommendedTeamSize, 3)
  assert.match(result.teamRationale ?? '', /split by strength/)
  assert.match(prompts[0], /exactly 3 agents/)
  assert.match(prompts[0], /"cli":"codex"/)
  assert.equal(result.plan.goal, 'Build a Tetris game')
})

test('plan edits may append a new agent but never take over an original branch', () => {
  const appended = structuredClone(basePlan)
  appended.agents.push({
    agentId: 'reviewer',
    cli: 'codex',
    role: 'Reviewer',
    branch: 'run/planner/reviewer',
    worktree: null,
    cwd: '',
    promptSeed: 'Review the implementation.',
    dependsOn: ['builder'],
    port: null
  })
  assert.doesNotThrow(() => assertPlanEditAllowed(basePlan, appended))

  const takeover = structuredClone(appended)
  takeover.agents[1].branch = basePlan.agents[0].branch
  assert.throws(() => assertPlanEditAllowed(basePlan, takeover), /immutable/)

  const idSwap = structuredClone(basePlan)
  idSwap.agents[0].agentId = 'attacker'
  assert.throws(() => assertPlanEditAllowed(basePlan, idSwap), /immutable/)

  const prepend = structuredClone(appended)
  prepend.agents.reverse()
  assert.throws(() => assertPlanEditAllowed(basePlan, prepend), /immutable|append/)
})
// end w14/multi-agent-plan

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
