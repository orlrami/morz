/*
 * morz-mcp — the stdio shim every CLI spawns to reach the Morz bus (0.0.2).
 *
 * MCP server (JSON-RPC 2.0, newline-delimited JSON on stdin/stdout) on one
 * side; NDJSON over the Main-owned named pipe on the other (MORZ_BUS_PIPE +
 * MORZ_BUS_TOKEN from env, injected at spawn). Dumb proxy BY DESIGN: no local
 * state, no trust decisions — Main authenticates the pipe, stamps sender
 * identity and enforces everything. Agent reports return as MCP tool results,
 * never user-role messages.
 *
 * Wake notifications: when Main pushes {type:'wake', to, reason, taskId} down
 * the pipe, the shim surfaces it as an MCP `notifications/message` (logging)
 * notification with logger "morz-bus" and the frame as `data`. A connected CLI
 * sees an info-level log entry; CLIs without logging support ignore it safely
 * (content is advisory — the mailbox/board is the source of truth).
 *
 * Bundled to a single CJS file with zero native deps (build.mjs) so any CLI's
 * node can run it: `node dist/morz-mcp.cjs`.
 */
import { connect, type Socket } from 'net'
import { createInterface } from 'readline'

const PIPE = process.env.MORZ_BUS_PIPE ?? ''
const TOKEN = process.env.MORZ_BUS_TOKEN ?? ''
const AGENT_ID = process.env.MORZ_AGENT_ID ?? 'unknown-agent'

const SERVER_INFO = { name: 'morz-mcp', title: 'Morz Bus', version: '0.0.2' }
const SUPPORTED_PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05']
const CALL_TIMEOUT_MS = 30_000

const TOOLS = [
  {
    name: 'post_to_blackboard',
    description:
      'Post a message to the Morz agent blackboard. Sender identity is stamped by Morz. ' +
      "Address another agent lane or omit 'to' for the coordinator.",
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Message body (Markdown allowed)' },
        to: { type: 'string', description: "Target agent id; defaults to 'morz' (coordinator)" },
        taskId: { type: 'string', description: 'Related task id, if any' },
        kind: { type: 'string', description: "Message kind, e.g. 'handoff'" }
      },
      required: ['text']
    }
  },
  {
    name: 'read_blackboard',
    description: 'Read blackboard messages addressed to this agent, oldest first.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'Only messages for this task' }
      }
    }
  },
  {
    name: 'claim_task',
    description:
      'Atomically claim a task from the Morz task board (exactly one claimant wins). ' +
      'Fails if the task is not claimable or has unfinished dependencies.',
    inputSchema: {
      type: 'object',
      properties: { taskId: { type: 'string', description: 'Task to claim' } },
      required: ['taskId']
    }
  },
  {
    name: 'complete_task',
    description: 'Mark a task you claimed as done, attaching a short result label.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'Task to complete' },
        label: { type: 'string', description: 'One-line result summary' }
      },
      required: ['taskId']
    }
  },
  {
    name: 'open_file_in_preview',
    description: 'Open a file in the Morz IDE preview pane (optionally at a line/column).',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path' },
        line: { type: 'number' },
        col: { type: 'number' }
      },
      required: ['path']
    }
  }
]

/* ── stdout writer (MCP messages) ── */

function writeMsg(msg: object): void {
  process.stdout.write(JSON.stringify(msg) + '\n')
}

let initialized = false
const wakeQueue: Record<string, unknown>[] = []

function emitWake(frame: Record<string, unknown>): void {
  if (!initialized) {
    // MCP forbids server traffic before the initialized notification — queue
    wakeQueue.push(frame)
    return
  }
  writeMsg({
    jsonrpc: '2.0',
    method: 'notifications/message',
    params: { level: 'info', logger: 'morz-bus', data: frame }
  })
}

/* ── pipe client ── */

interface Pending {
  resolve: (v: unknown) => void
  reject: (e: Error) => void
  timer: ReturnType<typeof setTimeout>
}

class BusClient {
  private socket: Socket | null = null
  private ready: Promise<void> | null = null
  private pending = new Map<number, Pending>()
  private nextId = 1
  private buffer = ''

