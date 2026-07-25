import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import type Database from 'better-sqlite3'
import type { MemoryEntry } from '../../shared/memory'
import {
  contentHash,
  ensureMemoryAuditTable,
  expireEntry,
  heuristicClassify,
  isActiveEntry,
  listMemoryOpAudit,
  migrateMemoryFtsSchema,
  parseClassifierOutput,
  reconcileCandidate,
  recordMemoryOpAudit,
  renderInjectionLines,
  restoreEntry,
  type MemoryCandidate
} from './opset'
import { splitMarkdownCandidates } from './bootstrap'

const root = mkdtempSync(join(tmpdir(), 'morz-memory-opset-'))
after(() => rmSync(root, { recursive: true, force: true }))

function entry(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    id: 'prefer-pnpm',
    scope: 'global',
    kind: 'rule',
    title: 'Use pnpm for JavaScript dependencies',
    body: 'Use pnpm unless the repository selects another package manager.',
    origin: 'learned',
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-01T00:00:00.000Z',
    enabled: true,
    ...overrides
  }
}

function candidate(overrides: Partial<MemoryCandidate> = {}): MemoryCandidate {
  const { createdAt: _c, updatedAt: _u, ...rest } = entry()
  return { ...rest, ...overrides }
}

/* ------------------------------------------------------ dedup + classify — */

test('memory bootstrap splits heading-bounded candidates to 2KB with source provenance', () => {
  const source = 'C:\\Projects\\fixture\\CLAUDE.md'
  const candidates = splitMarkdownCandidates({
    path: source,
    content: [
      'Preamble guidance.',
      '',
      '# Preferences',
      'Always use pnpm.',
      '',
      '## Testing',
      'x'.repeat(2_700)
    ].join('\n'),
    scope: 'project',
    scopeRef: 'C:\\Projects\\fixture'
  })

  assert.equal(candidates[0].title, 'CLAUDE.md')
  assert.equal(candidates[0].source, `${source}#CLAUDE.md`)
  assert.equal(candidates[1].title, 'Preferences')
  assert.equal(candidates[1].source, `${source}#Preferences`)
  assert.equal(candidates[2].title, 'Testing (part 1)')
  assert.equal(candidates[3].title, 'Testing (part 2)')
  assert.ok(candidates.every((item) => Buffer.byteLength(item.body, 'utf8') <= 2_048))
  assert.ok(candidates.every((item) => item.scope === 'project'))
  assert.ok(candidates.every((item) => item.scopeRef === 'C:\\Projects\\fixture'))
})

test('memory bootstrap candidate rerun reconciles to NOOP without classifier work', async () => {
  const [item] = splitMarkdownCandidates({
    path: 'C:\\Users\\builder\\.claude\\MEMORY.md',
    content: '# Package manager\nUse pnpm for JavaScript projects.',
    scope: 'global'
  })
  const existing: MemoryEntry = {
    ...item,
    createdAt: '2026-07-25T00:00:00.000Z',
    updatedAt: '2026-07-25T00:00:00.000Z'
  }
  let classifierCalls = 0

  const op = await reconcileCandidate(item, {
    sameScope: () => [existing],
    neighbors: () => [existing],
    classify: async () => {
      classifierCalls += 1
      return { op: 'ADD' }
    }
  })

  assert.equal(op.kind, 'noop')
  assert.equal(op.targetId, existing.id)
  assert.equal(classifierCalls, 0)
})

test('exact-hash pre-dedup returns NOOP without calling the classifier', async () => {
  const existing = entry()
  let classifierCalls = 0
  const op = await reconcileCandidate(
    candidate({ id: 'learned-abc', title: '  use PNPM for  JavaScript dependencies ' }),
    {
      sameScope: () => [existing],
      neighbors: () => [existing],
      classify: async () => {
        classifierCalls += 1
        return { op: 'ADD' }
      }
    }
  )
  assert.equal(op.kind, 'noop')
  assert.equal(op.targetId, existing.id)
  assert.equal(classifierCalls, 0)
})

test('contentHash normalizes whitespace and case but separates scopes', () => {
  assert.equal(
    contentHash(candidate({ title: 'USE pnpm  for JavaScript dependencies' })),
    contentHash(candidate())
  )
  assert.notEqual(
    contentHash(candidate({ scope: 'project', scopeRef: 'C:/x' })),
    contentHash(candidate())
  )
})

