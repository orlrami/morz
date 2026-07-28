# FINDINGS

1. **HIGH — Transcript directory is not a safe attribution boundary.** [claude-usage.ts:27](/C:/Projects/morz-seam/src/main/orchestrator/claude-usage.ts:27), [claude-usage.ts:62](/C:/Projects/morz-seam/src/main/orchestrator/claude-usage.ts:62), [cost-meter.ts:462](/C:/Projects/morz-seam/src/main/orchestrator/cost-meter.ts:462)  
   `C:\Projects\foo-bar` and `C:\Projects\foo\bar` both become `C--Projects-foo-bar`; every JSONL in that directory is summed. Forked sessions also copy history, which the repo’s own Orca research warns will double-count. Worse, a temporarily lower scan is treated as a fresh total and added again.  
   **Fix:** Canonicalize and match each record’s `cwd`, snapshot eligible sessions at registration, and deduplicate records by message ID/UUID. Fail closed when ownership is ambiguous; use incremental offsets or record-level accounting rather than rescanning aggregate totals.

2. **HIGH — Stop and overlapping scans lose final usage.** [pane-bridge.ts:120](/C:/Projects/morz-seam/src/main/orchestrator/pane-bridge.ts:120), [pane-bridge.ts:194](/C:/Projects/morz-seam/src/main/orchestrator/pane-bridge.ts:194), [dispatcher.ts:451](/C:/Projects/morz-seam/src/main/orchestrator/dispatcher.ts:451)  
   `scanning` drops—not queues—another meter request. More decisively, teardown calls `releaseRun()` before killing panes, so the subsequent `paneExited()` cannot perform the promised final scan. A run stopped while still `working` can report zero usage.  
   **Fix:** Serialize scans with a pending-rescan flag, await a final scan before detaching, and use a generation/disposed guard so an old async scan cannot update a released run.

3. **HIGH — `waiting → idle` leaves the ledger permanently blocked.** [pane-bridge.ts:106](/C:/Projects/morz-seam/src/main/orchestrator/pane-bridge.ts:106)  
   The reproduced transition yielded activity `idle` but lifecycle transitions only `["blocked"]`. Denying an approval therefore leaves `agents[agentId] === "blocked"` indefinitely, despite the CLI being back at its prompt.  
   **Fix:** Map `idle` back to `running` only when the bridge itself previously applied `blocked`. This clears the wait without inferring completion. Reconcile against actual run-store state rather than trusting the cached `pane.lifecycle`.

4. **MEDIUM — “Real tokens” omits Claude cache tokens.** [claude-usage.ts:44](/C:/Projects/morz-seam/src/main/orchestrator/claude-usage.ts:44)  
   Only `input_tokens` and `output_tokens` are counted, while Claude transcripts also contain `cache_creation_input_tokens` and `cache_read_input_tokens`; the existing preload meter already includes all four.  
   **Fix:** Add both cache fields to input totals and cover them in fixtures.

5. **MEDIUM — Classifier ownership checks are bypassed or too weak.** [agent-title-status.ts:81](/C:/Projects/morz-seam/src/shared/agent-title-status.ts:81)  
   Glyph checks happen before the agent-name guard, and names use substring matching. Probes classified `✋ build paused` as `waiting`, `⠋ docs` as `working`, and `permission — C:\projects\claude-tools` as `waiting`. Any process controlling a dispatched pane’s title can therefore mutate lifecycle state.  
   **Fix:** Require CLI-specific ownership first, boundary-match agent names, and anchor glyph conventions to canonical title positions. Unknown titles must fail closed.

6. **MEDIUM — OSC parsing diverges from xterm on malformed termination.** [osc-title.ts:75](/C:/Projects/morz-seam/src/shared/osc-title.ts:75)  
   The parser recognizes only BEL and `ESC \`. Xterm ends OSC on any ESC and also supports C1 ST. `OSC 2;Claude idle ESC X permission BEL` is rendered by xterm with the title ending at ESC, but this scanner extracts the later `permission` text and classifies it as waiting.  
   **Fix:** Implement a small state machine matching xterm semantics: BEL/ESC/C1-ST termination, CAN/SUB abort, C1 OSC support, and cross-chunk tests for malformed ESC/ST.

7. **MEDIUM — The synchronous tap can stall future PTY relay.** [index.ts:181](/C:/Projects/morz-seam/src/main/index.ts:181), [pane-bridge.ts:177](/C:/Projects/morz-seam/src/main/orchestrator/pane-bridge.ts:177), [osc-title.ts:111](/C:/Projects/morz-seam/src/shared/osc-title.ts:111)  
   An 80 KB probe containing 4,096 alternating titles caused 4,096 synchronous lifecycle updates/pushes and took about 53 ms even with no-op dependencies. Real SQLite writes and status broadcasts amplify this substantially. The title limit is applied only after allocating every extracted title.  
   **Fix:** Bound during parsing, process observation off the PTY message handler in bounded slices, and batch/coalesce ledger updates and UI pushes.

8. **LOW — The E2E home override is runtime-accessible in packaged builds.** [claude-usage.ts:36](/C:/Projects/morz-seam/src/main/orchestrator/claude-usage.ts:36)  
   `MORZ_E2E=1` is sufficient to redirect production metering; nothing checks whether the app is packaged.  
   **Fix:** Inject the transcript root into the test-created bridge, or additionally require a non-packaged build.

The core invariants otherwise hold: the current chunk is relayed before observation, the bridge has no PTY-write path, and no bridge transition creates/completes a run or maps titles to `done`.

Verification: typecheck and production build passed; all 32 added unit tests passed. The findings above were reproduced with focused adversarial probes.