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
  type AdapterEvent,
  type ClaudeEvent,
  type ClaudePermissionReq,
  type ClaudePermissionResp,
  type ClaudeStartOpts
} from '../../shared/ipc'
import type {
  AdapterEventListener,
  AdapterPermissionListener,
  AdapterStartOpts,
  AgentAdapter
} from './types'

// w8/memory-learn (a) — correction learning + staged proposal notification seam.
import {
  createMemoryLearner,
  distillCorrectionsWithClaude,
  formatMemoryProposalNoticeDetail,
  type MemoryLearner
} from '../memory/learner'
import {
  createMemorySessionPreamble,
  memoryPort,
  resolveMemoryProposal
} from '../memory/learn-port'
import {
  ClaudeInvocationTracker,
  logMemoryEvent
} from '../memory/event-log'
// w15/model-choice — session-flag model resolution + e2e spawn-args seam.
import { modelArgsForLaunch, recordLaneSpawnArgs } from '../services/model-choice'
import {
  dismissNotice,
  notify,
  registerNotifyAction
} from '../services/notify-center'

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
  startedAt: number
  invocationTracker: ClaudeInvocationTracker
  // Rendered at start, consumed by the first user prompt.
  applyMemoryPreamble: (prompt: string) => string
}

const procs = new Map<string, ClaudeProc>()
/** requestId → pending can_use_tool context (input echoed back on allow). */
const pendingPermissions = new Map<string, { agentId: string; input: unknown }>()

// Feed lane turns, stage proposals, and wire save/dismiss actions.
let activeMemoryLearner: MemoryLearner | null = null
let memoryActionsRegistered = false
const MEMORY_NOTICE_PREFIX = 'memory:proposal:'

function getMemoryLearner(): MemoryLearner {
  if (!activeMemoryLearner) {
    activeMemoryLearner = createMemoryLearner({
      port: memoryPort,
      historyPath: join(app.getPath('appData'), 'Morz', 'memory-corrections.jsonl'),
      distill: distillCorrectionsWithClaude,
      onProposal: ({ proposal }) => {
        notify({
          id: `${MEMORY_NOTICE_PREFIX}${proposal.id}`,
          level: 'info',
          source: 'app',
          title: `I noticed you prefer ${proposal.entry.title} — save as a rule?`,
          detail: formatMemoryProposalNoticeDetail(proposal),
          actions: [
            { id: 'memory-proposal-save', label: 'Save rule' },
            { id: 'memory-proposal-dismiss', label: 'Dismiss' }
          ]
        })
      }
    })
  }
  return activeMemoryLearner
}

function observeMemoryTurn(turn: Parameters<MemoryLearner['observeTurn']>[0]): void {
  void getMemoryLearner().observeTurn(turn).catch((error) => {
    console.warn('[morz] memory learner skipped a turn:', error)
    notify({
      id: 'app:memory-learner',
      level: 'warning',
      source: 'app',
      title: 'Memory learning skipped a correction',
      detail: 'The local learner could not safely stage this observation.'
    })
  })
}

function proposalIdFromNotice(noticeId: string): string | null {
  return noticeId.startsWith(MEMORY_NOTICE_PREFIX)
    ? noticeId.slice(MEMORY_NOTICE_PREFIX.length)
    : null
}

function registerMemoryProposalActions(): void {
  if (memoryActionsRegistered) return
  memoryActionsRegistered = true
  const resolve = (approved: boolean) => async (noticeId: string): Promise<void> => {
    const proposalId = proposalIdFromNotice(noticeId)
    if (!proposalId) return
    await resolveMemoryProposal(proposalId, approved)
    dismissNotice(noticeId)
  }
  registerNotifyAction('memory-proposal-save', resolve(true))
  registerNotifyAction('memory-proposal-dismiss', resolve(false))
}

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

/* w5/adapters — AgentAdapter listener fan-out. Purely additive: the renderer
 * broadcast below is byte-identical to pre-wave-5 behavior; listeners get a
 * normalized AdapterEvent view of the same stream. */
