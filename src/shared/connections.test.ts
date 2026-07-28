import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  classifyPathProbe,
  isPlannerEligible,
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
