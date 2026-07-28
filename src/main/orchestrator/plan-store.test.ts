import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import type { SpawnPlan } from '../../shared/spawn-plan'
import { PlanStore } from './plan-store'

const root = mkdtempSync(join(tmpdir(), 'morz-plan-store-'))
after(() => rmSync(root, { recursive: true, force: true }))

function candidate(id: string): SpawnPlan {
  return {
    version: '1.0',
    id,
    goal: 'Ship persistence',
    agents: [
      {
        agentId: 'builder',
        cli: 'claude',
        model: null,
        role: 'Builder',
        branch: `run/${id}/builder`,
        worktree: null,
        cwd: '',
        promptSeed: 'Build it.',
        dependsOn: [],
        port: null
      }
    ],
    spaceRoot: 'C:\\Projects\\morz-planner',
    caps: { maxUsd: null, maxTokens: null },
    createdAt: '2026-07-14T12:00:00.000Z',
    planHash: '0'.repeat(64)
  }
}

test('persists DRAFT to PROPOSED, re-hashes edits, and dispatch-gates on the latest hash', () => {
  const store = new PlanStore(join(root, 'plans.db'))
  const draft = store.createDraft(candidate('plan-state'))
  assert.equal(draft.state, 'DRAFT')

  const proposed = store.propose(draft.plan.id)
  assert.equal(proposed.state, 'PROPOSED')
  const oldHash = proposed.plan.planHash

  const edited = structuredClone(proposed.plan)
  edited.agents[0].promptSeed = 'Build it and run the verification suite.'
  const updated = store.updateProposed(edited, oldHash)
  assert.notEqual(updated.plan.planHash, oldHash)
  assert.throws(() => store.approve(oldHash), /not found/)

  const approved = store.approve(updated.plan.planHash)
  assert.equal(approved.state, 'APPROVED')
  assert.throws(() => store.approve(updated.plan.planHash), /awaiting approval/)
  store.close()
})

test('persists one-agent amendments behind their own approval hash', () => {
  const store = new PlanStore(join(root, 'amendments.db'))
  const draft = store.createDraft(candidate('plan-amend'))
  const proposed = store.propose(draft.plan.id)
  store.approve(proposed.plan.planHash)

  assert.throws(
    () =>
      store.createAmendment(
        draft.plan.id,
        {
          kind: 'replace',
          replaceAgentId: 'missing-agent',
          agent: { ...draft.plan.agents[0], agentId: 'replacement' }
        },
        '2026-07-14T12:04:00.000Z'
      ),
    /does not exist/
  )

  const record = store.createAmendment(
    draft.plan.id,
    {
      kind: 'add',
      agent: {
        agentId: 'reviewer',
        cli: 'codex',
        model: null,
        role: 'Reviewer',
        branch: 'run/plan-amend/reviewer',
        worktree: null,
        cwd: '',
        promptSeed: 'Review the implementation.',
        dependsOn: [],
        port: null
      }
    },
    '2026-07-14T12:05:00.000Z'
  )
  assert.equal(record.state, 'PROPOSED')
  assert.equal(record.amendment.amendmentHash.length, 64)
  assert.equal(store.approveAmendment(record.amendment.amendmentHash).state, 'APPROVED')
  store.close()
})

test('recovers a crash-persisted draft as proposed without approving it', () => {
  const path = join(root, 'recovery.db')
  const first = new PlanStore(path)
  first.createDraft(candidate('plan-recovery'))
  first.close()

  const reopened = new PlanStore(path)
  const recovered = reopened.listOpen().plans.find((record) => record.plan.id === 'plan-recovery')
  assert.equal(recovered?.state, 'PROPOSED')
  reopened.close()
})
