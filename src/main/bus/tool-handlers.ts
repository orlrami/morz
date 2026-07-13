/*
 * Bus tool handlers (0.0.2) — Main-side implementation of the 5 MCP tools the
 * morz-mcp shim proxies over the named pipe. ALL trust lives here: sender
 * identity comes from the pipe-authenticated client, never from tool args.
 *
 * Board access goes through the narrow BoardPort so the SQLite task board
 * (Agent 1, this wave) can swap in for the TEMPORARY InMemoryBoard stub below.
 */
import { randomUUID } from 'crypto'
import {
  MORZ_AGENT_ID,
  PROTOCOL_VERSION,
  type AgentId,
  type Artifact,
  type Message,
  type Task,
  type TaskId,
  type TextPart
} from '../../shared/bus'
import type { OpenFileEvent } from '../../shared/ipc'
import type { ToolHandlers } from './pipe-server'

/** Renderer push channel for open_file_in_preview — payload is OpenFileEvent;
 * the preload forwards it onto the renderer mitt bus as 'open-file'. */
export const BUS_OPEN_FILE_CHANNEL = 'bus:open-file'

export type BoardResult<T> = { ok: true; value: T } | { ok: false; reason: string }

/** Narrow port over the task board / blackboard, shaped by docs/protocol.md.
 * Implemented TEMPORARILY by InMemoryBoard; integration swaps in the real
 * SQLite board (CAS claim, leases, DAG deps) behind the same signatures. */
export interface BoardPort {
  /** Persist a fully-stamped Message (Main already set from/ts/id). */
  post(msg: Message): BoardResult<Message>
  /** Messages addressed to the agent, oldest first. */
  read(agentId: AgentId, filter?: { taskId?: TaskId }): Message[]
  /** CAS claim — exactly one claimant wins; fails if deps unmet or not claimable. */
  claim(agentId: AgentId, taskId: TaskId): BoardResult<Task>
  /** Terminal 'done' by the current claimant, artifact attached. */
  complete(
    agentId: AgentId,
    taskId: TaskId,
    artifact: Omit<Artifact, 'id' | 'ts' | 'producedBy'>
  ): BoardResult<Task>
}

/** TEMPORARY in-memory BoardPort — no persistence, no lease sweeper.
 * Exists so the pipe + shim can be built and tested before the SQLite board
 * merges; keep tool handlers coded against BoardPort only. */
export class InMemoryBoard implements BoardPort {
  private static readonly LEASE_MS = 10 * 60_000
  private messages: Message[] = []
  private tasks = new Map<TaskId, Task>()

  /** Test/dev helper: seed a task (e.g. state 'accepted' so it's claimable). */
  seedTask(task: Task): void {
    this.tasks.set(task.id, task)
  }

  getTask(id: TaskId): Task | undefined {
    return this.tasks.get(id)
  }

  post(msg: Message): BoardResult<Message> {
    this.messages.push(msg)
    return { ok: true, value: msg }
  }

  read(agentId: AgentId, filter?: { taskId?: TaskId }): Message[] {
    return this.messages.filter(
      (m) => m.to === agentId && (!filter?.taskId || m.taskId === filter.taskId)
    )
  }

  claim(agentId: AgentId, taskId: TaskId): BoardResult<Task> {
    const t = this.tasks.get(taskId)
    if (!t) return { ok: false, reason: `no such task: ${taskId}` }
    if (t.state !== 'accepted') return { ok: false, reason: `task not claimable (state=${t.state})` }
    for (const dep of t.dependsOn) {
      if (this.tasks.get(dep)?.state !== 'done') {
        return { ok: false, reason: `dependency not done: ${dep}` }
      }
    }
    t.state = 'working'
    t.assignee = agentId
    t.leaseUntil = new Date(Date.now() + InMemoryBoard.LEASE_MS).toISOString()
    t.updatedAt = new Date().toISOString()
    return { ok: true, value: t }
  }

