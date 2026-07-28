import assert from 'node:assert/strict'
import { test } from 'node:test'
import { memoryWriteRejection, type MemoryEntry } from './memory'

function entry(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    id: 'house-style',
    scope: 'global',
    kind: 'rule',
    title: 'Prefer focused tests',
    body: 'Run the narrow test first.',
    origin: 'user',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    enabled: true,
    ...overrides
  }
}

test('an unlocked fact accepts every write', () => {
  assert.equal(memoryWriteRejection(entry(), entry({ readOnly: true })), null)
  assert.equal(memoryWriteRejection(entry(), null), null)
  assert.equal(memoryWriteRejection(null, entry({ readOnly: true })), null)
})

test('a read-only fact rejects edits and deletion, naming itself', () => {
  const locked = entry({ readOnly: true })
  const edit = memoryWriteRejection(locked, entry({ readOnly: true, title: 'Rewritten' }))
  assert.match(edit ?? '', /read-only/)
  assert.match(edit ?? '', /house-style/)
  assert.match(memoryWriteRejection(locked, entry({ title: 'Rewritten' })) ?? '', /read-only/)
  assert.match(memoryWriteRejection(locked, null) ?? '', /read-only/)
})

test('clearing the flag on its own is the one write a read-only fact accepts', () => {
  const locked = entry({ readOnly: true })
  // an unlock carries a fresh updatedAt — the store restamps it regardless, so
  // it is the one field that cannot carry a smuggled change
  assert.equal(memoryWriteRejection(locked, entry({ updatedAt: '2026-07-27T12:00:00.000Z' })), null)
  // a no-op re-save of an unchanged locked fact changes nothing, so it passes
  assert.equal(memoryWriteRejection(locked, entry({ readOnly: true })), null)
})

/*
 * Codex round-1 HIGH: `save({ ...locked, readOnly: false, body: 'x' })` used to
 * unlock AND rewrite in one call — the protection entirely gone in one request.
 */
test('unlocking while changing any other field is refused, and names the field', () => {
  const locked = entry({ readOnly: true })
  const rewrite = memoryWriteRejection(locked, entry({ body: 'replacement' }))
  assert.match(rewrite ?? '', /read-only/)
  assert.match(rewrite ?? '', /body/)

  for (const change of [
    { title: 'Rewritten' },
    { enabled: false },
    { scope: 'project' as const, scopeRef: 'C:\\Projects\\morz' },
    { kind: 'fact' as const },
    { origin: 'learned' as const },
    { createdAt: '2020-01-01T00:00:00.000Z' },
    { expiredAt: '2026-07-27T12:00:00.000Z' },
    { source: 'C:\\elsewhere.md#heading' }
  ]) {
    assert.notEqual(memoryWriteRejection(locked, entry(change)), null, JSON.stringify(change))
  }
})
