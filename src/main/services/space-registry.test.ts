import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { afterEach, test } from 'node:test'
import {
  awaitSpaceRegistryReady,
  clearSpaceRegistry,
  resolveSpaceId,
  setSpaceRegistry,
  spaceRegistry,
  spaceRegistryReady
} from './space-registry'

/*
 * Roots are canonicalized on disk now (Codex round-1: alias collapsing +
 * duplicate rejection), so these run against real temp directories.
 */
const made: string[] = []

function tempRoot(name: string): string {
  const root = mkdtempSync(join(tmpdir(), `morz-registry-${name}-`))
  made.push(root)
  return root
}

afterEach(() => {
  clearSpaceRegistry()
  for (const root of made.splice(0)) rmSync(root, { recursive: true, force: true })
})

test('a plan root resolves to its space, and an unknown root resolves to nothing', () => {
  const a = tempRoot('a')
  const b = tempRoot('b')
  setSpaceRegistry({ spaces: [{ id: 'morz', root: a }, { id: 'other', root: b }], activeSpaceId: 'morz' })

  assert.equal(resolveSpaceId({ root: a }), 'morz')
  assert.equal(resolveSpaceId({ root: b }), 'other')
  // a dispatched worktree lives BESIDE the space root — it must not borrow a
  // space, or one team's memory would leak into another's prompts
  assert.equal(resolveSpaceId({ root: join(a, '..') }), undefined)
  assert.equal(resolveSpaceId({ root: join(a, 'nested') }), undefined)
})

test('a lane cwd resolves by containment, then falls back to the active space', () => {
  const a = tempRoot('lane-a')
  const b = tempRoot('lane-b')
  setSpaceRegistry({ spaces: [{ id: 'morz', root: a }, { id: 'other', root: b }], activeSpaceId: 'morz' })

  assert.equal(resolveSpaceId({ cwd: join(b, 'src') }), 'other')
  assert.equal(resolveSpaceId({ cwd: join(tmpdir(), 'nowhere-near-a-space') }), 'morz')

  setSpaceRegistry({ spaces: [{ id: 'morz', root: a }], activeSpaceId: null })
  assert.equal(resolveSpaceId({ cwd: join(tmpdir(), 'nowhere-near-a-space') }), undefined)
})

test('nested space roots resolve to the closest space', () => {
  const outer = tempRoot('outer')
  const inner = mkdtempSync(join(outer, 'packages-'))
  setSpaceRegistry({
    spaces: [{ id: 'outer', root: outer }, { id: 'inner', root: inner }],
    activeSpaceId: 'outer'
  })

  assert.equal(resolveSpaceId({ cwd: join(inner, 'app') }), 'inner')
  assert.equal(resolveSpaceId({ cwd: join(outer, 'src') }), 'outer')
})

/*
 * Codex round-1 MEDIUM: two entries claiming one root let find() hand back the
 * FIRST id regardless of which space the user meant — poisoned or merely
 * malformed renderer state injecting another space's memory.
 */
test('two spaces may not claim the same root, however it is spelled', () => {
  const root = tempRoot('dup')
  assert.throws(
    () => setSpaceRegistry({
      spaces: [{ id: 'poisoned', root }, { id: 'real', root }],
      activeSpaceId: 'real'
    }),
    /roots must be unique/
  )
  // a path alias is the same root on disk, so it collides too
  assert.throws(
    () => setSpaceRegistry({
      spaces: [{ id: 'poisoned', root }, { id: 'real', root: join(root, '.', '.') }],
      activeSpaceId: 'real'
    }),
    /roots must be unique/
  )
  // the rejected snapshot left nothing behind
  assert.deepEqual(spaceRegistry().spaces, [])
})

test('an aliased root resolves to the space that published its canonical form', () => {
  const root = tempRoot('alias')
  setSpaceRegistry({ spaces: [{ id: 'morz', root }], activeSpaceId: 'morz' })

  assert.equal(resolveSpaceId({ root: join(root, '.') }), 'morz')
  assert.equal(resolveSpaceId({ root: join(root, 'nested', '..') }), 'morz')
  assert.equal(resolveSpaceId({ root: `${root}${sep}` }), 'morz')
})

test('a root that no longer exists is dropped, and the rest of the snapshot survives', () => {
  const alive = tempRoot('alive')
  const gone = tempRoot('gone')
  rmSync(gone, { recursive: true, force: true })

  const snapshot = setSpaceRegistry({
    spaces: [{ id: 'alive', root: alive }, { id: 'gone', root: gone }],
    activeSpaceId: 'gone'
  })
  assert.deepEqual(snapshot.spaces.map((space) => space.id), ['alive'])
  assert.equal(snapshot.activeSpaceId, null)
  assert.equal(resolveSpaceId({ root: gone }), undefined)
})

