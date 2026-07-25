import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test, mock } from 'node:test'
import Database from 'better-sqlite3'

const root = mkdtempSync(join(tmpdir(), 'morz-run-store-'))
after(() => rmSync(root, { recursive: true, force: true }))

mock.module('electron', { namedExports: { app: { getPath: () => root } } })

import { applyRunHistoryPolicy, _setDbForTest } from './run-store'

test('clearRun idempotency: re-clear is a no-op', async () => {
  // Let the store initialize the db in the temp dir
  const policy = 'last-5'
  
  // To test clearing, we need to insert a run first.
  const dbPath = join(root, 'Morz', 'morz.db')
  // We can't access it easily unless we let run-store create it first.
  // applyRunHistoryPolicy will trigger open() and create the schema.
  applyRunHistoryPolicy('my-space', policy)
  
  const db = new Database(dbPath)
  
  // Insert a terminal run
  db.prepare(`
    INSERT INTO orch_runs (run_id, run_tag, plan_hash, space_root, goal, state, plan_json, created_at)
    VALUES ('run-1', 'tag-1', 'hash-1', 'my-space', 'goal', 'done', '{}', '2026-07-25T00:00:00.000Z')
  `).run()
  
  // Clear it via policy
  const cleared1 = applyRunHistoryPolicy('my-space', 'last-0' as any)
  assert.equal(cleared1.length, 1)
  assert.equal(cleared1[0].runId, 'run-1')
  
  // Verify it has a cleared_at date
  const row1 = db.prepare('SELECT cleared_at FROM orch_runs WHERE run_id = ?').get('run-1') as any
  assert.ok(row1.cleared_at)
  
  // Try clearing again
  const cleared2 = applyRunHistoryPolicy('my-space', 'last-0' as any)
  // It shouldn't clear again because it's already cleared
  assert.equal(cleared2.length, 0)
  
  // Verify the cleared_at timestamp was NOT modified (idempotency)
  const row2 = db.prepare('SELECT cleared_at FROM orch_runs WHERE run_id = ?').get('run-1') as any
  assert.equal(row2.cleared_at, row1.cleared_at)
  
  db.close()
})
