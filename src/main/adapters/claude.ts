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
import { readFile } from 'fs/promises'
import { homedir } from 'os'
import { join } from 'path'
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
  cwd: string
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
  // stream-json only works in print mode (verified against claude 2.1.187)
  '-p',
  '--input-format',
  'stream-json',
  '--output-format',
  'stream-json',
  '--include-partial-messages',
  '--verbose',
  '--permission-prompt-tool',
  'stdio'
]

/** ~/.claude transcript dir slug: every non-alphanumeric path char becomes '-'. */
function projectSlug(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-')
}

/** Sum assistant-message token usage from the session transcript JSONL. */
async function jsonlUsage(
  cwd: string,
  sessionId: string
): Promise<{ inputTokens: number; outputTokens: number } | null> {
  try {
    const file = join(homedir(), '.claude', 'projects', projectSlug(cwd), `${sessionId}.jsonl`)
    const raw = await readFile(file, 'utf8')
    let inputTokens = 0
    let outputTokens = 0
    let seen = false
    for (const line of raw.split('\n')) {
      if (!line.includes('"usage"')) continue
      try {
        const msg = JSON.parse(line) as {
          type?: string
          message?: { usage?: { input_tokens?: number; output_tokens?: number } }
        }
        const u = msg.type === 'assistant' ? msg.message?.usage : undefined
        if (u) {
          seen = true
          inputTokens += u.input_tokens ?? 0
          outputTokens += u.output_tokens ?? 0
        }
      } catch {
        // malformed transcript line — skip, keep summing
      }
    }
    return seen ? { inputTokens, outputTokens } : null
  } catch {
    return null
  }
}

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
    const r = event as { total_cost_usd?: number; usage?: unknown }
    if (typeof r.total_cost_usd === 'number') proc.totalCostUsd = r.total_cost_usd
    // Meter fallback: result carried no cost/usage → sum the ~/.claude JSONL
    // transcript and push a synthetic meter event ("no data" if that fails too).
    if (r.total_cost_usd == null && r.usage == null && proc.sessionId) {
      void jsonlUsage(proc.cwd, proc.sessionId).then((u) => {
        if (u && procs.get(proc.agentId) === proc) {
          emit(proc.agentId, { type: 'meter', source: 'jsonl', ...u })
        }
      })
    }
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
    cwd: opts.cwd,
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
    // A restart re-registers the agentId before the old child's close fires —
    // stay silent then, or the fresh lane would be flagged dead.
    const current = procs.get(opts.agentId)
    if (current && current !== proc) return
    procs.delete(opts.agentId)
    for (const [rid, p] of pendingPermissions) {
      if (p.agentId === opts.agentId) pendingPermissions.delete(rid)
    }
    emit(opts.agentId, { type: 'process_exit', code, sessionId: proc.sessionId })
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

/*
 * w4/handoff — pointer-prompt entry point. The handoff flow (bus/handoff.ts)
 * wakes a lane with a SHORT pointer; the payload stays in the mailbox (trust
 * rule, protocol.md §3). Returns false when the lane has no live process —
 * the mailbox then retains the message for redelivery.
 */
export function injectPointerPrompt(agentId: string, text: string): boolean {
  const proc = procs.get(agentId)
  if (!proc || proc.child.killed) return false
  writeLine(proc, {
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text }] }
  })
  return true
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
  const pid = proc.child.pid
  if (process.platform === 'win32' && pid) {
    // shell:true wraps claude in cmd.exe — kill the whole tree, not just the shim
    spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true })
  } else {
    proc.child.kill()
  }
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
