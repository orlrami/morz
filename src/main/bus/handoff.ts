/*
 * Handoff flow (0.0.2, w4/handoff) — owner: Agent 3.
 *
 * The auto-handoff pipeline that kills the manual MD-file pattern:
 * a handoff arrives for agent X → Main stamps identity + ids → an Assisted
 * approval chip gates the dispatch → on approve the payload is persisted to
 * X's inbox and X is woken → X's ADAPTER injects a SHORT POINTER PROMPT
 * ("You have a handoff on task <id>…") — the payload STAYS in the mailbox,
 * never inlined into the prompt (trust rule, protocol.md §3).
 *
 * "Assist, don't take over": EVERY dispatch goes through an
 * ApprovalRequestPart chip — there is no auto-dispatch code path here at all.
 * Deny leaves the task 'proposed'. Manual mode: the renderer never calls these
 * channels (modeStore gate) and registering the handlers spawns nothing.
 *
 * The board below is a temporary IN-MEMORY stub behind the narrow HandoffPort
 * seam; integration swaps in the real SQLite board + named pipe (Agents 1-2)
 * behind the same interface.
 */
import { randomUUID } from 'crypto'
import { ipcMain, webContents } from 'electron'
import {
  MORZ_AGENT_ID,
  PROTOCOL_VERSION,
  type AgentId,
  type ApprovalRequestPart,
  type Message,
  type Task,
  type TaskId,
  type TextPart
} from '../../shared/bus'
import {
  BusApi,
  type BusApprovalResp,
  type BusHandoffInput,
  type BusPendingApproval,
  type BusSnapshot
} from '../../shared/bus-ipc'
import { injectPointerPrompt } from '../adapters/claude'

/** Narrow seam to the real bus (Agents 1-2). The in-memory stub implements it. */
export interface HandoffPort {
  /** Deliver the task's pending handoff message into `to`'s inbox and wake it. */
  dispatch(taskId: TaskId, to: AgentId): void
  /** Subscribe to messages landing in `agentId`'s inbox. */
  onInbox(agentId: AgentId, cb: (msg: Message) => void): void
}

const now = (): string => new Date().toISOString()

/* ── in-memory stub bus (swapped for board.ts + pipe-server.ts later) ── */

class StubBus implements HandoffPort {
  readonly tasks = new Map<TaskId, Task>()
  /** Everything ever uttered — the blackboard's message feed. */
  readonly messages: Message[] = []
  /** taskId → handoff Message awaiting dispatch (the payload lives here). */
  readonly pendingByTask = new Map<TaskId, Message>()
  /** Delivered mailboxes (Maildir new/ equivalent). */
  readonly inboxes = new Map<AgentId, Message[]>()
  private readonly inboxSubs = new Map<AgentId, Array<(msg: Message) => void>>()

  dispatch(taskId: TaskId, to: AgentId): void {
    const msg = this.pendingByTask.get(taskId)
    if (!msg) return
    this.pendingByTask.delete(taskId)
    const box = this.inboxes.get(to) ?? []
    box.push(msg)
    this.inboxes.set(to, box)
    for (const cb of this.inboxSubs.get(to) ?? []) cb(msg)
  }

  onInbox(agentId: AgentId, cb: (msg: Message) => void): void {
    const subs = this.inboxSubs.get(agentId) ?? []
    subs.push(cb)
    this.inboxSubs.set(agentId, subs)
  }
}

const bus = new StubBus()
const approvals: BusPendingApproval[] = []
/** Agents whose inbox already wakes the adapter (onInbox is register-once). */
const hookedInboxes = new Set<AgentId>()

/* ── snapshot + broadcast ────────────────────────────────────── */

function snapshot(): BusSnapshot {
  return { tasks: [...bus.tasks.values()], messages: bus.messages, approvals }
}

function broadcast(): void {
  const s = snapshot()
  for (const wc of webContents.getAllWebContents()) wc.send(BusApi.changed, s)
}

