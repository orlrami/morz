/*
 * ClaudeAdapter (Slice 5) — owner: Agent 4.
 * Drives the user's `claude` CLI in stream-json mode and relays NDJSON events
 * to the renderer (ClaudeApi contract). Permissions use the CLI's native
 * callback (--permission-prompt-tool stdio → control_request/can_use_tool)
 * surfaced as a Morz dialog — never auto-allowed (Backend Plan §2).
 *
 * Mode gating: nothing here runs until the renderer invokes claude:start.
 * Manual mode never calls it, so registering these handlers spawns no process
 * and makes zero network calls.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import { app, ipcMain, webContents } from 'electron'
import {
  ClaudeApi,
  type ClaudeEvent,
  type ClaudePermissionReq,
  type ClaudePermissionResp,
  type ClaudeStartOpts
} from '../../shared/ipc'

interface ClaudeProc {
  agentId: string
  child: ChildProcessWithoutNullStreams
  buf: string
  sessionId: string | null
  model: string | null
  /** From system/init — feature-detect (verified `claude` version range). */
  capabilities: unknown
  /** Running totals captured from result events. */
  totalCostUsd: number
  controlSeq: number
}

const procs = new Map<string, ClaudeProc>()
/** requestId → pending can_use_tool context (input echoed back on allow). */
const pendingPermissions = new Map<string, { agentId: string; input: unknown }>()

const CLAUDE_ARGS = [
  '--input-format',
  'stream-json',
  '--output-format',
  'stream-json',
  '--include-partial-messages',
  '--verbose',
  '--permission-prompt-tool',
  'stdio'
]

function broadcast(channel: string, payload: unknown): void {
  for (const wc of webContents.getAllWebContents()) wc.send(channel, payload)
}

function emit(agentId: string, event: ClaudeEvent): void {
  broadcast(ClaudeApi.event, { agentId, event })
}

function writeLine(proc: ClaudeProc, msg: unknown): void {
  if (!proc.child.killed) proc.child.stdin.write(JSON.stringify(msg) + '\n')
}

/* ── NDJSON stream ───────────────────────────────────────────── */

function onStdout(proc: ClaudeProc, chunk: Buffer): void {
  proc.buf += chunk.toString('utf8')
  let nl: number
  while ((nl = proc.buf.indexOf('\n')) !== -1) {
    const line = proc.buf.slice(0, nl).trim()
    proc.buf = proc.buf.slice(nl + 1)
    if (!line) continue
    let event: ClaudeEvent
    try {
      event = JSON.parse(line) as ClaudeEvent
    } catch {
      // Malformed-JSONL fuzz survival: skip the line, tell the lane, keep streaming.
      emit(proc.agentId, { type: 'parse_error', line: line.slice(0, 200) })
      continue
    }
    handleEvent(proc, event)
  }
}

function handleEvent(proc: ClaudeProc, event: ClaudeEvent): void {
  if (event.type === 'system' && (event as { subtype?: string }).subtype === 'init') {
    const init = event as { session_id?: string; model?: string; capabilities?: unknown }
    proc.sessionId = init.session_id ?? null
    proc.model = init.model ?? null
    proc.capabilities = init.capabilities ?? null
  } else if (event.type === 'result') {
    const cost = (event as { total_cost_usd?: number }).total_cost_usd
    if (typeof cost === 'number') proc.totalCostUsd = cost
  } else if (event.type === 'control_request') {
    handleControlRequest(proc, event)
    return // surfaced on the permission channel, not as a lane event
  }
  emit(proc.agentId, event)
}

function handleControlRequest(proc: ClaudeProc, event: ClaudeEvent): void {
  const requestId = (event as { request_id?: string }).request_id ?? ''
  const request = (event as { request?: { subtype?: string; tool_name?: string; input?: unknown } })
    .request
  if (request?.subtype === 'can_use_tool') {
    pendingPermissions.set(requestId, { agentId: proc.agentId, input: request.input })
    const req: ClaudePermissionReq = {
      agentId: proc.agentId,
      requestId,
      tool: request.tool_name ?? 'unknown',
      input: request.input
    }
    broadcast(ClaudeApi.permission, req)
  } else {
    // Unknown control subtype: answer with an error so the CLI never hangs on us.
    writeLine(proc, {
      type: 'control_response',
      response: { subtype: 'error', request_id: requestId, error: 'unsupported by Morz' }
    })
  }
}

/* ── ClaudeApi handlers ──────────────────────────────────────── */

function start(opts: ClaudeStartOpts): { agentId: string } {
  stop(opts.agentId)
  const args = [...CLAUDE_ARGS]
  if (opts.resume) args.push('--resume', opts.resume)
  const child = spawn('claude', args, {
    cwd: opts.cwd,
    windowsHide: true,
    shell: process.platform === 'win32' // resolves the npm .cmd shim
  }) as ChildProcessWithoutNullStreams
  const proc: ClaudeProc = {
    agentId: opts.agentId,
    child,
    buf: '',
    sessionId: opts.resume ?? null,
    model: null,
    capabilities: null,
    totalCostUsd: 0,
    controlSeq: 0
  }
  procs.set(opts.agentId, proc)
  child.stdout.on('data', (d: Buffer) => onStdout(proc, d))
  child.stderr.on('data', (d: Buffer) =>
    emit(opts.agentId, { type: 'stderr', text: d.toString('utf8').slice(0, 2000) })
  )
  child.on('error', (err) => emit(opts.agentId, { type: 'process_error', message: err.message }))
  child.on('close', (code) => {
    emit(opts.agentId, { type: 'process_exit', code, sessionId: proc.sessionId })
    procs.delete(opts.agentId)
  })
  return { agentId: opts.agentId }
}

function send(agentId: string, text: string): void {
  const proc = procs.get(agentId)
  if (!proc) return
  writeLine(proc, {
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text }] }
  })
}

function interrupt(agentId: string): void {
  const proc = procs.get(agentId)
  if (!proc) return
  writeLine(proc, {
    type: 'control_request',
    request_id: `morz-${proc.agentId}-${++proc.controlSeq}`,
    request: { subtype: 'interrupt' }
  })
}

function respondPermission(resp: ClaudePermissionResp): void {
  const pending = pendingPermissions.get(resp.requestId)
  if (!pending) return
  pendingPermissions.delete(resp.requestId)
  const proc = procs.get(pending.agentId)
  if (!proc) return
  const response =
    resp.behavior === 'allow'
      ? { behavior: 'allow', updatedInput: pending.input }
      : { behavior: 'deny', message: 'Denied by the user in Morz' }
  writeLine(proc, {
    type: 'control_response',
    response: { subtype: 'success', request_id: resp.requestId, response }
  })
}

function stop(agentId: string): void {
  const proc = procs.get(agentId)
  if (!proc) return
  procs.delete(agentId)
  proc.child.kill()
}

export function registerClaudeIpc(): void {
  ipcMain.handle(ClaudeApi.start, (_e, opts: ClaudeStartOpts) => start(opts))
  ipcMain.on(ClaudeApi.send, (_e, m: { agentId: string; text: string }) => send(m.agentId, m.text))
  ipcMain.on(ClaudeApi.interrupt, (_e, m: { agentId: string }) => interrupt(m.agentId))
  ipcMain.on(ClaudeApi.permissionRespond, (_e, resp: ClaudePermissionResp) =>
    respondPermission(resp)
  )
  app.on('will-quit', () => {
    for (const id of [...procs.keys()]) stop(id)
  })
}
