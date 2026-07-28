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
 * FAIL CLOSED. Anything a pane's child process writes reaches this function, and
 * an activity can move an agent's lifecycle state, so a title must PROVE it
 * belongs to an agent before it is read as one:
 *
 *   1. Ownership first. Either the caller names the CLI the pane was launched
 *      with (the dispatcher always knows), or the title contains a boundary-
 *      matched agent name. Without ownership the answer is null, whatever the
 *      title says.
 *   2. Glyphs are anchored to the canonical leading position and scoped to the
 *      CLI that uses them — `✋ build paused` in an unowned pane is not waiting.
 *   3. Keyword rules additionally require a NAMED agent, because `permission`,
 *      `ready` and `working` are ordinary English that anything may print.
 *   4. No fallback. A title matching nothing returns null rather than guessing.
 *
 * Ported from Orca (onorca.dev, MIT); the glyph table and boundary regex come
 * from docs/research/ORCA-COMPETITOR-RESEARCH.md §P2.1.4. The ownership-first
 * ordering is stricter than theirs, because their authoritative channel is
 * agent hooks and titles are only a fallback — for Morz, titles ARE the channel.
 */

export type AgentActivity = 'working' | 'waiting' | 'idle'

/** The CLIs Morz launches. `agy` drives Gemini, hence the Gemini glyph set. */
export type TitleCli = 'claude' | 'codex' | 'agy' | 'opencode'

/**
 * Leading markers each CLI writes, in canonical position. A marker only counts
 * at the very start of the title — that is where every real agent puts it, and
 * requiring it stops a task description that merely contains a glyph from
 * reading as state. codex and opencode are empty on purpose: Morz has no
 * verified title vocabulary for them, and inventing one would be a guess.
 */
const LEADING_MARKERS: Record<TitleCli, ReadonlyArray<readonly [string, AgentActivity]>> = {
  claude: [
    ['✳', 'idle'], // U+2733
    ['. ', 'working'], // Claude Code's own prefix conventions
    ['* ', 'idle']
  ],
  agy: [
    ['✋', 'waiting'], // U+270B
    ['✦', 'working'], // U+2726
    ['⏲', 'working'], // U+23F2
    ['◇', 'idle'] // U+25C7
  ],
  codex: [],
  opencode: []
}

const CLI_ORDER: readonly TitleCli[] = ['claude', 'agy', 'codex', 'opencode']

/** Product names that identify their CLI, boundary-matched (see the guard below). */
const NAME_TO_CLI: ReadonlyArray<readonly [string, TitleCli]> = [
  ['claude', 'claude'],
  ['codex', 'codex'],
  ['gemini', 'agy'],
  ['antigravity', 'agy'],
  ['opencode', 'opencode']
]

/**
 * Boundaries that also exclude path separators. Plain \b matches inside
 * hyphenated tokens and cwd paths (`~/codex/ready`, `claude-tools`); the left
 * guard blocks `.`, `/`, `\` and `-` so a directory name can never read as an
 * agent name or as state. This is the difference between a usable classifier
 * and one that labels every terminal an agent.
 */
const LEFT_GUARD = '(?<![\\w./\\\\-])'
const RIGHT_GUARD = '(?![\\w-])'
const NAME_MATCHERS: ReadonlyArray<readonly [RegExp, TitleCli]> = NAME_TO_CLI.map(
  ([name, cli]) => [new RegExp(`${LEFT_GUARD}${name}${RIGHT_GUARD}`, 'i'), cli] as const
)

const STRONG_WAITING_RE = new RegExp(
  `${LEFT_GUARD}(action required|permission|waiting|approve)${RIGHT_GUARD}`,
  'i'
)
const STRONG_IDLE_RE = new RegExp(`${LEFT_GUARD}(ready|idle|done)${RIGHT_GUARD}`, 'i')
const STRONG_WORKING_RE = new RegExp(
  `${LEFT_GUARD}(working|thinking|running)${RIGHT_GUARD}`,
  'i'
)

function isBraille(code: number): boolean {
  return code >= 0x2800 && code <= 0x28ff
}

/** A braille codepoint in the leading position is a spinner frame. */
function startsWithSpinner(title: string): boolean {
  const first = title.codePointAt(0)
  return first !== undefined && isBraille(first)
}

/** Which CLIs this title names outright — a name is ownership evidence. */
export function namedClis(title: string): TitleCli[] {
  const found: TitleCli[] = []
  for (const [matcher, cli] of NAME_MATCHERS) {
    if (matcher.test(title) && !found.includes(cli)) found.push(cli)
  }
  return found
}

/**
 * Collapse animation frames so one logical state produces one stable string.
 * Spinners tick every ~80ms; without this the run card strobes several times a
 * second and every frame looks like a fresh event.
 */
export function normalizeTerminalTitle(title: string): string {
  let normalized = ''
  for (const char of title) {
    const code = char.codePointAt(0) ?? 0
    normalized += isBraille(code) ? '⠋' : char
  }
  return normalized.replace(/\s+/g, ' ').trim()
}

/**
 * Classify one title. `cli` is the CLI the pane was launched with — supplying it
 * is what lets a real agent title be read without the product name in it. With
 * no `cli` and no name in the title, the answer is always null.
 */
export function detectActivityFromTitle(title: string, cli?: TitleCli): AgentActivity | null {
  const trimmed = title.trim()
  if (!trimmed) return null

  // 1. ownership, established before anything is read as state
  const named = namedClis(trimmed)
  const owners = new Set<TitleCli>(named)
  if (cli) owners.add(cli)
  if (owners.size === 0) return null

  // 2. leading markers, scoped to an owning CLI
  for (const owner of CLI_ORDER) {
    if (!owners.has(owner)) continue
    for (const [marker, activity] of LEADING_MARKERS[owner]) {
      if (trimmed.startsWith(marker)) return activity
    }
  }
  // the spinner is universal, but still only for a pane an agent owns
  if (startsWithSpinner(trimmed)) return 'working'

  // 3. prose needs a NAMED agent — these words are ordinary English
  if (named.length === 0) return null
  if (STRONG_WAITING_RE.test(trimmed)) return 'waiting'
  if (STRONG_IDLE_RE.test(trimmed)) return 'idle'
  if (STRONG_WORKING_RE.test(trimmed)) return 'working'

  // 4. no fallback: an unrecognized title is not a state
  return null
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
export function createTitleTracker(cli?: TitleCli): TitleTracker {
  let activity: AgentActivity | null = null
  let lastTitle = ''
  return {
    handle(title: string): AgentActivity | null {
      const normalized = normalizeTerminalTitle(title)
      if (normalized === lastTitle) return null
      lastTitle = normalized
      const next = detectActivityFromTitle(normalized, cli)
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