/* ── the flow ────────────────────────────────────────────────── */

/**
 * A handoff lands: stamp identity, propose the task, park the payload in the
 * pending mailbox, and surface an approval chip. NOTHING dispatches here.
 */
function post(input: BusHandoffInput): { taskId: TaskId } {
  const ts = now()
  const taskId = input.taskId ?? randomUUID()
  const existing = bus.tasks.get(taskId)
  const task: Task = existing ?? {
    protocolVersion: PROTOCOL_VERSION,
    id: taskId,
    state: 'proposed',
    title: input.title,
    createdBy: input.from,
    assignee: null,
    createdAt: ts,
    updatedAt: ts,
    dependsOn: [],
    artifacts: []
  }
  bus.tasks.set(taskId, task)

  // The handoff payload — parked until the chip releases it.
  const payload: Message = {
    protocolVersion: PROTOCOL_VERSION,
    id: randomUUID(),
    from: input.from, // stub: renderer-claimed; the real bus stamps from the pipe identity
    to: input.to,
    taskId,
    ts,
    parts: [{ kind: 'text', text: input.text } satisfies TextPart]
  }
  bus.messages.push(payload)
  bus.pendingByTask.set(taskId, payload)

  // Assisted chip: propose-then-approve, per protocol.md §4.
  const requestId = `apr-${randomUUID()}`
  const summary = `Hand task '${task.title}' to ${input.to}`
  const part: ApprovalRequestPart = {
    kind: 'approval-request',
    summary,
    action: { type: 'dispatch-task', taskId, to: input.to },
    requestId
  }
  bus.messages.push({
    protocolVersion: PROTOCOL_VERSION,
    id: randomUUID(),
    from: input.from,
    to: MORZ_AGENT_ID,
    taskId,
    ts,
    parts: [part]
  })
  approvals.push({ requestId, taskId, from: input.from, to: input.to, summary })

  broadcast()
  return { taskId }
}

/** Wire the pointer-prompt wake-up for one agent's inbox (once). */
function hookInbox(agentId: AgentId): void {
  if (hookedInboxes.has(agentId)) return
  hookedInboxes.add(agentId)
  bus.onInbox(agentId, (msg) => {
    const task = msg.taskId ? bus.tasks.get(msg.taskId) : undefined
    if (!task) return
    // SHORT pointer only — the payload stays in the mailbox (trust rule §3).
    const pointer = `You have a handoff on task ${task.id}: ${task.title}. Read it with the read_blackboard tool.`
    if (injectPointerPrompt(agentId, pointer)) {
      task.state = 'working'
      task.assignee = agentId
      task.leaseUntil = new Date(Date.now() + 15 * 60_000).toISOString()
      task.updatedAt = now()
    }
    // No live lane: the task stays 'accepted' and the message stays in the
    // inbox — at-least-once semantics; the real bus redelivers on next wake.
    broadcast()
  })
}

/** Chip answered. Approve → accepted + dispatch. Deny → stays 'proposed'. */
function respondApproval(resp: BusApprovalResp): void {
  const idx = approvals.findIndex((a) => a.requestId === resp.requestId)
  if (idx === -1) return
  const [approval] = approvals.splice(idx, 1)
  if (resp.approved) {
    const task = bus.tasks.get(approval.taskId)
    if (task && task.state === 'proposed') {
      task.state = 'accepted'
      task.updatedAt = now()
      hookInbox(approval.to)
      bus.dispatch(approval.taskId, approval.to)
    }
  }
  broadcast()
}

export function registerHandoffIpc(): void {
  ipcMain.handle(BusApi.snapshot, () => snapshot())
  ipcMain.handle(BusApi.post, (_e, input: BusHandoffInput) => post(input))
  ipcMain.on(BusApi.approvalRespond, (_e, resp: BusApprovalResp) => respondApproval(resp))
}
