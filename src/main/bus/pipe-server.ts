/*
 * Named-pipe bus channel (0.0.2) — Main is the server. docs/protocol.md §6.2.
 *
 * \\.\pipe\morz-bus-<nonce>, NDJSON frames, nonce + token minted fresh per app
 * run and handed to children privately via env (MORZ_BUS_PIPE / MORZ_BUS_TOKEN).
 * The FIRST line from a client must be a hello carrying the token or the socket
 * is destroyed — this defeats a pipe-squatting process. After auth the pipe
 * carries wake pushes (Main → shim) and tool-call proxying (shim → Main
 * handlers). ALL trust lives in Main; the morz-mcp shim is a dumb proxy.
 */
import { createServer, type Socket } from 'net'
import { randomBytes, timingSafeEqual } from 'crypto'
import { PROTOCOL_VERSION, type AgentId, type TaskId } from '../../shared/bus'

export type WakeReason = 'mailbox' | 'task-state' | 'sweeper'

/* ── wire frames (shim ↔ Main). Additive-only, like the protocol:
 *    receivers MUST ignore unknown frame types/fields. ── */
export interface WakeFrame {
  type: 'wake'
  to: AgentId
  reason: WakeReason
  taskId?: TaskId
}

/** A tool handler runs in Main with the pipe-authenticated agent identity —
 * `agentId` is stamped from the hello, never trusted from `args`. */
export type ToolHandler = (agentId: AgentId, args: unknown) => Promise<unknown>
export type ToolHandlers = Record<string, ToolHandler>

export interface PipeServerOpts {
  handlers: ToolHandlers
  /** Test override — production mints a fresh nonce per run. */
  pipeName?: string
  /** Test override — production mints a fresh token per run. */
  token?: string
}

export interface BusPipeServer {
  pipePath: string
  token: string
  /** Resolves when the pipe is listening (rejects on listen failure). */
  ready: Promise<void>
  /** Push a wake notification to the given agent's connected shims. */
  wake(to: AgentId, reason: WakeReason, taskId?: TaskId): void
  close(): Promise<void>
}

const HELLO_TIMEOUT_MS = 5_000
// no single frame legitimately approaches this — treat as abuse and disconnect
const MAX_BUFFER_CHARS = 1_048_576

interface Client {
  socket: Socket
  authed: boolean
  agentId: AgentId | null
  buffer: string
}

function tokenMatches(expected: string, got: unknown): boolean {
  if (typeof got !== 'string') return false
  const a = Buffer.from(expected)
  const b = Buffer.from(got)
  return a.length === b.length && timingSafeEqual(a, b)
}

function send(socket: Socket, frame: object): void {
  if (!socket.destroyed) socket.write(JSON.stringify(frame) + '\n')
}

export function startPipeServer(opts: PipeServerOpts): BusPipeServer {
  const pipeName = opts.pipeName ?? `morz-bus-${randomBytes(8).toString('hex')}`
  const pipePath = `\\\\.\\pipe\\${pipeName}`
  const token = opts.token ?? randomBytes(32).toString('base64url')
  const clients = new Set<Client>()

  function handleLine(client: Client, line: string): void {
    let frame: { type?: unknown; [k: string]: unknown }
    try {
      frame = JSON.parse(line)
    } catch {
      client.socket.destroy()
      return
    }
    if (!client.authed) {
      // first line MUST be a valid hello — anything else is a squatter probe
      if (frame?.type !== 'hello' || !tokenMatches(token, frame.token)) {
        client.socket.destroy()
        return
      }
      client.authed = true
      client.agentId = typeof frame.agentId === 'string' ? frame.agentId : null
      send(client.socket, { type: 'hello-ok', protocolVersion: PROTOCOL_VERSION })
      return
    }
    if (frame?.type === 'req') void handleReq(client, frame)
    // unknown frame types ignored (additive tolerance)
  }

  async function handleReq(client: Client, frame: { [k: string]: unknown }): Promise<void> {
    const id = typeof frame.id === 'number' ? frame.id : -1
    const respond = (ok: boolean, result?: unknown, error?: string): void =>
      send(client.socket, { type: 'res', id, ok, ...(ok ? { result } : { error }) })
    const tool = frame.tool
    const handler = typeof tool === 'string' ? opts.handlers[tool] : undefined
    if (!handler) return respond(false, undefined, `unknown tool: ${String(tool)}`)
    try {
      respond(true, await handler(client.agentId ?? 'unknown', frame.args))
    } catch (e) {
      respond(false, undefined, (e as Error).message)
    }
  }

  const server = createServer((socket) => {
    const client: Client = { socket, authed: false, agentId: null, buffer: '' }
    clients.add(client)
    const helloTimer = setTimeout(() => {
      if (!client.authed) socket.destroy()
    }, HELLO_TIMEOUT_MS)
    socket.setEncoding('utf8')
    socket.on('data', (chunk: string) => {
      client.buffer += chunk
      if (client.buffer.length > MAX_BUFFER_CHARS) {
        socket.destroy()
        return
      }
      let nl: number
      while ((nl = client.buffer.indexOf('\n')) !== -1) {
        const line = client.buffer.slice(0, nl).trim()
        client.buffer = client.buffer.slice(nl + 1)
        if (line) handleLine(client, line)
        if (socket.destroyed) return
      }
    })
    socket.on('error', () => {
      // close follows — cleanup happens there
    })
    socket.on('close', () => {
      clearTimeout(helloTimer)
      clients.delete(client)
    })
  })

  const ready = new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(pipePath, () => {
      server.removeListener('error', reject)
      resolve()
    })
  })
  // post-listen server errors shouldn't crash Main
  ready.then(() => server.on('error', (e) => console.error('[morz] bus pipe error:', e))).catch(() => {})

  return {
    pipePath,
    token,
    ready,
    wake(to, reason, taskId) {
      const frame: WakeFrame = { type: 'wake', to, reason, ...(taskId ? { taskId } : {}) }
      for (const c of clients) {
        // route by declared lane; anonymous clients get everything and filter locally.
        // Losing a wake is safe (poll-on-wake + lease sweeper recover) — best effort.
        if (c.authed && (c.agentId === to || c.agentId === null)) send(c.socket, frame)
      }
    },
    close() {
      return new Promise<void>((resolve) => {
        for (const c of clients) c.socket.destroy()
        clients.clear()
        server.close(() => resolve())
      })
    }
  }
}
