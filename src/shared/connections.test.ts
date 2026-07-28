import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  classifyPathProbe,
  isPlannerEligible,
  keepsPreviousRow,
  presenceAfterProbe,
  type CliConnection
} from './connections'

function connection(state: Partial<CliConnection> = {}): CliConnection {
  return {
    id: 'claude',
    label: 'Claude Code',
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

test('only an authoritative no-match counts as absent', () => {
  assert.deepEqual(classifyPathProbe({ ok: true, exitCode: 0 }, ['C:\\bin\\claude.cmd']), {
    kind: 'found',
    candidates: ['C:\\bin\\claude.cmd']
  })
  // where.exe exits 1 when it searched and found nothing.
  assert.deepEqual(classifyPathProbe({ ok: false, exitCode: 1 }, []), { kind: 'absent' })
  // A successful lookup whose hits are all unrunnable is still a no-match.
  assert.deepEqual(classifyPathProbe({ ok: true, exitCode: 0 }, []), { kind: 'absent' })

  // Everything else leaves presence unknown: where.exe's own error code, a
  // timeout or spawn failure, and an output overflow (no exit code at all).
  assert.deepEqual(classifyPathProbe({ ok: false, exitCode: 2 }, []), { kind: 'probe-error' })
  assert.deepEqual(classifyPathProbe({ ok: false, exitCode: null }, []), { kind: 'probe-error' })
})

test('a transient PATH probe failure keeps the CLI planner-eligible', () => {
  // The regression: one flaky where.exe call must not evict a working CLI.
  const transient = classifyPathProbe({ ok: false, exitCode: null }, [])
  assert.equal(presenceAfterProbe(transient, true), true)
  assert.equal(
    isPlannerEligible(connection({ present: presenceAfterProbe(transient, true) })),
    true
  )

  // An uninstall is authoritative, so presence drops and planning stops even
  // though the row keeps its last known version for the UI.
  const removed = classifyPathProbe({ ok: false, exitCode: 1 }, [])
  assert.equal(presenceAfterProbe(removed, true), false)
  assert.equal(
    isPlannerEligible(connection({ present: presenceAfterProbe(removed, true), versionStale: true })),
    false
  )

  // A probe error cannot invent presence for a CLI that was already gone.
  assert.equal(presenceAfterProbe(transient, false), false)
  // A successful lookup restores it.
  assert.equal(presenceAfterProbe({ kind: 'found', candidates: ['claude'] }, false), true)
})

test('a present CLI with no known version survives a probe error', () => {
  // Found on PATH, but its --version call failed: installed with version null.
  const versionless = { installed: true, version: null }
  const transient = classifyPathProbe({ ok: false, exitCode: 2 }, [])
  const present = presenceAfterProbe(transient, true)

  assert.equal(present, true)
  assert.equal(keepsPreviousRow(versionless, present), true)
  assert.equal(isPlannerEligible(connection({ present, version: null })), true)

  // Authoritatively gone with nothing worth remembering: the row is dropped
  // rather than kept as an installed CLI with neither version nor presence.
  const absent = presenceAfterProbe(classifyPathProbe({ ok: false, exitCode: 1 }, []), true)
  assert.equal(keepsPreviousRow(versionless, absent), false)
  // A remembered version still keeps the row so staleness stays visible.
  assert.equal(keepsPreviousRow({ installed: true, version: '1.0.0' }, absent), true)
  // A CLI that was never installed has no row to keep.
  assert.equal(keepsPreviousRow(undefined, true), false)
  assert.equal(keepsPreviousRow({ installed: false, version: null }, true), false)
})