test('the snapshot is validated, copied, and drops an unknown active id', () => {
  const root = tempRoot('validate')
  const snapshot = setSpaceRegistry({ spaces: [{ id: 'morz', root }], activeSpaceId: 'gone' })
  assert.equal(snapshot.activeSpaceId, null)
  snapshot.spaces[0].id = 'mutated'
  assert.equal(spaceRegistry().spaces[0].id, 'morz')

  assert.throws(() => setSpaceRegistry(null), /invalid/)
  assert.throws(() => setSpaceRegistry({ spaces: [{ id: 'a', root: 'relative' }] }), /absolute/)
  assert.throws(
    () => setSpaceRegistry({ spaces: [{ id: 'a', root }, { id: 'a', root }] }),
    /ids must be unique/
  )
  assert.throws(
    () => setSpaceRegistry({ spaces: [], generation: -1, publisherId: 'r1' }),
    /generation is invalid/
  )
})

/*
 * Codex round-1 MEDIUM: a retry that overtakes a newer publish would otherwise
 * reinstate spaces the user has already removed.
 */
test('an older message from the same publisher is ignored; a new publisher takes over', () => {
  const first = tempRoot('gen-first')
  const second = tempRoot('gen-second')
  const publish = (id: string, root: string, publisherId: string, generation: number): void => {
    setSpaceRegistry({ spaces: [{ id, root }], activeSpaceId: id, publisherId, generation })
  }

  publish('first', first, 'r1', 2)
  publish('second', second, 'r1', 1)
  assert.deepEqual(spaceRegistry().spaces.map((space) => space.id), ['first'])

  publish('second', second, 'r1', 3)
  assert.deepEqual(spaceRegistry().spaces.map((space) => space.id), ['second'])

  // a reloaded renderer restarts its generation and must still be believed
  publish('first', first, 'r2', 1)
  assert.deepEqual(spaceRegistry().spaces.map((space) => space.id), ['first'])
})

/*
 * Codex round-2 MEDIUM: comparing generations only WITHIN one publisher let a
 * delayed message from a replaced renderer pose as a brand-new publisher and
 * win — r1:g2 → r2:g1 → r1:g3 used to end on r1's spaces, resurrecting Spaces
 * the user had removed. A replaced publisher is now fenced permanently.
 */
test('a replaced publisher can never speak again, however new its generation', () => {
  const stale = tempRoot('fence-stale')
  const live = tempRoot('fence-live')
  const publish = (id: string, root: string, publisherId: string, generation: number): void => {
    setSpaceRegistry({ spaces: [{ id, root }], activeSpaceId: id, publisherId, generation })
  }

  publish('stale', stale, 'r1', 2)
  publish('live', live, 'r2', 1) // the reload takes over
  publish('stale', stale, 'r1', 3) // r1's delayed message arrives late

  assert.deepEqual(spaceRegistry().spaces.map((space) => space.id), ['live'])
  assert.equal(spaceRegistry().activeSpaceId, 'live')
  assert.equal(resolveSpaceId({ root: stale }), undefined)
  assert.equal(resolveSpaceId({ root: live }), 'live')

  // and it stays fenced however long it keeps trying
  publish('stale', stale, 'r1', 99)
  assert.deepEqual(spaceRegistry().spaces.map((space) => space.id), ['live'])
})

test('the owning publisher id is bound to the webContents that claimed it', () => {
  const owned = tempRoot('owner')
  const forged = tempRoot('forged')
  const publish = (id: string, root: string, generation: number, webContentsId: number): void => {
    setSpaceRegistry(
      { spaces: [{ id, root }], activeSpaceId: id, publisherId: 'r1', generation },
      webContentsId
    )
  }

  publish('owned', owned, 1, 7)
  // another webContents reusing the owner's publisher id is not the owner
  publish('forged', forged, 99, 9)
  assert.deepEqual(spaceRegistry().spaces.map((space) => space.id), ['owned'])

  // the real owner still moves forward from its own webContents
  publish('forged', forged, 2, 7)
  assert.deepEqual(spaceRegistry().spaces.map((space) => space.id), ['forged'])
})

test('readiness flips on the first accepted publish and is awaitable', async () => {
  const root = tempRoot('ready')
  assert.equal(spaceRegistryReady(), false)
  assert.equal(await awaitSpaceRegistryReady(20), false)

  const waiting = awaitSpaceRegistryReady(5_000)
  setSpaceRegistry({ spaces: [{ id: 'morz', root }], activeSpaceId: 'morz' })
  assert.equal(await waiting, true)
  assert.equal(spaceRegistryReady(), true)
  // an empty Space list is still an answer — the user simply has no Spaces
  setSpaceRegistry({ spaces: [], activeSpaceId: null })
  assert.equal(spaceRegistryReady(), true)
})
