/*
 * Terminal-title → agent activity classifier (w17/adapter-seam).
 *
 * Turns the titles pulled by osc-title.ts into the three states Morz can honestly
 * observe without installing anything into the user's CLI config:
 *
 *   working — the agent is mid-turn
 *   waiting — the agent is blocked on the owner (permission / question)
 *   idle    — the agent is sitting at its prompt
 *
 * `null` means "this title says nothing about an agent" and is NOT a state.
 * Note what is missing: there is no `done`. `idle` is reached both by finishing
 * a task and by the owner DENYING a permission, and fast tasks skip `working`
 * entirely — so completion cannot be inferred from a title. Run completion is
 * 0.0.7 work with a real definition-of-done signal.
 *
 * Ported from Orca (onorca.dev, MIT); glyph table, evaluation order and the
 * boundary regex come from docs/research/ORCA-COMPETITOR-RESEARCH.md §P2.1.4.
 */

export type AgentActivity = 'working' | 'waiting' | 'idle'

/* ── glyphs the agent CLIs paint into their titles ── */

const GEMINI_WAITING = '✋' // ✋
const GEMINI_WORKING = ['✦', '⏲'] // ✦ ⏲
const GEMINI_IDLE = '◇' // ◇
const CLAUDE_IDLE = '✳' // ✳

/** Any braille codepoint is a spinner frame — the one universal working signal. */
function containsBrailleSpinner(title: string): boolean {
  for (const char of title) {
    const code = char.codePointAt(0) ?? 0
    if (code >= 0x2800 && code <= 0x28ff) return true
  }
  return false
}

/**
 * Name tokens that make a title agent-owned. Without one of these the title is
 * almost always an ordinary shell/cwd title and must classify as null — this
 * bail-out is what keeps the classifier from labelling every terminal an agent.
 */
const AGENT_NAME_TOKENS = [
  'claude',
  'codex',
  'gemini',
  'antigravity',
  'opencode'
]

/**
 * Keyword boundaries that also exclude path separators. Plain \b matches inside
 * hyphenated tokens and cwd paths (`~/codex/ready`, `run-done-fix`); the left
 * guard blocks `.`, `/`, `\` and `-` so a directory name can never read as state.
 * This is the difference between a usable classifier and a useless one.
 */
const STRONG_WAITING_RE = /(?<![\w./\\-])(action required|permission|waiting|approve)(?![\w-])/i
const STRONG_IDLE_RE = /(?<![\w./\\-])(ready|idle|done)(?![\w-])/i
const STRONG_WORKING_RE = /(?<![\w./\\-])(working|thinking|running)(?![\w-])/i

/**
 * Collapse animation frames so one logical state produces one stable string.
 * Spinners tick every ~80ms; without this the run card strobes several times a
 * second and every frame looks like a fresh event.
 */
export function normalizeTerminalTitle(title: string): string {
  let normalized = ''
  for (const char of title) {
    const code = char.codePointAt(0) ?? 0
    normalized += code >= 0x2800 && code <= 0x28ff ? '⠋' : char
  }
  return normalized.replace(/\s+/g, ' ').trim()
}

/** Classify one title. Returns null when the title is not about an agent. */
export function detectActivityFromTitle(title: string): AgentActivity | null {
  const trimmed = title.trim()
  if (!trimmed) return null

  // 1. explicit glyphs win — they are structural markers, not prose
  if (trimmed.includes(GEMINI_WAITING)) return 'waiting'
  if (GEMINI_WORKING.some((glyph) => trimmed.includes(glyph))) return 'working'
  if (trimmed.includes(GEMINI_IDLE)) return 'idle'
  if (trimmed.startsWith(CLAUDE_IDLE) || trimmed === CLAUDE_IDLE) return 'idle'
  if (containsBrailleSpinner(trimmed)) return 'working'

  // 2. no agent name → not an agent title (cwd titles land here and stay null)
  const lower = trimmed.toLowerCase()
  if (!AGENT_NAME_TOKENS.some((token) => lower.includes(token))) return null

  // 3. prose, most specific first
  if (STRONG_WAITING_RE.test(trimmed)) return 'waiting'
  if (STRONG_IDLE_RE.test(trimmed)) return 'idle'
  if (STRONG_WORKING_RE.test(trimmed)) return 'working'

  // 4. Claude Code's own prefix conventions
  if (trimmed.startsWith('. ')) return 'working'
  if (trimmed.startsWith('* ')) return 'idle'

  return 'idle'
}

export interface TitleTracker {
  /** Feed one title; returns the activity ONLY when it changed, else null. */
  handle(title: string): AgentActivity | null
  /** Adopt a known activity without firing a change (restore path). */
  seed(activity: AgentActivity | null): void
  current(): AgentActivity | null
}

/**
 * Edge-triggered, no timers. Debounce is structural: titles are normalized
 * before comparison, and an unclassifiable title never overwrites the last
 * known activity — while an agent works, transient internal titles are common
 * and treating them as "no agent" would drop the next real transition.
 */
export function createTitleTracker(): TitleTracker {
  let activity: AgentActivity | null = null
  let lastTitle = ''
  return {
    handle(title: string): AgentActivity | null {
      const normalized = normalizeTerminalTitle(title)
      if (normalized === lastTitle) return null
      lastTitle = normalized
      const next = detectActivityFromTitle(normalized)
      if (next === null || next === activity) return null
      activity = next
      return next
    },
    seed(next: AgentActivity | null): void {
      activity = next
    },
    current(): AgentActivity | null {
      return activity
    }
  }
}
