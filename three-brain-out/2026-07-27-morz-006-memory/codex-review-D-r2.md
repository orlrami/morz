# Verdict: FINDINGS

Reviewed `run/wave17/event-log` at `2973a92`. Round-1 regressions pass, but four new issues remain.

## Findings

1. **MEDIUM — Whitespace-obfuscated secrets bypass decoded base64 rescanning**

   - **Location:** [event-log.ts](C:/Projects/run-20260728051623-26b58c-event-log/src/main/memory/event-log.ts:152)
   - A contiguous base64url value decoding to `sk-proj-\n1234567890abcdefghijklmnop` was persisted verbatim as `agentId`.
   - `decodeCandidate()` canonicalizes default-ignorable characters but retains ordinary whitespace; `containsSecret()` therefore misses the reconstructed key.
   - Scan an additional whitespace-compacted decoded representation. Add an append-level regression—not only a `redactText()` assertion.

2. **MEDIUM — Stale-lock takeover has an ownership race**

   - **Location:** [event-log.ts](C:/Projects/run-20260728051623-26b58c-event-log/src/main/memory/event-log.ts:280)
   - Two contenders can both observe the old lock as stale. A can remove it and acquire a new lock; B can then remove A’s new lock based on its earlier observation and enter concurrently. A’s unconditional cleanup can subsequently delete B’s lock.
   - This reopens concurrent repair/rotate/append/clear and possible generation loss.
   - Avoid stat-then-unlink takeover. Use an ownership-aware locking implementation, or disable automatic takeover and recover abandoned locks only during verified single-instance startup.

3. **MEDIUM — Fail-closed writes silently lose events and block Main**

   - **Location:** [event-log.ts](C:/Projects/run-20260728051623-26b58c-event-log/src/main/memory/event-log.ts:303), [event-log.ts](C:/Projects/run-20260728051623-26b58c-event-log/src/main/memory/event-log.ts:605)
   - A live-lock probe blocked the Electron main thread for **1001 ms**, then returned `false`.
   - `logMemoryEvent()` warns only on thrown exceptions; timeout, invalid-record, and oversized-record failures return `false` silently. Production callers discard that result.
   - Return a discriminated status, increment a dropped-event counter, and emit a rate-limited warning for unexpected drops. Move lock waiting off the main thread. `clear()` should likewise report lock-timeout failure.

4. **LOW — `PROFILE_ROOT` mangles legitimate non-path identifiers**

   - **Location:** [event-log.ts](C:/Projects/run-20260728051623-26b58c-event-log/src/main/memory/event-log.ts:110)
   - The regex matches `/Users/<segment>` or `/home/<segment>` anywhere.
   - Probe: `mcp/Users/list` became `mcp~`, then persisted as `name: "[redacted]"`. A URL containing `/home/alice` was similarly rewritten.
   - Require an actual absolute-path boundary and avoid applying profile-path rewriting to tool/model fields.

## Confirmed round-1 fixes

- NFKC catches full-width and enclosed alphanumerics; ZWSP/WJ/FEFF/default-ignorable stripping works.
- Ordinary one-level base64/base64url secrets are caught.
- `meta.signal`, `meta.model`, identifier hashing, and split-record containment behave as claimed.
- `cwd` is absent from the shared contract and event producers.
- Basic live-lock rejection and stale-lock recovery work, subject to the race above.
- `is_error`: `true → error`, `false → ok`, everything else → `unknown`.

Verification passed: typecheck, production build, **17/17 unit tests**, and **6/6 targeted Electron E2E tests**.