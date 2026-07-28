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
  assert.equal(memoryWriteRejection(entry(), { readOnly: true }), null)
  assert.equal(memoryWriteRejection(entry(), null), null)
  assert.equal(memoryWriteRejection(null, { readOnly: true }), null)
})

test('a read-only fact rejects edits and deletion, naming itself', () => {
  const locked = entry({ readOnly: true })
  const edit = memoryWriteRejection(locked, { readOnly: true })
  assert.match(edit ?? '', /read-only/)
  assert.match(edit ?? '', /house-style/)
  assert.match(memoryWriteRejection(locked, {}) ?? '', /read-only/)
  assert.match(memoryWriteRejection(locked, null) ?? '', /read-only/)
})

test('clearing the flag is the one write a read-only fact accepts', () => {
  assert.equal(memoryWriteRejection(entry({ readOnly: true }), { readOnly: false }), null)
})