  /** Connect + authenticate; reused while healthy, rebuilt after a drop. */
  private connect(): Promise<void> {
    if (this.ready) return this.ready
    this.ready = new Promise<void>((resolve, reject) => {
      if (!PIPE || !TOKEN) {
        this.ready = null
        return reject(new Error('MORZ_BUS_PIPE / MORZ_BUS_TOKEN not set — not spawned by Morz?'))
      }
      const socket = connect(PIPE)
      let helloOk = false
      socket.setEncoding('utf8')
      socket.on('connect', () => {
        socket.write(JSON.stringify({ type: 'hello', token: TOKEN, agentId: AGENT_ID }) + '\n')
      })
      socket.on('data', (chunk: string) => {
        this.buffer += chunk
        let nl: number
        while ((nl = this.buffer.indexOf('\n')) !== -1) {
          const line = this.buffer.slice(0, nl).trim()
          this.buffer = this.buffer.slice(nl + 1)
          if (!line) continue
          let frame: Record<string, unknown>
          try {
            frame = JSON.parse(line)
          } catch {
            continue
          }
          if (!helloOk) {
            if (frame.type === 'hello-ok') {
              helloOk = true
              this.socket = socket
              resolve()
            }
            continue
          }
          this.onFrame(frame)
        }
      })
      const drop = (why: string): void => {
        // wrong token: Main destroys the socket before hello-ok arrives
        if (!helloOk) reject(new Error(why))
        const err = new Error(why)
        for (const p of this.pending.values()) {
          clearTimeout(p.timer)
          p.reject(err)
        }
        this.pending.clear()
        this.socket = null
        this.ready = null
        this.buffer = ''
      }
      socket.on('error', (e) => drop(`bus pipe error: ${e.message}`))
      socket.on('close', () => drop('bus pipe closed (wrong token or Morz not running?)'))
    })
    return this.ready
  }

  /** Best-effort eager connect so wake pushes flow before the first tool call. */
  warm(): void {
    this.connect().catch((e: Error) => log(`bus not reachable yet: ${e.message}`))
  }

  private onFrame(frame: Record<string, unknown>): void {
    if (frame.type === 'res' && typeof frame.id === 'number') {
      const p = this.pending.get(frame.id)
      if (!p) return
      this.pending.delete(frame.id)
      clearTimeout(p.timer)
      if (frame.ok) p.resolve(frame.result)
      else p.reject(new Error(String(frame.error ?? 'bus call failed')))
    } else if (frame.type === 'wake') {
      emitWake(frame)
    }
    // unknown frame types ignored (additive tolerance)
  }

  async call(tool: string, args: unknown): Promise<unknown> {
    await this.connect()
    const socket = this.socket
    if (!socket) throw new Error('bus not connected')
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`bus call timed out: ${tool}`))
      }, CALL_TIMEOUT_MS)
      this.pending.set(id, { resolve, reject, timer })
      socket.write(JSON.stringify({ type: 'req', id, tool, args }) + '\n')
    })
  }
}

function log(msg: string): void {
  process.stderr.write(`[morz-mcp] ${msg}\n`)
}

const bus = new BusClient()

/* ── MCP JSON-RPC layer ── */

interface RpcMsg {
  jsonrpc?: string
  id?: number | string | null
  method?: string
  params?: Record<string, unknown>
}

function respond(id: number | string | null, result: unknown): void {
  writeMsg({ jsonrpc: '2.0', id, result })
}

function respondError(id: number | string | null, code: number, message: string): void {
  writeMsg({ jsonrpc: '2.0', id, error: { code, message } })
}

async function handle(msg: RpcMsg): Promise<void> {
  const { id, method, params } = msg
  const isRequest = id !== undefined && id !== null

  switch (method) {
    case 'initialize': {
      const asked = typeof params?.protocolVersion === 'string' ? params.protocolVersion : ''
      const protocolVersion = SUPPORTED_PROTOCOLS.includes(asked) ? asked : SUPPORTED_PROTOCOLS[0]
      respond(id!, {
        protocolVersion,
        capabilities: { tools: { listChanged: false }, logging: {} },
        serverInfo: SERVER_INFO
      })
      return
    }
    case 'notifications/initialized': {
      initialized = true
      for (const frame of wakeQueue.splice(0)) emitWake(frame)
      return
    }
    case 'ping':
      if (isRequest) respond(id!, {})
      return
    case 'tools/list':
      if (isRequest) respond(id!, { tools: TOOLS })
      return
    case 'tools/call': {
      if (!isRequest) return
      const name = typeof params?.name === 'string' ? params.name : ''
      if (!TOOLS.some((t) => t.name === name)) {
        respondError(id!, -32602, `unknown tool: ${name}`)
        return
      }
      try {
        const result = await bus.call(name, params?.arguments ?? {})
        respond(id!, { content: [{ type: 'text', text: JSON.stringify(result) }] })
      } catch (e) {
        // tool + transport failures both surface as tool errors so the CLI's
        // model sees them (a JSON-RPC error would abort some clients' turns)
        respond(id!, { content: [{ type: 'text', text: (e as Error).message }], isError: true })
      }
      return
    }
    default:
      if (isRequest) respondError(id!, -32601, `method not found: ${method}`)
    // unknown notifications ignored per JSON-RPC
  }
}

/* ── stdin loop ── */

const rl = createInterface({ input: process.stdin })
rl.on('line', (line) => {
  const trimmed = line.trim()
  if (!trimmed) return
  let msg: RpcMsg
  try {
    msg = JSON.parse(trimmed)
  } catch {
    respondError(null, -32700, 'parse error')
    return
  }
  if (typeof msg.method !== 'string') return // response or garbage — ignore
  void handle(msg).catch((e: Error) => {
    if (msg.id !== undefined && msg.id !== null) respondError(msg.id, -32603, e.message)
  })
})
rl.on('close', () => process.exit(0))

bus.warm()
