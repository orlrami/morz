/*
 * Bus IPC contract (0.0.2, w4/handoff) — renderer↔Main channels for the live
 * blackboard + Assisted handoff. Protocol types come from shared/bus.ts; this
 * file only adds transport channel names + renderer-facing shapes. Kept beside
 * shared/ipc.ts (not inside it) so wave-4 merges stay conflict-free.
 * The real board/pipe (Agents 1-2) swaps in behind these same channels.
 */
import type { AgentId, Message, Task, TaskId } from './bus'

export const BusApi = {
  snapshot: 'bus:snapshot', // () => Promise<BusSnapshot>
  post: 'bus:post', // (BusHandoffInput) => Promise<{ taskId: TaskId }>
  approvalRespond: 'bus:approval-respond', // (BusApprovalResp)
  changed: 'bus:changed' // push → BusSnapshot on every board change
} as const

/** A handoff produced by a lane (or the dev simulate command). Main stamps ids + ts. */
export interface BusHandoffInput {
  from: AgentId
  to: AgentId
  title: string
  /** The handoff payload — stays in the mailbox, never inlined into a prompt. */
  text: string
  /** Attach to an existing task instead of proposing a new one. */
  taskId?: TaskId
}

/** One pending Assisted chip (mirror of the ApprovalRequestPart in `messages`). */
export interface BusPendingApproval {
  requestId: string
  taskId: TaskId
  from: AgentId
  to: AgentId
  summary: string
}

export interface BusApprovalResp {
  requestId: string
  approved: boolean
}

export interface BusSnapshot {
  tasks: Task[]
  messages: Message[]
  approvals: BusPendingApproval[]
}

/** window.morz.bus — exposed by the preload (additive beside MorzApi). */
export interface MorzBusApi {
  snapshot(): Promise<BusSnapshot>
  post(input: BusHandoffInput): Promise<{ taskId: TaskId }>
  respondApproval(resp: BusApprovalResp): void
  onChanged(cb: (s: BusSnapshot) => void): void
}
