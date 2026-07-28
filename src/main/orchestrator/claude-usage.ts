/*
 * Worktree-attributed transcript token accounting (w17/adapter-seam).
 *
 * A dispatched pane runs the REAL interactive CLI, so there is no structured
 * event stream to meter from (stream-json needs print mode, which has no TUI —
 * see docs/in-progress/SEAM-DESIGN.md). Claude Code does write a per-project
 * JSONL transcript, and this reads it.
 *
 * Attribution is per RECORD, never per directory. The transcript directory name
 * is a lossy slug — `C:\Projects\foo-bar` and `C:\Projects\foo\bar` both become
 * `C--Projects-foo-bar` — so the directory only narrows the search. Ownership is
 * decided by canonically matching each record's own `cwd` against the agent's
 * worktree, and a record that cannot prove ownership is skipped, never guessed.
 *
 * Accounting is incremental and deduplicated by message id. Claude Code's
 * session fork copies history into the new session file (the repo's own Orca
 * research, §P2.6b, records that naive counting double-counts across forks), so
 * a reader returns only records it has never seen, as a DELTA. Nothing ever
 * re-reports a running total, which also removes the failure mode where a
 * transcript reading lower than last time gets added a second time.
 *
 * Token keys match the preload lane meter (src/preload/index.ts:381-386): input,
 * output, and BOTH cache fields. Transcripts carry tokens, not dollars.
 */
import { createReadStream } from 'fs'
import { readdir, realpath } from 'fs/promises'
import { join, normalize, resolve } from 'path'
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
 * Comparable form of a path. `realpath` resolves 8.3 names, symlinks and
 * junctions (worktrees behind a junction are normal here); when the path no
 * longer exists — a cleaned-up worktree — lexical normalization still gives a
 * stable key. Windows paths are case-insensitive, so comparison is lowercased.
 */
export async function canonicalPath(path: string): Promise<string> {
  let resolved = path
  try {
    resolved = await realpath(path)
  } catch {
    // gone or unreadable — the lexical form is the best available key
  }
  const normalized = normalize(resolve(resolved)).replace(/[\\/]+$/, '')
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

interface TranscriptRecord {
  type?: string
  cwd?: string
  uuid?: string
  requestId?: string
  timestamp?: string
  message?: {
    id?: string
    usage?: Record<string, unknown>
  }
}

/** Stable identity for a record, or null when it cannot be identified. */
function recordKey(record: TranscriptRecord): string | null {
  const messageId = record.message?.id
  if (typeof messageId === 'string' && messageId) return `m:${messageId}`
  if (typeof record.uuid === 'string' && record.uuid) return `u:${record.uuid}`
  if (typeof record.requestId === 'string' && record.requestId) return `r:${record.requestId}`
  return null
}

/** Everything Anthropic bills as input, matching the preload lane meter. */
const INPUT_TOKEN_KEYS = [
  'input_tokens',
  'cache_creation_input_tokens',
  'cache_read_input_tokens'
] as const

export interface TranscriptReaderOpts {
  /** The agent's worktree — the ONLY cwd whose records count. */
  worktree: string
  /** Transcript root (the user's home in production). Injected, never env-read here. */
  root: string
  /** Records stamped before this belong to an earlier run; epoch ms. */
  since: number
}

export interface TranscriptReader {
  /** Tokens added since the last call, or null when nothing new was attributable. */
  read(): Promise<TranscriptUsage | null>
}

/**
 * One reader per dispatched agent. Stateful: it remembers which records it has
 * already counted, so repeated reads are idempotent and safe to call as often
 * as a turn ends — including twice during teardown.
 */
export function createTranscriptReader(opts: TranscriptReaderOpts): TranscriptReader {
  const seen = new Set<string>()
  const canonicalCache = new Map<string, string>()
  let ownerPath: string | null = null

  const canonical = async (path: string): Promise<string> => {
    const cached = canonicalCache.get(path)
    if (cached !== undefined) return cached
    const value = await canonicalPath(path)
    canonicalCache.set(path, value)
    return value
  }

  /** True only when the record PROVES it belongs to this agent's worktree. */
  const owns = async (record: TranscriptRecord): Promise<boolean> => {
    if (typeof record.cwd !== 'string' || !record.cwd) return false // fail closed
    if (ownerPath === null) ownerPath = await canonical(opts.worktree)
    return (await canonical(record.cwd)) === ownerPath
  }

  const withinRun = (record: TranscriptRecord): boolean => {
    if (typeof record.timestamp !== 'string') return true // unstamped — cwd still decides
    const stamped = Date.parse(record.timestamp)
    return Number.isNaN(stamped) || stamped >= opts.since
  }

  return {
    async read(): Promise<TranscriptUsage | null> {
      const dir = join(opts.root, '.claude', 'projects', projectSlug(opts.worktree))
      let files: string[]
      try {
        files = (await readdir(dir)).filter((name) => name.endsWith('.jsonl'))
      } catch {
        return null // no transcript directory for this worktree
      }

      const totals: TranscriptUsage = { inputTokens: 0, outputTokens: 0 }
      let counted = false

      for (const file of files) {
        let reader: ReturnType<typeof createInterface>
        try {
          reader = createInterface({
            input: createReadStream(join(dir, file), { encoding: 'utf8' }),
            crlfDelay: Infinity
          })
        } catch {
          continue // unreadable transcript (rotated, locked) — the others still count
        }
        try {
          for await (const line of reader) {
            if (!line.includes('"usage"')) continue
            let record: TranscriptRecord
            try {
              record = JSON.parse(line) as TranscriptRecord
            } catch {
              continue // half-written line while the CLI appends — skip it
            }
            if (record.type !== 'assistant') continue
            const usage = record.message?.usage
            if (!usage) continue
            const key = recordKey(record)
            // unidentifiable (cannot be deduped across a fork) or already counted
            if (key === null || seen.has(key)) continue
            if (!withinRun(record)) continue
            if (!(await owns(record))) continue

            seen.add(key)
            for (const tokenKey of INPUT_TOKEN_KEYS) {
              const value = usage[tokenKey]
              if (typeof value === 'number' && value > 0) totals.inputTokens += value
            }
            const output = usage.output_tokens
            if (typeof output === 'number' && output > 0) totals.outputTokens += output
            counted = true
          }
        } catch {
          // stream died mid-read — whatever was counted stays counted
        } finally {
          reader.close()
        }
      }

      return counted ? totals : null
    }
  }
}
