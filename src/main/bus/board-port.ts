/*
 * SqliteBoardPort — the REAL BoardPort (integration swap for InMemoryBoard).
 * Bridges the MCP tool handlers onto the SQLite task board (board.ts: CAS
 * claim, leases, DAG deps) and the Maildir mailbox (mailbox.ts: atomic
 * delivery + bus_messages mirror). Board errors surface as {ok:false} —
 * BoardPort results, never thrown across the pipe.
 */
import type { Artifact, AgentId, Message, Task, TaskId } from '../../shared/bus'
import type { BoardPort, BoardResult } from './tool-handlers'
import { boardDb, claimTask, completeTask } from './board'
import { deliver } from './mailbox'

function fail<T>(e: unknown): BoardResult<T> {
  return { ok: false, reason: e instanceof Error ? e.message : String(e) }
}

export class SqliteBoardPort implements BoardPort {
  post(msg: Message): BoardResult<Message> {
    try {
      // deliver() re-stamps id/ts (both Main-side, so trust is equivalent) and
      // writes Maildir + the bus_messages mirror in one call.
      const stamped = deliver(msg.from, { to: msg.to, taskId: msg.taskId, parts: msg.parts })
      return { ok: true, value: stamped }
    } catch (e) {
      return fail(e)
    }
  }

  read(agentId: AgentId, filter?: { taskId?: TaskId }): Message[] {
    const rows = boardDb()
      .prepare(
        `SELECT id, from_agent, to_agent, task_id, ts, parts FROM bus_messages
         WHERE to_agent = ? ${filter?.taskId ? 'AND task_id = ?' : ''}
         ORDER BY ts ASC`
      )
      .all(...(filter?.taskId ? [agentId, filter.taskId] : [agentId])) as Array<{
      id: string
      from_agent: string
      to_agent: string
      task_id: string | null
      ts: string
      parts: string
    }>
    return rows.map((r) => ({
      protocolVersion: '1.0' as const,
      id: r.id,
      from: r.from_agent,
      to: r.to_agent,
      taskId: r.task_id,
      ts: r.ts,
      parts: JSON.parse(r.parts)
    }))
  }

  claim(agentId: AgentId, taskId: TaskId): BoardResult<Task> {
    try {
      const t = claimTask(taskId, agentId)
      return t ? { ok: true, value: t } : { ok: false, reason: 'claim lost (CAS) or deps unmet' }
    } catch (e) {
      return fail(e)
    }
  }

  complete(
    agentId: AgentId,
    taskId: TaskId,
    artifact: Omit<Artifact, 'id' | 'ts' | 'producedBy'>
  ): BoardResult<Task> {
    try {
      return { ok: true, value: completeTask(taskId, agentId, artifact) }
    } catch (e) {
      return fail(e)
    }
  }
}