const eventListeners = new Set<AdapterEventListener>()
const permissionListeners = new Set<AdapterPermissionListener>()

/** Map a raw stream-json event onto the normalized union (null = no mapping). */
function normalizeClaudeEvent(event: ClaudeEvent): AdapterEvent | null {
  const e = event as Record<string, unknown>
  switch (event.type) {
    case 'system': {
      if (e.subtype !== 'init') return null
      return {
        type: 'init',
        cli: 'claude',
        sessionId: typeof e.session_id === 'string' ? e.session_id : null,
        model: typeof e.model === 'string' ? e.model : null
      }
    }
    case 'stream_event': {
      const inner = e.event as { type?: string; delta?: { type?: string; text?: string } } | undefined
      if (inner?.type === 'content_block_delta' && typeof inner.delta?.text === 'string') {
        return { type: 'delta', text: inner.delta.text }
      }
      return null
    }
    case 'assistant': {
      const msg = e.message as { content?: { type?: string; text?: string }[] } | undefined
      const text = (msg?.content ?? [])
        .filter((b) => b.type === 'text' && typeof b.text === 'string')
        .map((b) => b.text)
        .join('')
      return text ? { type: 'message', role: 'assistant', text } : null
    }
    case 'result': {
      const usage = e.usage as { input_tokens?: number; output_tokens?: number } | undefined
      return {
        type: 'result',
        inputTokens: usage?.input_tokens,
        outputTokens: usage?.output_tokens,
        costUsd: typeof e.total_cost_usd === 'number' ? e.total_cost_usd : undefined
      }
    }
    case 'meter':
      // Synthetic JSONL fallback — only fires when result carried no usage.
      return {
        type: 'result',
        inputTokens: typeof e.inputTokens === 'number' ? e.inputTokens : undefined,
        outputTokens: typeof e.outputTokens === 'number' ? e.outputTokens : undefined
      }
    case 'stderr':
      return null // diagnostics, not an error signal (CLIs chatter on stderr)
    case 'parse_error':
      return { type: 'error', message: `unparseable stream line: ${String(e.line ?? '')}` }
    case 'process_error':
      return { type: 'error', message: String(e.message ?? 'process error') }
    case 'process_exit':
      return { type: 'exit', code: typeof e.code === 'number' ? e.code : null }
    default:
      return null
  }
}

