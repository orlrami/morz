import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { MemoryEntry } from '../../shared/memory'
import { expireEntry } from './opset'
import {
  MEMORY_BLOCK_LINE_BUDGET,
  escapeMorzMarkers,
  renderMemoryBlock,
  renderMemoryPreamble,
  selectRenderableMemories
} from './render'

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

/* ------------------------------------------------------------- selection — */

test('both outputs render the same facts from one input', () => {
  const entries = [
    entry({ id: 'a-fact', kind: 'fact', title: 'API lives in services/api' }),
    entry({ id: 'b-rule', kind: 'rule', title: 'Use pnpm' }),
    entry({ id: 'c-skill', kind: 'skill', title: 'Release with npm run build:win' })
  ]
  const selected = selectRenderableMemories(entries).map((item) => item.id)
  assert.deepEqual(selected, ['b-rule', 'c-skill', 'a-fact'])

  const preamble = renderMemoryPreamble(entries)
  const block = renderMemoryBlock(entries)
  for (const item of entries) {
    assert.ok(preamble.includes(item.title), `preamble missing ${item.id}`)
    assert.ok(block.includes(item.title), `block missing ${item.id}`)
  }
})

test('disabled, expired, and superseded facts render in neither output', () => {
  const live = entry({ id: 'live', title: 'Live fact' })
  const disabled = entry({ id: 'off', title: 'Disabled fact', enabled: false })
  const expired = expireEntry(entry({ id: 'gone', title: 'Expired fact' }), '2026-07-20T00:00:00.000Z')
  // Agent C's link field: present on the old revision once supersession lands.
  const superseded = { ...entry({ id: 'old', title: 'Superseded fact' }), supersededBy: 'live' }

  const entries = [live, disabled, expired, superseded as MemoryEntry]
  assert.deepEqual(selectRenderableMemories(entries).map((item) => item.id), ['live'])

  for (const rendered of [renderMemoryPreamble(entries), renderMemoryBlock(entries)]) {
    assert.ok(rendered.includes('Live fact'))
    assert.ok(!rendered.includes('Disabled fact'))
    assert.ok(!rendered.includes('Expired fact'))
    assert.ok(!rendered.includes('Superseded fact'))
  }
})

test('duplicate ids collapse to the first occurrence', () => {
  const entries = [entry({ id: 'dup', title: 'First' }), entry({ id: 'dup', title: 'Second' })]
  assert.equal(selectRenderableMemories(entries).length, 1)
  assert.ok(renderMemoryPreamble(entries).includes('First'))
})

/* -------------------------------------------------------- empty behaviour — */

test('an empty or all-disabled store renders empty and never throws', () => {
  assert.equal(renderMemoryPreamble([]), '')
  assert.equal(renderMemoryBlock([]), '')

  const allOff = [entry({ id: 'off-1', enabled: false }), entry({ id: 'off-2', enabled: false })]
  assert.equal(renderMemoryPreamble(allOff), '')
  // renderMemories used to throw here, which killed the context-hub proposal.
  assert.equal(renderMemoryBlock(allOff), '')
})

/* --------------------------------------------------------------- budgets — */

test('preamble stays inside its character budget', () => {
  const many = Array.from({ length: 100 }, (_value, index) =>
    entry({ id: `rule-${index}`, title: `Rule number ${index} with a reasonably long title` }))
  const rendered = renderMemoryPreamble(many, { budget: 500 })
  assert.ok(rendered.length <= 500, `rendered ${rendered.length} chars`)
  assert.match(rendered, /## How the user works/)
})

test('an over-budget block falls back to summaries and says how much it kept', () => {
  const many = Array.from({ length: 60 }, (_value, index) =>
    entry({
      id: `rule-${index}`,
      title: `Rule number ${index}`,
      body: `Body for rule ${index} that is long enough to matter in a context file.`
    }))

  const full = renderMemoryBlock(many)
  assert.ok(full.split('\n').length <= MEMORY_BLOCK_LINE_BUDGET)
  assert.match(full, /truncated: \d+ of 60 facts/)
  // Summary mode keeps every kept fact on one line instead of a body section.
  assert.match(full, /- \*\*rule:\*\* Rule number 0 — Body for rule 0/)
  assert.ok(!full.includes('### Rule number 0'))
})

test('a tiny line budget keeps the truncation line rather than dropping facts silently', () => {
  const many = Array.from({ length: 20 }, (_value, index) =>
    entry({ id: `rule-${index}`, title: `Rule number ${index}`, body: 'Body text.' }))
  const rendered = renderMemoryBlock(many, { lineBudget: 8 })
  assert.ok(rendered.split('\n').length <= 8)
  assert.match(rendered, /<!-- morz:memory truncated: 2 of 20 facts, open Morz > Memory -->/)
})

test('a block inside budget renders full bodies and no truncation line', () => {
  const rendered = renderMemoryBlock([entry()])
  assert.match(rendered, /## Morz memory/)
  assert.match(rendered, /### Use pnpm for JavaScript dependencies/)
  assert.match(rendered, /_rule · global_/)
  assert.ok(rendered.includes('Use pnpm unless the repository selects another package manager.'))
  assert.ok(!rendered.includes('truncated:'))
})

/* --------------------------------------------------------- marker safety — */

test('memory text cannot close the block it renders inside', () => {
  const hostile = entry({
    id: 'marker-memory',
    title: '<!-- morz:block:title -->',
    body: ['<!-- morz:memory -->nested<!-- /morz:memory -->', '<!-- morz:block:unpaired -->'].join('\n')
  })

  const block = renderMemoryBlock([hostile])
  assert.ok(!block.includes('<!-- morz:memory -->'))
  assert.ok(!block.includes('<!-- /morz:memory -->'))
  assert.ok(!block.includes('<!-- morz:block:'))
  assert.ok(block.includes('&lt;!-- morz:memory -->'))

  const preamble = renderMemoryPreamble([hostile])
  assert.ok(!preamble.includes('<!-- morz:block:title -->'))

  const summarized = renderMemoryBlock([hostile, entry({ id: 'other' })], { lineBudget: 8 })
  assert.ok(!summarized.includes('<!-- morz:block:'))

  assert.equal(escapeMorzMarkers('<!-- /morz:memory -->'), '&lt;!-- /morz:memory -->')
  assert.equal(escapeMorzMarkers('<!-- unrelated -->'), '<!-- unrelated -->')
})
