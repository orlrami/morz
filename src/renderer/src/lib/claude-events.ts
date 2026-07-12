/*
 * Claude stream-json event → agent-block view-model (Slice 5).
 * Pure reducer: ClaudeLane feeds every claude:event through reduceEvent and
 * renders the resulting blocks natively (no terminal emulation for this lane).
 *
 * Streaming text arrives twice: as stream_event deltas (partial) and again in
 * the full `assistant` message. Reconcile by dropping trailing streaming text
 * blocks when the final assistant message lands.
 */
import type { ClaudeEvent } from '@shared/ipc'

export type LaneBlock =
  | { kind: 'user'; id: string; text: string }
  | { kind: 'text'; id: string; text: string; streaming: boolean }
  | { kind: 'tool'; id: string; name: string; input: unknown; output?: string; isError?: boolean }
  | {
      kind: 'result'
      id: string
      isError: boolean
      costUsd: number | null
      inputTokens: number | null
      outputTokens: number | null
      durationMs: number | null
    }
  | { kind: 'info'; id: string; text: string }

let nextId = 0
const id = (): string => `blk-${nextId++}`

/* Loose views over the untyped ClaudeEvent payloads we consume. */
interface SseEvent {
  type?: string
  content_block?: { type?: string }
  delta?: { type?: string; text?: string }
}
interface ContentItem {
  type?: string
  text?: string
  id?: string
  name?: string
  input?: unknown
  tool_use_id?: string
  is_error?: boolean
  content?: unknown
}

export function reduceEvent(blocks: LaneBlock[], ev: ClaudeEvent): LaneBlock[] {
  switch (ev.type) {
    case 'system': {
      if ((ev as { subtype?: string }).subtype !== 'init') return blocks
      const init = ev as { session_id?: string; model?: string }
      return [
        ...blocks,
        { kind: 'info', id: id(), text: `session ${init.session_id ?? '?'} · ${init.model ?? '?'}` }
      ]
    }
    case 'stream_event':
      return reduceSse(blocks, (ev as { event?: SseEvent }).event ?? {})
    case 'assistant':
      return reduceAssistant(blocks, contentOf(ev))
    case 'user':
      return reduceToolResults(blocks, contentOf(ev))
    case 'result': {
      const r = ev as {
        is_error?: boolean
        total_cost_usd?: number
        duration_ms?: number
        usage?: { input_tokens?: number; output_tokens?: number }
      }
      return [
        ...blocks,
        {
          kind: 'result',
          id: id(),
          isError: r.is_error ?? false,
          costUsd: r.total_cost_usd ?? null,
          inputTokens: r.usage?.input_tokens ?? null,
          outputTokens: r.usage?.output_tokens ?? null,
          durationMs: r.duration_ms ?? null
        }
      ]
    }
    case 'api_retry':
      return [...blocks, { kind: 'info', id: id(), text: 'API retry — waiting on Anthropic' }]
    case 'stderr':
      return blocks // diagnostic noise; surfaced only via process_error/exit
    case 'process_error':
      return [
        ...blocks,
        { kind: 'info', id: id(), text: `claude failed to start: ${(ev as { message?: string }).message ?? ''}` }
      ]
    case 'process_exit': {
      const code = (ev as { code?: number | null }).code
      return [...blocks, { kind: 'info', id: id(), text: `claude exited (code ${code ?? '?'})` }]
    }
    case 'parse_error':
      return [...blocks, { kind: 'info', id: id(), text: 'malformed event skipped' }]
    default:
      return blocks
  }
}

/** Local echo for the user's own prompt (send() is fire-and-forget). */
export function userBlock(text: string): LaneBlock {
  return { kind: 'user', id: id(), text }
}

function contentOf(ev: ClaudeEvent): ContentItem[] {
  const msg = (ev as { message?: { content?: unknown } }).message
  return Array.isArray(msg?.content) ? (msg.content as ContentItem[]) : []
}

function reduceSse(blocks: LaneBlock[], sse: SseEvent): LaneBlock[] {
  if (sse.type === 'content_block_start' && sse.content_block?.type === 'text') {
    return [...blocks, { kind: 'text', id: id(), text: '', streaming: true }]
  }
  if (sse.type === 'content_block_delta' && sse.delta?.type === 'text_delta') {
    const last = blocks[blocks.length - 1]
    if (last?.kind === 'text' && last.streaming) {
      return [...blocks.slice(0, -1), { ...last, text: last.text + (sse.delta.text ?? '') }]
    }
    return [...blocks, { kind: 'text', id: id(), text: sse.delta.text ?? '', streaming: true }]
  }
  return blocks
}

function reduceAssistant(blocks: LaneBlock[], content: ContentItem[]): LaneBlock[] {
  // Drop trailing streaming text (partials) — the final message replaces them.
  let out = [...blocks]
  while (out.length > 0) {
    const last = out[out.length - 1]
    if (last.kind === 'text' && last.streaming) out = out.slice(0, -1)
    else break
  }
  for (const item of content) {
    if (item.type === 'text' && item.text) {
      out.push({ kind: 'text', id: id(), text: item.text, streaming: false })
    } else if (item.type === 'tool_use') {
      out.push({
        kind: 'tool',
        id: item.id ?? id(),
        name: item.name ?? 'tool',
        input: item.input
      })
    }
  }
  return out
}

function reduceToolResults(blocks: LaneBlock[], content: ContentItem[]): LaneBlock[] {
  let out = blocks
  for (const item of content) {
    if (item.type !== 'tool_result' || !item.tool_use_id) continue
    out = out.map((b) =>
      b.kind === 'tool' && b.id === item.tool_use_id
        ? { ...b, output: toolResultText(item.content), isError: item.is_error ?? false }
        : b
    )
  }
  return out
}

function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((c: { type?: string; text?: string }) => (c?.type === 'text' ? (c.text ?? '') : ''))
      .join('\n')
      .trim()
  }
  return content == null ? '' : JSON.stringify(content)
}
