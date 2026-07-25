/*
 * w16 — mojibake regression guard. The hosted-login footer once shipped as
 * "Iâ€™m signed in and ready" (UTF-8 double-encode). Assert the source stays
 * clean so a tool re-encoding the file cannot silently reintroduce it.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

test('assistant bridge source has no UTF-8 double-encoded text', () => {
  const source = readFileSync(join(__dirname, 'bridge.ts'), 'utf8')
  assert.ok(source.includes("I'm signed in and ready"), 'sign-in footer text missing')
  for (const marker of ['â€', 'Ã¢', '�']) {
    assert.ok(!source.includes(marker), `mojibake sequence found: ${JSON.stringify(marker)}`)
  }
})
