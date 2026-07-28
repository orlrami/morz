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

/** Lines a memory block may occupy in a context file, markers included. */
export const MEMORY_BLOCK_LINE_BUDGET = 200

/** Longest one-line body summary kept when a block falls back to summaries. */
const SUMMARY_LENGTH = 140

/** The open/close marker pair the caller wraps around a rendered block. */
const BLOCK_MARKER_LINES = 2

const PREAMBLE_HEADING = '## How the user works'

export interface MemoryPreambleOptions {
  /** Max characters of rendered preamble (default `MEMORY_PREAMBLE_BUDGET`). */
  budget?: number
}

export interface MemoryBlockOptions {
  /**
   * Max lines of the complete managed block — the body rendered here plus the
   * two marker lines the caller adds (default `MEMORY_BLOCK_LINE_BUDGET`).
   */
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
 * The single selection pass behind both outputs: only facts that are currently
 * true, deduplicated by id, ordered rule -> skill -> fact then newest first
 * with id as the tiebreak so renders are byte-stable.
 *
 * Filtering runs BEFORE deduplication on purpose. Scope files are hand-editable
 * and the loader does not reject duplicate ids, so deduplicating first would let
 * a disabled or superseded row shadow the live fact that shares its id.
 */
export function selectRenderableMemories(entries: MemoryEntry[]): MemoryEntry[] {
  const seen = new Set<string>()
  return entries
    .filter((entry) => entry.enabled && !entry.expiredAt && !isSuperseded(entry))
    .filter((entry) => !seen.has(entry.id) && seen.add(entry.id))
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
 *
 * The budget is a hard cap on the returned string. A budget too small for the
 * heading and at least one fact renders nothing rather than a bare heading.
 */
export function renderMemoryPreamble(
  entries: MemoryEntry[],
  opts: MemoryPreambleOptions = {}
): string {
  const budget = opts.budget ?? MEMORY_PREAMBLE_BUDGET
  const selected = selectRenderableMemories(entries)
  if (selected.length === 0) return ''

  const heading = `${PREAMBLE_HEADING}\n`
  let used = heading.length
  const bullets: string[] = []
  for (const entry of selected) {
    const line = `- **${entry.kind}:** ${escapeMorzMarkers(entry.title)}\n`
    if (used + line.length > budget) break
    used += line.length
    bullets.push(line)
  }
  if (bullets.length === 0) return ''
  return `${heading}${bullets.join('')}`.trimEnd()
}

function oneLineSummary(entry: MemoryEntry): string {
  // Only the head of a body can survive the cap, so never normalize the whole
  // thing — bodies run to 50k characters and this returns at most ~140.
  const head = entry.body.slice(0, SUMMARY_LENGTH * 8).replace(/\s+/g, ' ').trim()
  if (!head) return ''
  const capped =
    head.length > SUMMARY_LENGTH ? `${head.slice(0, SUMMARY_LENGTH - 1).trimEnd()}…` : head
  // Escaping last keeps a marker from being split across the slice boundary.
  return escapeMorzMarkers(capped)
}

function blockHeader(): string[] {
  return ['## Morz memory', '', 'Approved context shared with every CLI in this space.', '']
}

/** Newline count without allocating a split array — bodies reach 50k chars. */
function countLines(text: string): number {
  let lines = 1
  for (let at = text.indexOf('\n'); at !== -1; at = text.indexOf('\n', at + 1)) lines += 1
  return lines
}

function truncationNotice(shown: number, total: number): string {
  return `<!-- morz:memory truncated: ${shown} of ${total} facts, open Morz > Memory -->`
}

/**
 * Body of the managed memory block written into a context file. The markers
 * themselves are added by the caller's block writer, so an empty store yields
 * '' — which becomes a marker pair with nothing between it. This never throws:
 * "no memories yet" is a normal state, not an error.
 *
 * `lineBudget` covers the COMPLETE managed block, so the two marker lines the
 * caller adds are reserved here. Full bodies are accumulated incrementally and
 * abandoned the moment they overrun the budget — rendering every body first
 * just to discard it costs tens of megabytes on a large store.
 */
export function renderMemoryBlock(entries: MemoryEntry[], opts: MemoryBlockOptions = {}): string {
  const lineBudget = opts.lineBudget ?? MEMORY_BLOCK_LINE_BUDGET
  const bodyBudget = lineBudget - BLOCK_MARKER_LINES
  const selected = selectRenderableMemories(entries)
  if (selected.length === 0 || bodyBudget < 1) return ''

  const header = blockHeader()
  const lines = [...header]
  let used = header.length
  let overran = false
  for (const entry of selected) {
    const body = escapeMorzMarkers(entry.body).trim()
    // Heading, blank, meta, blank, body, trailing blank.
    const cost = 5 + countLines(body)
    if (used + cost > bodyBudget) {
      overran = true
      break
    }
    used += cost
    lines.push(
      `### ${escapeMorzMarkers(entry.title)}`,
      '',
      `_${entry.kind} · ${entry.scope}_`,
      '',
      body,
      ''
    )
  }
  if (!overran) return lines.join('\n').trim()

  // Over budget: drop bodies before dropping facts, and always say so. A CLI
  // reading a shortened block still learns every kept fact's title.
  const room = bodyBudget - header.length - 2
  if (room < 1) {
    // Too small even for the header. Keep the pointer, drop the prose — the
    // one thing that must never happen is losing facts without saying so.
    return truncationNotice(0, selected.length)
  }
  const summarized = selected.slice(0, room).map((entry) => {
    const summary = oneLineSummary(entry)
    const title = escapeMorzMarkers(entry.title)
    return `- **${entry.kind}:** ${title}${summary ? ` — ${summary}` : ''}`
  })
  return [...header, ...summarized, '', truncationNotice(summarized.length, selected.length)]
    .join('\n')
    .trim()
}
