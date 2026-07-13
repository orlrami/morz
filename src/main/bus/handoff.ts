/*
 * Handoff flow (0.0.2, w4/handoff, integrated on the REAL bus) — Agent 3's
 * chip-gated pipeline wired to Agent 1's SQLite task board + Maildir mailbox.
 *
 * a handoff arrives for agent X → Main stamps identity + ids → an Assisted
 * approval chip gates the dispatch → on approve the payload is delivered to
 * X's Maildir inbox (atomic rename + bus_messages mirror) and X is woken →
 * X's ADAPTER injects a SHORT POINTER PROMPT — the payload STAYS in the
 * mailbox, never inlined into the prompt (trust rule, protocol.md §3).
 *
 * "Assist, don't take over": EVERY dispatch goes through an
 * ApprovalRequestPart chip — there is no auto-dispatch code path here at all.
 * Deny leaves the task 'proposed'. Manual mode: the renderer never calls these
 * channels (modeStore gate) and registering the handlers spawns nothing.
 */
import { randomUUID } from 'crypto'
import { ipcMain, webContents } from 'electron'
import {
  MORZ_AGENT_ID,
  PROTOCOL_VERSION,
  type AgentId,
  type ApprovalRequestPart,
  type Message,
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
import { acceptTask, claimTask, createTask, getTask, listTasks, onBoardChange } from './board'
import { deliver } from './mailbox'

const now = (): string => new Date().toISOString()

/* ── handoff-local state (chips + parked payloads) ────────────── */

/** taskId → handoff payload awaiting the chip (delivered to Maildir on approve). */
const pendingByTask = new Map<TaskId, Message>()
/** Chip-flow notices (approval requests) — blackboard feed alongside bus_messages. */
const notices: Message[] = []
/** Delivered messages this run (mirror of what deliver() wrote, for the snapshot). */
const delivered: Message[] = []
/** Pending Assisted chips. */
const approvals: BusPendingApproval[] = []

/* ── snapshot + broadcast ────────────────────────────────────── */

function snapshot(): BusSnapshot {
  return {
    tasks: listTasks(),
    messages: [...delivered, ...pendingByTask.values(), ...notices],
    approvals: [...approvals]
  }
}

function broadcast(): void {
  const s = snapshot()
  for (const wc of webContents.getAllWebContents()) wc.send(BusApi.changed, s)
}

/* ── the flow ────────────────────────────────────────────────── */

/**
 * A handoff lands: stamp identity, propose the task on the REAL board, park
 * the payload, and surface an approval chip. NOTHING dispatches here.
 */
function post(input: BusHandoffInput): { taskId: TaskId } {
  const ts = now()
  let taskId = input.taskId ?? null
  if (!taskId || !getTask(taskId)) {
    taskId = createTask({ title: input.title, createdBy: input.from }).id
  }

  // The handoff payload — parked until the chip releases it into the Maildir.
  const payload: Message = {
    protocolVersion: PROTOCOL_VERSION,
    id: randomUUID(),
    from: input.from, // renderer-claimed lane id; pipe-side identity is stamped in tool-handlers
    to: input.to,
    taskId,
    ts,
    parts: [{ kind: 'text', text: input.text } satisfies TextPart]
  }
  pendingByTask.set(taskId, payload)

  // Assisted chip: propose-then-approve, per protocol.md §4.
  const requestId = `apr-${randomUUID()}`
  const title = getTask(taskId)?.title ?? input.title
  const summary = `Hand task '${title}' to ${input.to}`
  const part: ApprovalRequestPart = {
    kind: 'approval-request',
    summary,
    action: { type: 'dispatch-task', taskId, to: input.to },
    requestId
  }
  notices.push({
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

/**
 * Chip answered. Approve → accept on the board, deliver the payload to the
 * Maildir inbox, wake the lane with a pointer prompt; a landed pointer claims
 * the task (accepted→working CAS) for the target agent. Deny → stays
 * 'proposed' and the payload stays parked.
 */
function respondApproval(resp: BusApprovalResp): void {
  const idx = approvals.findIndex((a) => a.requestId === resp.requestId)
  if (idx === -1) return
  const [approval] = approvals.splice(idx, 1)
  if (resp.approved) {
    const payload = pendingByTask.get(approval.taskId)
    const task = getTask(approval.taskId)
    if (payload && task && task.state === 'proposed') {
      acceptTask(approval.taskId)
      pendingByTask.delete(approval.taskId)
      const stamped = deliver(payload.from, {
        to: payload.to,
        taskId: payload.taskId,
        parts: payload.parts
      })
      delivered.push(stamped)
      // SHORT pointer only — the payload stays in the mailbox (trust rule §3).
      const pointer = `You have a handoff on task ${task.id}: ${task.title}. Read it with the read_blackboard tool.`
      if (injectPointerPrompt(approval.to, pointer)) {
        claimTask(approval.taskId, approval.to) // accepted→working; null = lost race, fine
      }
      // No live lane: task stays 'accepted' + message sits in the Maildir —
      // at-least-once; the pipe wake / next lane start picks it up.
    }
  }
  broadcast()
}

export function registerHandoffIpc(): void {
  ipcMain.handle(BusApi.snapshot, () => snapshot())
  ipcMain.handle(BusApi.post, (_e, input: BusHandoffInput) => post(input))
  ipcMain.on(BusApi.approvalRespond, (_e, resp: BusApprovalResp) => respondApproval(resp))
  // any board write (IPC, MCP tools, sweeper) refreshes the blackboard
  onBoardChange(() => broadcast())
}
