import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import type Database from 'better-sqlite3'
import type { CliConnection, CliId } from '../../shared/connections'
import type { PlannerEngine } from '../../shared/ipc'
import type { SpawnPlan } from '../../shared/spawn-plan'
import {
  buildOpenCodePlannerArgs,
  extractSpawnPlanBlock,
  normalizePlannerEngine,
  parseClaudeStreamOutput,
  planGoal,
  planGoalWithEngine,
  PlannerEngineStore,
  validateSpawnPlan
} from './planner'
import { assertPlanEditAllowed, hashSpawnPlan } from './plan-store'

const basePlan: SpawnPlan = {
  version: '1.1',
  id: '00000000-0000-4000-8000-000000000001',
  goal: 'Ship the planner',
  agents: [
    {
      agentId: 'builder',
      cli: 'claude',
      model: null,
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

/** Planning always runs against a roster; tests supply one instead of the
 * live CONNECTIONS service (which needs Electron). */
function connection(id: CliId, state: Partial<CliConnection> = {}): CliConnection {
  return {
    id,
    label: id,
    installed: true,
    present: true,
    version: '1.0.0',
    detectedAt: 0,
    versionStale: false,
    update: null,
    authed: true,
    plan: null,
    model: null,
    usage: null,
    ...state
  }
}

const allDetected: CliConnection[] = ['claude', 'codex', 'agy', 'opencode'].map((id) =>
  connection(id as CliId)
)

test('extractSpawnPlanBlock accepts exactly one JSON fence and rejects prose wrappers', () => {
  assert.deepEqual(extractSpawnPlanBlock(fenced(basePlan)), basePlan)
  assert.throws(() => extractSpawnPlanBlock(`Here is the plan:\n${fenced(basePlan)}`), /exactly/)
})

test('OpenCode planner uses the documented non-interactive run command and strict JSON extraction', async () => {
  assert.deepEqual(
    buildOpenCodePlannerArgs('Plan this', ['--model', 'anthropic/claude-sonnet-4-5']),
    ['run', '--model', 'anthropic/claude-sonnet-4-5', 'Plan this']
  )

  const engines: PlannerEngine[] = []
  const result = await planGoalWithEngine(
    'Ship the planner',
    'C:\\Projects\\morz-planner',
    'opencode',
    {
      createId: () => '00000000-0000-4000-8000-000000000001',
      now: () => '2026-07-14T12:00:00.000Z',
      connections: allDetected,
      runEngine: async (engine) => {
        engines.push(engine)
        return fenced(basePlan)
      }
    }
  )

  assert.deepEqual(engines, ['opencode'])
  assert.equal(result.engine, 'opencode')
  await assert.rejects(
    planGoalWithEngine('Ship the planner', 'C:\\Projects\\morz-planner', 'opencode', {
      connections: allDetected,
      runEngine: async () => `Here is the plan:\n${fenced(basePlan)}`
    }),
    /exactly one json block/
  )
})

test('planner engine normalization accepts OpenCode and rejects unknown engines', () => {
  assert.equal(normalizePlannerEngine('opencode'), 'opencode')
  assert.throws(() => normalizePlannerEngine('openai'), /opencode/)
})

test('planner engine migration is rename-copy-drop and preserves the saved w15 engine', () => {
  const db = new DatabaseSync(':memory:')
  try {
    db.exec(`
      CREATE TABLE orchestrator_planner_settings (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        engine TEXT NOT NULL CHECK (engine IN ('fast', 'claude', 'codex', 'local')),
        claude_model TEXT NOT NULL DEFAULT 'sonnet' CHECK (claude_model IN ('sonnet', 'opus', 'fable')),
        updated_at TEXT NOT NULL
      );
      INSERT INTO orchestrator_planner_settings (id, engine, claude_model, updated_at)
      VALUES (1, 'local', 'opus', '2026-07-20T00:00:00.000Z');
    `)
    const store = new PlannerEngineStore(db as unknown as Database.Database)
    assert.equal(store.get(), 'local')
    assert.equal(store.set('opencode'), 'opencode')
    store.close()

    const schema = db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'orchestrator_planner_settings'")
      .get() as { sql: string }
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'orchestrator_planner_settings_%'")
      .all()
    const row = db
      .prepare('SELECT engine, claude_model FROM orchestrator_planner_settings WHERE id = 1')
      .get() as { engine: string; claude_model: string }

    assert.match(schema.sql, /'opencode'/)
    assert.deepEqual(tables, [])
    assert.equal(row.engine, 'opencode')
    assert.equal(row.claude_model, 'opus')
  } finally {
    db.close()
  }
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

test('SpawnPlan 1.0 carries no model while 1.1 round-trips an explicit model', () => {
  // A valid 1.0 plan simply has no model field — it must still type-check and
  // validate, normalizing to an explicit null.
  const legacy = {
    ...structuredClone(basePlan),
    version: '1.0',
    agents: basePlan.agents.map(({ model: _model, ...agent }) => agent)
  }
  const normalized = validateSpawnPlan(legacy)
  assert.equal(normalized.ok, true)
  assert.equal(normalized.value?.version, '1.0')
  assert.equal(normalized.value?.agents[0].model, null)
  assert.deepEqual(normalized.warnings, [])

  // A 1.0 payload that smuggles a model is NOT honored as 1.1 behavior.
  const legacyWithModel = {
    ...structuredClone(basePlan),
    version: '1.0',
    agents: [{ ...structuredClone(basePlan.agents[0]), model: 'opus' }]
  }
  const stripped = validateSpawnPlan(legacyWithModel)
  assert.equal(stripped.ok, true)
  assert.equal(stripped.value?.version, '1.0')
  assert.equal(stripped.value?.agents[0].model, null)
  assert.match(stripped.warnings.join('\n'), /not part of SpawnPlan 1\.0/)

  const current = {
    ...structuredClone(basePlan),
    version: '1.1',
    agents: [
      {
        ...structuredClone(basePlan.agents[0]),
        cli: 'opencode',
        model: 'anthropic/claude-sonnet-4-5'
      }
    ]
  }
  const roundTripped = validateSpawnPlan(current)
  assert.equal(roundTripped.ok, true)
  assert.equal(roundTripped.value?.version, '1.1')
  assert.equal(roundTripped.value?.agents[0].cli, 'opencode')
  assert.equal(roundTripped.value?.agents[0].model, 'anthropic/claude-sonnet-4-5')
})

test('planner prompt lists only detected CLIs and corrects an undetected model proposal', async () => {
  const prompts: string[] = []
  let calls = 0
  const result = await planGoalWithEngine(
    'Ship the planner',
    'C:\\Projects\\morz-planner',
    'claude',
    {
      createId: () => '00000000-0000-4000-8000-000000000001',
      now: () => '2026-07-14T12:00:00.000Z',
      connections: [
        connection('claude'),
        connection('codex', { installed: false, present: false, version: null, authed: null })
      ],
      runEngine: async (_engine, prompt) => {
        prompts.push(prompt)
        calls += 1
        if (calls === 1) {
          return fenced({
            ...structuredClone(basePlan),
            version: '1.1',
            agents: [{ ...structuredClone(basePlan.agents[0]), cli: 'codex', model: 'gpt-5.6-sol' }]
          })
        }
        return fenced({
          ...structuredClone(basePlan),
          version: '1.1',
          agents: [{ ...structuredClone(basePlan.agents[0]), model: 'opus' }]
        })
      }
    }
  )

  assert.equal(result.plan.agents[0].model, 'opus')
  assert.match(prompts[0], /claude.*sonnet.*opus.*fable/is)
  assert.doesNotMatch(prompts[0], /gpt-5\.6-sol/)
  assert.match(prompts[1], /codex.*not detected/is)
})

test('a CLI whose executable disappeared is no longer planner-eligible', () => {
  const removed = [
    // Uninstalled between probes: the last known version stays for the UI, but
    // nothing resolves on PATH any more.
    connection('claude', { present: false, versionStale: true }),
    connection('codex')
  ]
  const result = validateSpawnPlan(basePlan, { connections: removed })
  assert.equal(result.ok, false)
  assert.match(result.issues.join('\n'), /claude is not detected; available CLIs: codex/)
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
    connections: allDetected,
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
    connections: allDetected,
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

// w15/planner-fast-default — the 'fast' engine races Claude against Codex.
test('the fast engine falls through to Codex when Claude cannot produce a plan', async () => {
  const engines: string[] = []
  const result = await planGoalWithEngine('Ship the planner', 'C:\\Projects\\morz-planner', 'fast', {
    createId: () => '00000000-0000-4000-8000-000000000001',
    now: () => '2026-07-14T12:00:00.000Z',
    connections: allDetected,
    runEngine: async (engine) => {
      engines.push(engine)
      if (engine === 'claude') throw new Error('claude unavailable')
      return fenced(basePlan)
    }
  })
  assert.equal(result.engine, 'codex')
  assert.ok(engines.includes('claude'))
  assert.ok(engines.includes('codex'))
})

test('the fast engine returns the first valid plan without waiting for the loser', async () => {
  let codexSettled = false
  const result = await planGoalWithEngine('Ship the planner', 'C:\\Projects\\morz-planner', 'fast', {
    createId: () => '00000000-0000-4000-8000-000000000001',
    now: () => '2026-07-14T12:00:00.000Z',
    connections: allDetected,
    runEngine: (engine) => {
      if (engine === 'claude') return Promise.resolve(fenced(basePlan))
      return new Promise((resolve) =>
        setTimeout(() => {
          codexSettled = true
          resolve(fenced(basePlan))
        }, 150).unref()
      )
    }
  })
  assert.equal(result.engine, 'claude')
  assert.equal(codexSettled, false)
})

test('the fast engine surfaces both failures when neither contender delivers', async () => {
  await assert.rejects(
    planGoalWithEngine('Ship the planner', 'C:\\Projects\\morz-planner', 'fast', {
      createId: () => '00000000-0000-4000-8000-000000000001',
      now: () => '2026-07-14T12:00:00.000Z',
      connections: allDetected,
      runEngine: async () => {
        throw new Error('planner offline')
      }
    }),
    /Both fast planners failed/
  )
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
      connections: allDetected,
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
    model: null,
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
