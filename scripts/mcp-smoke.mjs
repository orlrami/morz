/*
 * mcp-smoke — end-to-end round-trip of the REAL wave-4 bus pieces:
 *   dist/morz-mcp.cjs (shim, spawned as a child with env pointing at a test
 *   pipe) ⇄ src/main/bus/pipe-server.ts + tool-handlers.ts (bundled fresh).
 *
 * Checks: MCP initialize handshake, tools/list = 6 tools, tool-call round
 * trips (post/claim/complete/open_file), Main-side identity stamping, wake
 * push surfacing as an MCP notification, and the squatting-process case
 * (wrong token → disconnected, calls fail cleanly).
 *
 * Run: node scripts/mcp-smoke.mjs   (exit 0 = PASS)
 */
import { build } from 'esbuild'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const shimPath = join(root, 'packages/morz-mcp/dist/morz-mcp.cjs')
const require = createRequire(import.meta.url)

let failures = 0
function check(name, cond, detail = '') {
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${cond || !detail ? '' : ` — ${detail}`}`)
  if (!cond) failures++
}

/* ── build both sides fresh ── */
const tmp = mkdtempSync(join(tmpdir(), 'morz-mcp-smoke-'))
const serverBundle = join(tmp, 'server.cjs')
const common = { bundle: true, platform: 'node', format: 'cjs', target: 'node18', logLevel: 'silent' }
await build({
  ...common,
  entryPoints: [join(root, 'packages/morz-mcp/src/index.ts')],
  outfile: shimPath
})
await build({
  ...common,
  stdin: {
    contents: `
      export { startPipeServer } from './src/main/bus/pipe-server'
      export { createToolHandlers, InMemoryBoard } from './src/main/bus/tool-handlers'
    `,
    resolveDir: root,
    loader: 'ts'
  },
  outfile: serverBundle
})
const srv = require(serverBundle)

/* ── test pipe server with seeded board ── */
const board = new srv.InMemoryBoard()
const now = new Date().toISOString()
board.seedTask({
  protocolVersion: '1.0',
  id: 'T1',
  state: 'accepted',
  title: 'smoke task',
  createdBy: 'morz',
  assignee: null,
  createdAt: now,
  updatedAt: now,
  dependsOn: [],
  artifacts: []
})
let openedFile = null
const bus = srv.startPipeServer({
  handlers: srv.createToolHandlers({ board, openFile: (evt) => (openedFile = evt) }),
  pipeName: `morz-bus-smoke-${process.pid}`
})
await bus.ready

/* ── minimal MCP client over a spawned shim ── */
function startShim(env) {
  const child = spawn(process.execPath, [shimPath], {
    env: { ...process.env, ...env },
    stdio: ['pipe', 'pipe', 'pipe']
  })
  const pending = new Map()
  const notifications = []
  const waiters = []
  let nextId = 1
  createInterface({ input: child.stdout }).on('line', (line) => {
    let msg
    try {
      msg = JSON.parse(line)
    } catch {
      return
    }
    if (msg.id !== undefined && msg.id !== null && pending.has(msg.id)) {
      const p = pending.get(msg.id)
      pending.delete(msg.id)
      clearTimeout(p.timer)
      p.resolve(msg)
    } else if (msg.method) {
      notifications.push(msg)
      for (const w of [...waiters]) {
        if (w.pred(msg)) {
          waiters.splice(waiters.indexOf(w), 1)
          clearTimeout(w.timer)
          w.resolve(msg)
        }
      }
    }
  })
  child.stderr.on('data', () => {}) // expected chatter on the bad-token path
  return {
    child,
    request(method, params) {
      const id = nextId++
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id)
          reject(new Error(`request timed out: ${method}`))
        }, 5_000)
        pending.set(id, { resolve, timer })
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
      })
    },
    notify(method, params) {
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n')
    },
    waitNotification(pred, ms = 3_000) {
      const hit = notifications.find(pred)
      if (hit) return Promise.resolve(hit)
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('notification timed out')), ms)
        waiters.push({ pred, resolve, timer })
      })
    }
  }
}

const timeout = setTimeout(() => {
  console.log('FAIL global timeout')
  process.exit(1)
}, 30_000)

try {
  /* ── happy path ── */
  const shim = startShim({
    MORZ_BUS_PIPE: bus.pipePath,
    MORZ_BUS_TOKEN: bus.token,
    MORZ_AGENT_ID: 'smoke-agent'
  })

  const init = await shim.request('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'smoke', version: '0' }
  })
  check('initialize', init.result?.serverInfo?.name === 'morz-mcp', JSON.stringify(init))
  shim.notify('notifications/initialized')

  const list = await shim.request('tools/list')
  check('tools/list has 6 tools', list.result?.tools?.length === 6, JSON.stringify(list.result?.tools?.map((t) => t.name)))

  const call = (name, args) => shim.request('tools/call', { name, arguments: args })

  const post = await call('post_to_blackboard', { to: 'morz', text: 'hello from smoke' })
  check('post_to_blackboard', !post.result?.isError && post.result?.content?.[0]?.text?.includes('messageId'), JSON.stringify(post))
  const inbox = board.read('morz')
  check('identity stamped by Main', inbox.length === 1 && inbox[0].from === 'smoke-agent', JSON.stringify(inbox))

  const read = await call('read_blackboard', {})
  check('read_blackboard', !read.result?.isError && read.result?.content?.[0]?.text?.includes('"messages"'), JSON.stringify(read))

  const claim = await call('claim_task', { taskId: 'T1' })
  check('claim_task → working', claim.result?.content?.[0]?.text?.includes('"working"'), JSON.stringify(claim))
  const reclaim = await call('claim_task', { taskId: 'T1' })
  check('second claim fails (CAS)', reclaim.result?.isError === true, JSON.stringify(reclaim))

  const complete = await call('complete_task', { taskId: 'T1', label: 'smoke done' })
  check('complete_task → done', complete.result?.content?.[0]?.text?.includes('"done"'), JSON.stringify(complete))

  const open = await call('open_file_in_preview', { path: 'C:/tmp/x.ts', line: 3 })
  check('open_file_in_preview', !open.result?.isError && openedFile?.path === 'C:/tmp/x.ts' && openedFile?.line === 3, JSON.stringify(openedFile))

  bus.wake('smoke-agent', 'mailbox', 'T1')
  const wake = await shim.waitNotification(
    (m) => m.method === 'notifications/message' && m.params?.data?.type === 'wake'
  ).catch(() => null)
  check('wake surfaces as MCP notification', wake?.params?.data?.taskId === 'T1', JSON.stringify(wake))

  shim.child.kill()

  /* ── squatting process: wrong token must fail cleanly ── */
  const squatter = startShim({
    MORZ_BUS_PIPE: bus.pipePath,
    MORZ_BUS_TOKEN: 'wrong-token',
    MORZ_AGENT_ID: 'squatter'
  })
  const sInit = await squatter.request('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'squat', version: '0' }
  })
  check('squatter: local initialize still answers', sInit.result?.serverInfo?.name === 'morz-mcp')
  squatter.notify('notifications/initialized')
  const sCall = await squatter.request('tools/call', {
    name: 'post_to_blackboard',
    arguments: { text: 'sneak' }
  })
  check('squatter: tool call fails cleanly', sCall.result?.isError === true, JSON.stringify(sCall))
  check('squatter: nothing reached the board', board.read('morz').length === 1)
  squatter.child.kill()
} finally {
  clearTimeout(timeout)
  await bus.close()
  rmSync(tmp, { recursive: true, force: true })
}

console.log(failures === 0 ? '\nPASS — mcp smoke green' : `\nFAIL — ${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