function emit(agentId: string, event: ClaudeEvent): void {
  broadcast(ClaudeApi.event, { agentId, event })
  const normalized = normalizeClaudeEvent(event)
  // Assistant side of the lane turn stream.
  if (normalized?.type === 'message' && normalized.role === 'assistant') {
    observeMemoryTurn({ laneId: agentId, role: 'assistant', text: normalized.text })
  }
  if (normalized) for (const l of eventListeners) l(agentId, normalized)
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
  for (const invocation of proc.invocationTracker.observe(event)) logMemoryEvent(invocation)
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
    logMemoryEvent({
      v: 1,
      ts: Date.now(),
      sessionKind: 'lane',
      cli: 'claude',
      agentId: proc.agentId,
      event: 'block',
      name: request.tool_name,
      outcome: 'blocked',
      meta: { source: 'structured' }
    })
    pendingPermissions.set(requestId, { agentId: proc.agentId, input: request.input })
    const req: ClaudePermissionReq = {
      agentId: proc.agentId,
      requestId,
      tool: request.tool_name ?? 'unknown',
      input: request.input
    }
    broadcast(ClaudeApi.permission, req)
    for (const l of permissionListeners) l(req) // w5/adapters — same shape, same reply path
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
  // w15/model-choice — session-flag choice rides the spawn (space override
  // wins over global; inherit or cli-config = no flag at all).
  args.push(...modelArgsForLaunch('claude', opts.cwd))
  recordLaneSpawnArgs(args)
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
    controlSeq: 0,
    startedAt: Date.now(),
    invocationTracker: new ClaudeInvocationTracker({
      sessionKind: 'lane',
      agentId: opts.agentId
    }),
    // w8/memory-learn (b) — render at lane launch; never re-render/repeat per turn.
    applyMemoryPreamble: (() => {
      try {
        return createMemorySessionPreamble(memoryPort, {
          projectRoot: opts.cwd,
          agentId: opts.agentId
        }, Boolean(opts.resume))
      } catch (error) {
        console.warn('[morz] memory launch preamble unavailable:', error)
        return (prompt: string) => prompt
      }
    })()
  }
  procs.set(opts.agentId, proc)
  logMemoryEvent({
    v: 1,
    ts: proc.startedAt,
    sessionKind: 'lane',
    cli: 'claude',
    agentId: opts.agentId,
    event: 'spawn',
    outcome: 'unknown',
    meta: { source: 'structured' }
  })
  child.stdout.on('data', (d: Buffer) => onStdout(proc, d))
  child.stderr.on('data', (d: Buffer) =>
    emit(opts.agentId, { type: 'stderr', text: d.toString('utf8').slice(0, 2000) })
  )
  child.on('error', (err) => emit(opts.agentId, { type: 'process_error', message: err.message }))
  child.on('close', (code) => {
    // A restart re-registers the agentId before the old child's close fires —
    // The stale close remains silent in the renderer, but is still logged.
    const current = procs.get(opts.agentId)
    logMemoryEvent({
      v: 1,
      ts: Date.now(),
      sessionKind: 'lane',
      cli: 'claude',
      agentId: opts.agentId,
      event: 'exit',
      outcome: code === 0 ? 'ok' : 'error',
      durationMs: Date.now() - proc.startedAt,
      meta: { source: 'structured', ...(code === null ? {} : { exitCode: code }) }
    })
    // Preserve a restarted invocation's telemetry without marking its replacement dead.
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
  // Learn from the original user turn, inject only into turn one.
  observeMemoryTurn({
    laneId: agentId,
    sessionId: proc.sessionId ?? undefined,
    role: 'user',
    text
  })
  text = proc.applyMemoryPreamble(text)
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
  logMemoryEvent({
    v: 1,
    ts: Date.now(),
    sessionKind: 'lane',
    cli: 'claude',
    agentId,
    event: 'interrupt',
    outcome: 'unknown',
    durationMs: Date.now() - proc.startedAt,
    meta: { source: 'structured' }
  })
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
  let behavior = resp.behavior
  if (behavior !== 'allow' && behavior !== 'deny') {
    console.warn(`[claude] Invalid permission behavior ${JSON.stringify(behavior)}, treating as deny`)
    behavior = 'deny'
  }
  const response =
    behavior === 'allow'
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

/*
 * w5/adapters — the Claude lane behind the common interface. Extraction only:
 * these are the SAME functions the IPC handlers below call; renderer contract
 * (ClaudeApi channels, event shapes, permission flow) is untouched. The
 * permission REPLY still travels claude:permission-respond — respondPermission
 * stays the single writer of control_response.
 */
export interface ClaudeRestartSummary {
  total: number
  resumed: number
  plain: number
}

/** Restart live Claude lanes after an explicit notification action. */
export function restartLiveClaudeSessions(): ClaudeRestartSummary {
  const lanes = [...procs.values()].map((proc) => ({
    agentId: proc.agentId,
    cwd: proc.cwd,
    resume: proc.sessionId ?? undefined
  }))
  for (const lane of lanes) start(lane)
  const resumed = lanes.filter((lane) => Boolean(lane.resume)).length
  return { total: lanes.length, resumed, plain: lanes.length - resumed }
}

export const claudeAdapter: AgentAdapter = {
  cli: 'claude',
  start: (opts: AdapterStartOpts) => start(opts),
  send,
  interrupt,
  stop,
  onEvent(listener) {
    eventListeners.add(listener)
    return () => eventListeners.delete(listener)
  },
  onPermission(listener) {
    permissionListeners.add(listener)
    return () => permissionListeners.delete(listener)
  }
}

export function registerClaudeIpc(): void {
  // Trusted notification actions resolve staged writes.
  registerMemoryProposalActions()
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
