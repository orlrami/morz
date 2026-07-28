/*
 * Worktree-attributed transcript token scan (w17/adapter-seam).
 *
 * A dispatched pane runs the REAL interactive CLI, so there is no structured
 * event stream to meter from (stream-json needs print mode, which has no TUI —
 * see docs/in-progress/SEAM-DESIGN.md). Claude Code does, however, write a
 * per-project JSONL transcript, and every dispatched agent owns its own git
 * worktree — so `~/.claude/projects/<slug(worktree)>` belongs to exactly one
 * agent of one run and attribution needs no session id.
 *
 * Same record shape the lane adapter already reads (adapters/claude.ts:151).
 * Transcripts carry tokens, not dollars: callers report tokens and leave usd
 * null rather than inventing a price table.
 */
import { createReadStream } from 'fs'
import { readdir } from 'fs/promises'
import { homedir } from 'os'
import { join } from 'path'
import { createInterface } from 'readline'

export interface TranscriptUsage {
  inputTokens: number
  outputTokens: number
}

/** ~/.claude transcript dir slug: every non-alphanumeric path char becomes '-'. */
export function projectSlug(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-')
}

/**
 * Transcript root. The override is gated on MORZ_E2E so the suite can prove the
 * real metering path against a fixture transcript without writing into the
 * owner's ~/.claude — it is inert in every shipped build.
 */
function claudeHome(): string {
  const override = process.env.MORZ_E2E === '1' ? process.env.MORZ_E2E_CLAUDE_HOME : undefined
  return override || homedir()
}

function sumLine(line: string, totals: TranscriptUsage): void {
  if (!line.includes('"usage"')) return
  try {
    const record = JSON.parse(line) as {
      type?: string
      message?: { usage?: { input_tokens?: number; output_tokens?: number } }
    }
    const usage = record.type === 'assistant' ? record.message?.usage : undefined
    if (!usage) return
    totals.inputTokens += usage.input_tokens ?? 0
    totals.outputTokens += usage.output_tokens ?? 0
  } catch {
    // a half-written line while the CLI is mid-append — skip it, keep summing
  }
}

/**
 * Cumulative tokens for one worktree, or null when the CLI has written no
 * transcript for it (not installed, different CLI, or no turn completed yet).
 * Read line-by-line: a long session's transcript is not something to buffer.
 */
export async function scanWorktreeUsage(worktree: string): Promise<TranscriptUsage | null> {
  const dir = join(claudeHome(), '.claude', 'projects', projectSlug(worktree))
  let files: string[]
  try {
    files = (await readdir(dir)).filter((name) => name.endsWith('.jsonl'))
  } catch {
    return null // no transcript directory for this worktree
  }
  if (files.length === 0) return null

  const totals: TranscriptUsage = { inputTokens: 0, outputTokens: 0 }
  let seen = false
  for (const file of files) {
    try {
      const reader = createInterface({
        input: createReadStream(join(dir, file), { encoding: 'utf8' }),
        crlfDelay: Infinity
      })
      for await (const line of reader) {
        const before = totals.inputTokens + totals.outputTokens
        sumLine(line, totals)
        if (totals.inputTokens + totals.outputTokens !== before) seen = true
      }
    } catch {
      // unreadable transcript (rotated, locked) — the other files still count
    }
  }
  return seen ? totals : null
}