test('no same-scope neighbors classifies as ADD without the classifier', async () => {
  let classifierCalls = 0
  const op = await reconcileCandidate(candidate(), {
    sameScope: () => [],
    neighbors: () => [],
    classify: async () => {
      classifierCalls += 1
      return { op: 'NOOP' }
    }
  })
  assert.equal(op.kind, 'add')
  assert.equal(op.next?.title, candidate().title)
  assert.equal(classifierCalls, 0)
})

test('stubbed classifier UPDATE produces old→new payload; one batched call', async () => {
  const existing = entry()
  const next = candidate({
    id: 'learned-new',
    title: 'Use bun for JavaScript dependencies',
    body: 'The user switched from pnpm to bun.'
  })
  const calls: MemoryEntry[][] = []
  const op = await reconcileCandidate(next, {
    sameScope: () => [existing],
    neighbors: () => [existing],
    classify: async (_candidate, neighbors) => {
      calls.push(neighbors)
      return { op: 'UPDATE', targetId: existing.id, reason: 'supersedes pnpm rule' }
    }
  })
  assert.equal(calls.length, 1)
  assert.equal(op.kind, 'update')
  assert.equal(op.targetId, existing.id)
  assert.deepEqual(op.old, { title: existing.title, body: existing.body })
  assert.deepEqual(op.next, { title: next.title, body: next.body })
})

test('classifier DELETE keeps target snapshot and reason', async () => {
  const existing = entry()
  const op = await reconcileCandidate(candidate({ id: 'learned-del', title: 'Stop using pnpm' }), {
    sameScope: () => [existing],
    neighbors: () => [existing],
    classify: async () => ({ op: 'DELETE', targetId: existing.id, reason: 'no longer true' })
  })
  assert.equal(op.kind, 'delete')
  assert.equal(op.targetId, existing.id)
  assert.equal(op.reason, 'no longer true')
  assert.deepEqual(op.old, { title: existing.title, body: existing.body })
})

test('unknown targetId or classifier failure falls back safely', async () => {
  const existing = entry()
  const bogus = await reconcileCandidate(candidate({ id: 'learned-x', title: 'Different rule' }), {
    sameScope: () => [existing],
    neighbors: () => [existing],
    classify: async () => ({ op: 'UPDATE', targetId: 'not-a-neighbor' })
  })
  assert.equal(bogus.kind, 'add')

  const throwing = await reconcileCandidate(
    candidate({ id: 'learned-y', body: 'A different body entirely.' }),
    {
      sameScope: () => [existing],
      neighbors: () => [existing],
      classify: async () => {
        throw new Error('LLM down')
      }
    }
  )
  // Heuristic: identical normalized title → UPDATE against the existing row.
  assert.equal(throwing.kind, 'update')
  assert.equal(throwing.targetId, existing.id)
})

test('heuristicClassify matches by id or normalized title', () => {
  const existing = entry()
  assert.equal(heuristicClassify(candidate({ id: existing.id, title: 'Else' }), [existing]).op, 'UPDATE')
  assert.equal(heuristicClassify(candidate({ id: 'other', title: ' use PNPM for JavaScript  dependencies' }), [existing]).op, 'UPDATE')
  assert.equal(heuristicClassify(candidate({ id: 'other', title: 'Tests live next to code' }), [existing]).op, 'ADD')
})

test('parseClassifierOutput handles CLI json wrapper and fenced output', () => {
  const wrapped = JSON.stringify({ result: '```json\n{"op":"UPDATE","targetId":"a-b","reason":"dup"}\n```' })
  assert.deepEqual(parseClassifierOutput(wrapped), { op: 'UPDATE', targetId: 'a-b', reason: 'dup' })
  assert.throws(() => parseClassifierOutput('{"op":"MERGE"}'), /valid op/)
})

/* -------------------------------------------------------------- migration — */

/*
 * The production store uses better-sqlite3 (Electron ABI); these tests run
 * under plain node via tsx, so they drive the same SQL through node:sqlite —
 * the helpers only use prepare/get/all/run/exec, which both drivers share.
 */
function testDb(name: string): Database.Database {
  return new DatabaseSync(join(root, name)) as unknown as Database.Database
}

