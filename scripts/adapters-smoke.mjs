/*
 * adapters-smoke — LIVE round-trip of the codex + agy AgentAdapters (w5).
 * Bundles the real adapter modules (electron-free by design) with esbuild and
 * drives the user's REAL CLIs with one cheap prompt each.
 *
 * Run: node scripts/adapters-smoke.mjs        (exit 0 = PASS)
 * Guards: a missing CLI skips its section (still PASS) — CI-safe.
 *
 * agy note: the smoke prompt asks agy to JOIN the two halves of the token —
 * asking for the literal "ADAPTER_OK" would self-satisfy on the bracketed-
 * paste ECHO in the PTY stream; the joined token can only come from a reply.
 */
import { build } from 'esbuild'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)

let failures = 0
function check(name, cond, detail = '') {
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${cond || !detail ? '' : ` — ${detail}`}`)
  if (!cond) failures++
}

function hasCli(name) {
  const probe = process.platform === 'win32' ? 'where.exe' : 'which'
  return spawnSync(probe, [name], { windowsHide: true }).status === 0
}

/* ── bundle the real adapters ── */
// Bundle INSIDE the repo: 'node-pty' stays external and must resolve from the
// repo's node_modules (a tmp-dir bundle can't see them).
const tmp = mkdtempSync(join(root, 'scripts', '.adapters-smoke-'))
const bundle = join(tmp, 'adapters.cjs')
await build({
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  logLevel: 'silent',
  external: ['node-pty', 'electron'],
  stdin: {
    contents: `
      export { codexAdapter } from './src/main/adapters/codex'
      export { agyAdapter } from './src/main/adapters/agy'
    `,
    resolveDir: root,
    loader: 'ts'
  },
  outfile: bundle
})
const { codexAdapter, agyAdapter } = require(bundle)

const stripAnsi = (s) =>
  // eslint-disable-next-line no-control-regex
  s.replace(/\x1b(?:\[[0-9;:?<=>]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-Z\\-_])/g, '')

function waitFor(pred, ms, label) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now()
    const iv = setInterval(() => {
      if (pred()) {
        clearInterval(iv)
        resolve()
      } else if (Date.now() - t0 > ms) {
        clearInterval(iv)
        reject(new Error(`timeout: ${label}`))
      }
    }, 250)
  })
}

/* ── codex ── */
async function smokeCodex() {
  if (!hasCli('codex')) {
    console.log('skip codex — CLI not installed')
    return
  }
  const events = []
  const off = codexAdapter.onEvent((agentId, e) => agentId === 'smoke-codex' && events.push(e))
  codexAdapter.start({ agentId: 'smoke-codex', cwd: root })
  codexAdapter.send('smoke-codex', 'Reply with exactly ADAPTER_OK')
  try {
    await waitFor(
      () => events.some((e) => e.type === 'result'),
      240_000,
      'codex result event'
    )
    check(
      'codex: stream contains ADAPTER_OK',
      events.some((e) => e.type === 'message' && e.text.includes('ADAPTER_OK')),
      JSON.stringify(events).slice(0, 500)
    )
    check(
      'codex: init carried a thread id',
      events.some((e) => e.type === 'init' && e.sessionId),
      JSON.stringify(events.filter((e) => e.type === 'init'))
    )
    const result = events.find((e) => e.type === 'result')
    check('codex: result carried token usage', result?.inputTokens > 0 && result?.outputTokens > 0, JSON.stringify(result))
  } catch (err) {
    check('codex: turn completed', false, `${err.message}; events=${JSON.stringify(events).slice(0, 500)}`)
  } finally {
    codexAdapter.stop('smoke-codex')
    off()
  }
}

/* ── agy ── */
async function smokeAgy() {
  if (!hasCli('agy')) {
    console.log('skip agy — CLI not installed')
    return
  }
  const events = []
  let raw = ''
  const off = agyAdapter.onEvent((agentId, e) => {
    if (agentId !== 'smoke-agy') return
    events.push(e)
    if (e.type === 'delta') raw += e.text
  })
  agyAdapter.start({ agentId: 'smoke-agy', cwd: root })
  try {
    // Let the TUI boot before pasting (banner + input box render).
    await waitFor(() => raw.length > 0, 60_000, 'agy first output').catch(() => {})
    await new Promise((r) => setTimeout(r, 5_000))
    agyAdapter.send('smoke-agy', 'Join ADAPTER and OK with a single underscore and reply with only that token.')
    await waitFor(
      () => /ADAPTER_OK/.test(stripAnsi(raw).replace(/\s+/g, ' ')),
      300_000,
      'agy reply token'
    )
    check('agy: stream contains ADAPTER_OK', true)
    // The idle heuristic should close the turn shortly after the reply.
    await waitFor(() => events.some((e) => e.type === 'result'), 30_000, 'agy result event')
    check('agy: prompt-idle result fired', true)
  } catch (err) {
    check('agy: live round-trip', false, `${err.message}; tail=${stripAnsi(raw).slice(-400)}`)
  } finally {
    agyAdapter.stop('smoke-agy')
    off()
  }
}

const timeout = setTimeout(() => {
  console.log('FAIL global timeout')
  process.exit(1)
}, 600_000)

try {
  await smokeCodex()
  await smokeAgy()
} finally {
  clearTimeout(timeout)
  rmSync(tmp, { recursive: true, force: true })
}

console.log(failures === 0 ? '\nPASS — adapters smoke green' : `\nFAIL — ${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
