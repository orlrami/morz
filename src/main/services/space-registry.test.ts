import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { clearSpaceRegistry, resolveSpaceId, setSpaceRegistry, spaceRegistry } from './space-registry'

const ROOT_A = process.platform === 'win32' ? 'C:\\Projects\\morz' : '/projects/morz'
const ROOT_B = process.platform === 'win32' ? 'C:\\Projects\\other' : '/projects/other'
const join = (root: string, child: string): string =>
  process.platform === 'win32' ? `${root}\\${child}` : `${root}/${child}`

afterEach(() => clearSpaceRegistry())

function publish(activeSpaceId: string | null = 'morz'): void {
  setSpaceRegistry({
    spaces: [
      { id: 'morz', root: ROOT_A },
      { id: 'other', root: ROOT_B }
    ],
    activeSpaceId
  })
}

test('a plan root resolves to its space, and an unknown root resolves to nothing', () => {
  publish()
  assert.equal(resolveSpaceId({ root: ROOT_A }), 'morz')
  assert.equal(resolveSpaceId({ root: ROOT_B }), 'other')
  // a dispatched worktree lives BESIDE the space root — it must not borrow a
  // space, or one team's memory would leak into another's prompts
  assert.equal(resolveSpaceId({ root: join(ROOT_A, '..') }), undefined)
  assert.equal(
    resolveSpaceId({ root: process.platform === 'win32' ? 'C:\\Elsewhere' : '/elsewhere' }),
    undefined
  )
})

test('a lane cwd resolves by containment, then falls back to the active space', () => {
  publish()
  assert.equal(resolveSpaceId({ cwd: join(ROOT_B, 'src') }), 'other')
  assert.equal(
    resolveSpaceId({ cwd: process.platform === 'win32' ? 'C:\\Temp\\scratch' : '/tmp/scratch' }),
    'morz'
  )
  publish(null)
  assert.equal(
    resolveSpaceId({ cwd: process.platform === 'win32' ? 'C:\\Temp\\scratch' : '/tmp/scratch' }),
    undefined
  )
})

test('nested space roots resolve to the closest space', () => {
  setSpaceRegistry({
    spaces: [
      { id: 'outer', root: ROOT_A },
      { id: 'inner', root: join(ROOT_A, 'packages') }
    ],
    activeSpaceId: 'outer'
  })
  assert.equal(resolveSpaceId({ cwd: join(join(ROOT_A, 'packages'), 'app') }), 'inner')
  assert.equal(resolveSpaceId({ cwd: join(ROOT_A, 'src') }), 'outer')
})

test('the snapshot is validated, copied, and drops an unknown active id', () => {
  const snapshot = setSpaceRegistry({ spaces: [{ id: 'morz', root: ROOT_A }], activeSpaceId: 'gone' })
  assert.deepEqual(snapshot, { spaces: [{ id: 'morz', root: ROOT_A }], activeSpaceId: null })
  snapshot.spaces[0].id = 'mutated'
  assert.equal(spaceRegistry().spaces[0].id, 'morz')

  assert.throws(() => setSpaceRegistry(null), /invalid/)
  assert.throws(() => setSpaceRegistry({ spaces: [{ id: 'a', root: 'relative' }] }), /absolute/)
  assert.throws(
    () => setSpaceRegistry({ spaces: [{ id: 'a', root: ROOT_A }, { id: 'a', root: ROOT_B }] }),
    /unique/
  )
})