test('memory_fts migration is rename-copy-drop and preserves rows', () => {
  const db = testDb('migrate.db')
  db.exec(`
    CREATE VIRTUAL TABLE memory_fts USING fts5(id UNINDEXED, title, body, tokenize = 'unicode61');
    INSERT INTO memory_fts (id, title, body) VALUES ('a', 'Alpha title', 'Alpha body');
    INSERT INTO memory_fts (id, title, body) VALUES ('b', 'Beta title', 'Beta body');
  `)
  assert.equal(migrateMemoryFtsSchema(db), true)

  const sql = (db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'memory_fts'")
    .get() as { sql: string }).sql
  for (const column of ['valid_at', 'invalid_at', 'created_at', 'expired_at', 'source_run_id']) {
    assert.match(sql, new RegExp(column))
  }
  const rows = db.prepare('SELECT id FROM memory_fts ORDER BY id').all() as { id: string }[]
  assert.deepEqual(rows.map((row) => row.id), ['a', 'b'])
  const hit = db
    .prepare("SELECT id FROM memory_fts WHERE memory_fts MATCH 'alpha' AND expired_at IS NULL")
    .all() as { id: string }[]
  assert.deepEqual(hit.map((row) => row.id), ['a'])

  // Second run is a no-op (already migrated).
  assert.equal(migrateMemoryFtsSchema(db), false)
  db.close()
})

test('audit table records and lists applied ops newest-first', () => {
  const db = testDb('audit.db')
  ensureMemoryAuditTable(db)
  recordMemoryOpAudit(db, {
    op: 'add',
    memoryId: 'prefer-pnpm',
    next: { title: 'Use pnpm', body: 'Always.' },
    source: 'proposal:p1',
    ts: '2026-07-24T10:00:00.000Z'
  })
  recordMemoryOpAudit(db, {
    op: 'update',
    memoryId: 'prefer-bun',
    targetId: 'prefer-pnpm',
    old: { title: 'Use pnpm', body: 'Always.' },
    next: { title: 'Use bun', body: 'Switched.' },
    reason: 'superseded',
    source: 'proposal:p2',
    ts: '2026-07-24T11:00:00.000Z'
  })
  const rows = listMemoryOpAudit(db)
  assert.equal(rows.length, 2)
  assert.equal(rows[0].op, 'update')
  assert.equal(rows[0].targetId, 'prefer-pnpm')
  assert.equal(rows[0].oldTitle, 'Use pnpm')
  assert.equal(rows[0].newTitle, 'Use bun')
  assert.equal(rows[1].op, 'add')
  assert.equal(rows[1].targetId, null)
  db.close()
})

/* ------------------------------------------------------------ soft-expiry — */

test('expireEntry soft-expires (kept + restorable), restoreEntry undoes it', () => {
  const original = entry()
  const expired = expireEntry(original, '2026-07-24T12:00:00.000Z', 'run-42')
  assert.equal(expired.expiredAt, '2026-07-24T12:00:00.000Z')
  assert.equal(expired.invalidAt, '2026-07-24T12:00:00.000Z')
  assert.equal(expired.sourceRunId, 'run-42')
  assert.equal(expired.title, original.title)
  assert.equal(isActiveEntry(expired), false)

  // A pre-set invalidAt (world truth) survives expiry.
  const dated = expireEntry(entry({ invalidAt: '2026-06-01T00:00:00.000Z' }), '2026-07-24T12:00:00.000Z')
  assert.equal(dated.invalidAt, '2026-06-01T00:00:00.000Z')

  const restored = restoreEntry(expired)
  assert.equal(restored.expiredAt, undefined)
  assert.equal(restored.invalidAt, undefined)
  assert.equal(isActiveEntry(restored), true)
})

/* -------------------------------------------------------------- injection — */

test('renderInjectionLines keeps actives, adds validity windows for superseded facts', () => {
  const active = entry({ id: 'use-bun', title: 'Use bun for JavaScript dependencies' })
  const superseded = expireEntry(
    entry({ id: 'prefer-pnpm', updatedAt: '2026-06-01T00:00:00.000Z' }),
    '2026-07-20T00:00:00.000Z'
  )
  const rendered = renderInjectionLines([active, superseded])
  assert.match(rendered, /## How the user works/)
  assert.match(rendered, /- \*\*rule:\*\* Use bun for JavaScript dependencies/)
  assert.match(rendered, /- \*\*superseded rule:\*\* Use pnpm for JavaScript dependencies \(used until 2026-07-20\)/)
})

test('renderInjectionLines excludes disabled and stays inside the budget', () => {
  const disabled = entry({ id: 'off', title: 'Disabled rule', enabled: false })
  assert.equal(renderInjectionLines([disabled]), '')

  const many = Array.from({ length: 100 }, (_value, index) =>
    entry({ id: `rule-${index}`, title: `Rule number ${index} with a reasonably long title` }))
  const rendered = renderInjectionLines(many, 500)
  assert.ok(rendered.length <= 500)
  assert.match(rendered, /## How the user works/)
})
