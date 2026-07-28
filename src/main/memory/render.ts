/*
 * w17/renderer-core — the ONE memory renderer.
 *
 * Morz used to have two. `renderInjectionLines` (opset.ts) rendered launch
 * preambles: titles only, character budget, and it leaked SUPERSEDED facts
 * into prompts. `renderMemories` (context-hub.ts) rendered the managed block
 * in CLAUDE.md: full bodies, no budget at all, and it THREW when nothing was
 * enabled. They disagreed about what a renderable fact even is, and they were
 * drifting. Both outputs now come from one selection pass.
 *
 * Selection law: only enabled, non-expired, non-superseded facts render.
 * Superseded history stays queryable in Settings > Memory — it never reaches
 * a prompt or a context file. Scope filtering stays in the callers (the store
 * builds the global -> project -> space -> agent chain; context-hub passes a
 * space's entries), so this module is pure and node:test can drive it.
 */
import type { MemoryEntry, MemoryKind } from '../../shared/memory'

/** Characters of preamble text injected ahead of a lane's first prompt. */
export const MEMORY_PREAMBLE_BUDGET = 2_000

/** Lines a rendered context-file memory block may occupy. */
export const MEMORY_BLOCK_LINE_BUDGET = 200

/** Longest one-line body summary kept when a block falls back to summaries. */
const SUMMARY_LENGTH = 140

export interface MemoryPreambleOptions {
  /** Max characters of rendered preamble (default `MEMORY_PREAMBLE_BUDGET`). */
  budget?: number
}

export interface MemoryBlockOptions {
  /** Max lines of rendered block body (default `MEMORY_BLOCK_LINE_BUDGET`). */
  lineBudget?: number
}

const KIND_PRIORITY: Record<MemoryKind, number> = { rule: 0, skill: 1, fact: 2 }

/**
 * Agent C (w17/supersession) adds the link fields. Read them structurally so
 * this module compiles and behaves correctly both before and after that lands.
 */
function isSuperseded(entry: MemoryEntry): boolean {
  const link = (entry as { supersededBy?: string | null }).supersededBy
  return typeof link === 'string' && link.length > 0
}

/**
 * Memory text is user/agent authored, so it can contain our own managed
 * markers. Escaping the comment opener keeps a fact from closing the block it
 * is rendered inside.
 */
export function escapeMorzMarkers(value: string): string {
  return value.replace(/<!--\s*\/?morz:/gi, (marker) => marker.replace('<!--', '&lt;!--'))
}

/**
 * The single selection pass behind both outputs: deduplicated by id, only
 * facts that are currently true, ordered rule -> skill -> fact then newest
 * first with id as the tiebreak so renders are byte-stable.
 */
export function selectRenderableMemories(entries: MemoryEntry[]): MemoryEntry[] {
  const seen = new Set<string>()
  return entries
    .filter((entry) => !seen.has(entry.id) && seen.add(entry.id))
    .filter((entry) => entry.enabled && entry.expiredAt === undefined && !isSuperseded(entry))
    .sort(
      (a, b) =>
        KIND_PRIORITY[a.kind] - KIND_PRIORITY[b.kind] ||
        b.updatedAt.localeCompare(a.updatedAt) ||
        a.id.localeCompare(b.id)
    )
}

/**
 * Launch-prompt preamble. Titles only — the body stays the durable Markdown
 * explanation without crowding every prompt. Returns '' when nothing renders,
 * which callers treat as "inject nothing".
 */
export function renderMemoryPreamble(
  entries: MemoryEntry[],
  opts: MemoryPreambleOptions = {}
): string {
  const budget = opts.budget ?? MEMORY_PREAMBLE_BUDGET
  const selected = selectRenderableMemories(entries)
  if (selected.length === 0) return ''

  let rendered = '## How the user works\n'
  for (const entry of selected) {
    const line = `- **${entry.kind}:** ${escapeMorzMarkers(entry.title)}\n`
    if (line.length > budget - rendered.length) break
    rendered += line
  }
  return rendered.trimEnd()
}

function oneLineSummary(entry: MemoryEntry): string {
  const body = escapeMorzMarkers(entry.body).replace(/\s+/g, ' ').trim()
  if (!body) return ''
  return body.length > SUMMARY_LENGTH ? `${body.slice(0, SUMMARY_LENGTH - 1).trimEnd()}…` : body
}

function blockHeader(): string[] {
  return ['## Morz memory', '', 'Approved context shared with every CLI in this space.', '']
}

function countLines(text: string): number {
  return text === '' ? 0 : text.split('\n').length
}

/**
 * Body of the managed memory block written into a context file. The markers
 * themselves are added by the caller's block writer, so an empty store yields
 * '' — which becomes a marker pair with nothing between it. This never throws:
 * "no memories yet" is a normal state, not an error.
 */
export function renderMemoryBlock(entries: MemoryEntry[], opts: MemoryBlockOptions = {}): string {
  const lineBudget = opts.lineBudget ?? MEMORY_BLOCK_LINE_BUDGET
  const selected = selectRenderableMemories(entries)
  if (selected.length === 0) return ''

  const full = [
    ...blockHeader(),
    ...selected.flatMap((entry) => [
      `### ${escapeMorzMarkers(entry.title)}`,
      '',
      `_${entry.kind} · ${entry.scope}_`,
      '',
      escapeMorzMarkers(entry.body).trim(),
      ''
    ])
  ]
    .join('\n')
    .trim()
  if (countLines(full) <= lineBudget) return full

  // Over budget: drop bodies before dropping facts, and always say so. A CLI
  // reading a shortened block still learns every fact's title.
  const header = blockHeader()
  const room = Math.max(0, lineBudget - header.length - 2)
  const summarized = selected.slice(0, room).map((entry) => {
    const summary = oneLineSummary(entry)
    const title = escapeMorzMarkers(entry.title)
    return `- **${entry.kind}:** ${title}${summary ? ` — ${summary}` : ''}`
  })
  return [
    ...header,
    ...summarized,
    '',
    `<!-- morz:memory truncated: ${summarized.length} of ${selected.length} facts, open Morz > Memory -->`
  ]
    .join('\n')
    .trim()
}
