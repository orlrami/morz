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

test('an inactive duplicate never shadows the live fact sharing its id', () => {
  // Scope files are hand-editable and the loader accepts duplicate ids, so the
  // dead row can come first. Filtering must therefore precede deduplication.
  const live = entry({ id: 'dup', title: 'Live version' })
  const pairs: Array<readonly [string, MemoryEntry]> = [
    ['disabled', entry({ id: 'dup', title: 'Dead version', enabled: false })],
    ['expired', expireEntry(entry({ id: 'dup', title: 'Dead version' }), '2026-07-20T00:00:00.000Z')],
    ['superseded', { ...entry({ id: 'dup', title: 'Dead version' }), supersededBy: 'dup' } as MemoryEntry]
  ]

  for (const [label, dead] of pairs) {
    const entries = [dead, live]
    assert.deepEqual(
      selectRenderableMemories(entries).map((item) => item.title),
      ['Live version'],
      `${label} duplicate suppressed the live fact`
    )
    assert.ok(renderMemoryPreamble(entries).includes('Live version'), `preamble lost ${label} pair`)
    assert.ok(renderMemoryBlock(entries).includes('Live version'), `block lost ${label} pair`)
  }
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
  assert.ok(full.split('\n').length <= MEMORY_BLOCK_LINE_BUDGET - 2)
  assert.match(full, /truncated: \d+ of 60 facts/)
  // Summary mode keeps every kept fact on one line instead of a body section.
  assert.match(full, /- \*\*rule:\*\* Rule number 0 — Body for rule 0/)
  assert.ok(!full.includes('### Rule number 0'))
})

test('the line budget covers the markers the caller adds', () => {
  // 194+ facts used to render exactly 200 body lines, so the managed block in
  // the file came to 202 once the marker pair was wrapped around it.
  for (const count of [194, 300]) {
    const many = Array.from({ length: count }, (_value, index) =>
      entry({ id: `rule-${index}`, title: `Rule number ${index}`, body: 'Body text.' }))
    const body = renderMemoryBlock(many)
    const managedBlockLines = body.split('\n').length + 2
    assert.ok(
      managedBlockLines <= MEMORY_BLOCK_LINE_BUDGET,
      `${count} facts produced a ${managedBlockLines}-line managed block`
    )
  }
})

test('budgets below the mandatory output still report what was dropped', () => {
  const many = Array.from({ length: 20 }, (_value, index) =>
    entry({ id: `rule-${index}`, title: `Rule number ${index}`, body: 'Body text.' }))

  // Room for the header plus two summaries, once the markers are reserved.
  const small = renderMemoryBlock(many, { lineBudget: 10 })
  assert.ok(small.split('\n').length <= 8)
  assert.match(small, /<!-- morz:memory truncated: 2 of 20 facts, open Morz > Memory -->/)

  // Too small for the header: the notice survives, everything else goes.
  for (const lineBudget of [3, 4, 5]) {
    const tiny = renderMemoryBlock(many, { lineBudget })
    assert.equal(tiny, '<!-- morz:memory truncated: 0 of 20 facts, open Morz > Memory -->')
    assert.ok(tiny.split('\n').length + 2 <= lineBudget)
  }

  // No room for a body line at all.
  for (const lineBudget of [0, 1, 2]) {
    assert.equal(renderMemoryBlock(many, { lineBudget }), '')
  }
})

test('a zero preamble budget renders nothing, not a bare heading', () => {
  const many = [entry({ id: 'rule-0', title: 'Rule zero' })]
  for (const budget of [0, 5, 21]) {
    assert.equal(renderMemoryPreamble(many, { budget }), '', `budget ${budget} leaked a heading`)
  }
  // Enough for the heading and exactly one bullet.
  const fits = renderMemoryPreamble(many, { budget: 60 })
  assert.ok(fits.length <= 60)
  assert.ok(fits.includes('Rule zero'))
})

test('an over-budget block never materializes the discarded full render', () => {
  // 500 permitted-size bodies used to allocate ~25MB to produce a ~32KB block.
  const body = 'x'.repeat(50_000)
  const many = Array.from({ length: 500 }, (_value, index) =>
    entry({ id: `rule-${index}`, title: `Rule number ${index}`, body }))

  const before = process.memoryUsage().heapUsed
  const rendered = renderMemoryBlock(many)
  const heapDeltaMB = (process.memoryUsage().heapUsed - before) / 1_048_576

  assert.ok(rendered.split('\n').length + 2 <= MEMORY_BLOCK_LINE_BUDGET)
  assert.match(rendered, /truncated: \d+ of 500 facts/)
  assert.ok(heapDeltaMB < 8, `rendering allocated ${heapDeltaMB.toFixed(1)}MB`)
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
