/*
 * Bus v0 (0.0.2) — file mailbox, atomic-rename Maildir per protocol.md §6.1.
 *
 *   .morz/bus/<agentId>/{tmp,new,cur}
 *
 * Delivery: write tmp/ → fsync → rename() into new/ (same volume ⇒ atomic),
 * so any file visible in new/ is complete. One file per Message, named
 * <ts-compact>-<messageId>.md, JSON frontmatter + Markdown body (the first
 * text part becomes the body; remaining parts stay in the frontmatter).
 * Every delivery is mirrored to SQLite (bus_messages) — the mailbox is the
 * visible/git-diffable copy, SQLite the queryable one.
 *
 * Trust boundary: `from` and `ts` are STAMPED here by Main — a sender-supplied
 * identity is never accepted (protocol.md §1/§3). `deliver()`'s from param is
 * therefore trusted input that only main-process callers provide.
 */
import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, writeSync } from 'fs'
import { join, resolve } from 'path'
import { randomUUID } from 'crypto'
import {
  PROTOCOL_VERSION,
  type AgentId,
  type Message,
  type Part,
  type TextPart
} from '../../shared/bus'
import type { BusSendInput } from '../../shared/ipc'
import { boardDb } from './board'

/** Space root the Maildir hangs off (MORZ_SPACE overrides for tests). */
export function busRoot(): string {
  return join(resolve(process.env.MORZ_SPACE ?? process.cwd()), '.morz', 'bus')
}

/** AgentIds become directory names — reject anything path-unsafe. */
function assertSafeAgentId(id: AgentId): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) {
    throw new Error(`[bus] unsafe agentId for mailbox path: ${JSON.stringify(id)}`)
  }
}

/** 2026-07-13T17:55:01.123Z → 20260713T175501123Z (filename ts prefix). */
function tsCompact(iso: string): string {
  return iso.replace(/[-:.]/g, '')
}

/** First text part becomes the Markdown body; the rest stay in frontmatter. */
function splitBody(parts: Part[]): { front: Part[]; body: string } {
  const i = parts.findIndex((p) => p.kind === 'text')
  if (i === -1) return { front: parts, body: '' }
  return {
    front: [...parts.slice(0, i), ...parts.slice(i + 1)],
    body: (parts[i] as TextPart).text
  }
}

/**
 * Stamp + persist + deliver one Message to `to`'s mailbox. Returns the stamped
 * Message. At-least-once semantics: the SQLite mirror is INSERT OR IGNORE on
 * Message.id, and consumers dedupe on id (protocol.md §6.3).
 */
export function deliver(from: AgentId, input: BusSendInput): Message {
  assertSafeAgentId(from)
  assertSafeAgentId(input.to)
  if (!Array.isArray(input.parts) || input.parts.length === 0) {
    throw new Error('[bus] a Message needs at least one part (protocol.md §3)')
  }

  const msg: Message = {
    protocolVersion: PROTOCOL_VERSION,
    id: randomUUID(),
    from, // stamped by Main — never taken from the sender payload
    to: input.to,
    taskId: input.taskId ?? null,
    ts: new Date().toISOString(), // stamped by Main on ingest
    parts: input.parts
  }

  const box = join(busRoot(), input.to)
  const tmpDir = join(box, 'tmp')
  const newDir = join(box, 'new')
  mkdirSync(tmpDir, { recursive: true })
  mkdirSync(newDir, { recursive: true })
  mkdirSync(join(box, 'cur'), { recursive: true })

  const name = `${tsCompact(msg.ts)}-${msg.id}.md`
  const { front, body } = splitBody(msg.parts)
  const envelope = { ...msg, parts: front }
  const content = `---\n${JSON.stringify(envelope, null, 2)}\n---\n\n${body}\n`

  // write tmp → fsync → rename into new/ — readers may trust anything in new/
  const tmpPath = join(tmpDir, name)
  const fd = openSync(tmpPath, 'w')
  try {
    writeSync(fd, content, null, 'utf8')
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  renameSync(tmpPath, join(newDir, name))

  boardDb()
    .prepare(
      `INSERT OR IGNORE INTO bus_messages (id, from_agent, to_agent, task_id, ts, parts, file)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(msg.id, msg.from, msg.to, msg.taskId, msg.ts, JSON.stringify(msg.parts), name)

  return msg
}