  complete(
    agentId: AgentId,
    taskId: TaskId,
    artifact: Omit<Artifact, 'id' | 'ts' | 'producedBy'>
  ): BoardResult<Task> {
    const t = this.tasks.get(taskId)
    if (!t) return { ok: false, reason: `no such task: ${taskId}` }
    if (t.state !== 'working' || t.assignee !== agentId) {
      return {
        ok: false,
        reason: `task not held by ${agentId} (state=${t.state}, assignee=${t.assignee})`
      }
    }
    t.artifacts.push({
      ...artifact,
      id: randomUUID(),
      ts: new Date().toISOString(),
      producedBy: agentId
    })
    t.state = 'done'
    t.assignee = null
    delete t.leaseUntil
    t.updatedAt = new Date().toISOString()
    return { ok: true, value: t }
  }
}

/* ── arg validation (shim args are untrusted input) ── */

function obj(args: unknown): Record<string, unknown> {
  if (args === undefined || args === null) return {}
  if (typeof args !== 'object' || Array.isArray(args)) throw new Error('arguments must be an object')
  return args as Record<string, unknown>
}

function str(a: Record<string, unknown>, key: string): string {
  const v = a[key]
  if (typeof v !== 'string' || v.length === 0) throw new Error(`${key} must be a non-empty string`)
  return v
}

function optStr(a: Record<string, unknown>, key: string): string | undefined {
  const v = a[key]
  if (v === undefined || v === null) return undefined
  if (typeof v !== 'string') throw new Error(`${key} must be a string`)
  return v
}

function optNum(a: Record<string, unknown>, key: string): number | undefined {
  const v = a[key]
  if (v === undefined || v === null) return undefined
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`${key} must be a number`)
  return v
}

export function createToolHandlers(deps: {
  board: BoardPort
  /** Forwarded to the renderer over BUS_OPEN_FILE_CHANNEL (webContents.send). */
  openFile: (evt: OpenFileEvent) => void
}): ToolHandlers {
  const unwrap = <T>(r: BoardResult<T>): T => {
    if (!r.ok) throw new Error(r.reason)
    return r.value
  }

  return {
    async post_to_blackboard(agentId, rawArgs) {
      const a = obj(rawArgs)
      const msg: Message = {
        protocolVersion: PROTOCOL_VERSION,
        id: randomUUID(),
        from: agentId, // stamped by Main — never trusted from args
        to: optStr(a, 'to') ?? MORZ_AGENT_ID,
        taskId: optStr(a, 'taskId') ?? null,
        ts: new Date().toISOString(),
        parts: [{ kind: 'text', text: str(a, 'text') } satisfies TextPart]
      }
      // optional a.kind (e.g. 'handoff') accepted for forward-compat; the
      // handoff wake + pointer-prompt injection is wired at integration.
      const posted = unwrap(deps.board.post(msg))
      return { messageId: posted.id, ts: posted.ts }
    },

    async read_blackboard(agentId, rawArgs) {
      const a = obj(rawArgs)
      const taskId = optStr(a, 'taskId')
      return { messages: deps.board.read(agentId, taskId ? { taskId } : undefined) }
    },

    async claim_task(agentId, rawArgs) {
      const a = obj(rawArgs)
      return { task: unwrap(deps.board.claim(agentId, str(a, 'taskId'))) }
    },

    async complete_task(agentId, rawArgs) {
      const a = obj(rawArgs)
      const artifact = {
        label: optStr(a, 'label') ?? 'completed',
        files: [] as Artifact['files'],
        commits: [] as Artifact['commits']
      }
      return { task: unwrap(deps.board.complete(agentId, str(a, 'taskId'), artifact)) }
    },

    async open_file_in_preview(_agentId, rawArgs) {
      const a = obj(rawArgs)
      const evt: OpenFileEvent = { path: str(a, 'path') }
      const line = optNum(a, 'line')
      if (line !== undefined) evt.line = line
      const col = optNum(a, 'col')
      if (col !== undefined) evt.col = col
      deps.openFile(evt)
      return { opened: true }
    }
  }
}
