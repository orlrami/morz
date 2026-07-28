# Adapter seam for dispatched panes — design

*Wave 17, agent E (`w17/adapter-seam`). 0.0.7 pre-work, item 2 of [`../ORCH-AUDIT.md`](../ORCH-AUDIT.md): "raw pane dispatch bypasses normalized permission/state contracts". The integrator reads this at merge time.*

## The problem, restated

`dispatcher.ts` launches each planned agent as a **real PTY pane** and types the CLI launch command into it, exactly like the owner would by hand. That is the whole product thesis (visible terminals, never hidden subagents), and it is why the orchestrator is blind: everything Morz knows about a dispatched agent comes from `listPanes()` liveness polling. A pane sitting at Codex's "Do you trust this directory?" prompt and a pane mid-refactor are indistinguishable — both report `running` forever — and `getRunStatus()` hardcodes `usage: { usd: null, tokens: null }` (`run-store.ts:326`).

## The constraint that decides the design

**The claude adapter cannot carry dispatched panes.** `claudeAdapter` drives `claude -p --input-format stream-json --output-format stream-json` as a hidden child process. Stream-json only works in print mode — verified in-repo against claude 2.1.187 (`adapters/claude.ts:133-144`), and print mode has no TUI. Routing a dispatched pane through that path would replace the visible interactive terminal with a headless subprocess whose output Morz re-renders. That is precisely the output interception the brief forbids and the fidelity the torture spec protects.

So the launch pack's item 3 — "dispatched Claude runs go through the claude adapter's structured-event path" — **is not implementable without destroying pane fidelity, and this slice does not do it.** The same normalized value (states + metering) is delivered through two channels that observe rather than proxy. This is the one deliberate deviation from the pack; everything else lands as written.

## Chosen shape: a passive observation bridge, not a proxy

```
pty-host (utilityProcess)
  └─ onData ──▶ parentPort ──▶ main/index.ts  case 'pty':
                                  ├─▶ webContents.send(PtyApi.data, relayed)   ← UNCHANGED, first, byte-identical
                                  └─▶ paneBridge.observe(paneId, data)         ← new, after, read-only
```

The tap sits at `main/index.ts:168`, on the message main **already** relays, **after** the renderer send — the same position and shape as the existing `smokeDataTap`. The bridge takes a `string`, returns `void`, and has no path back into the PTY. It cannot rewrite, delay, or swallow a byte, so `torture.spec.ts` is structurally unable to regress. Nothing is intercepted: OSC sequences continue to reach xterm, which handles titles itself.

Two channels feed it, both zero-install:

### Channel A — OSC terminal titles → agent state

Agent CLIs announce their own state in the terminal title (`ESC ] 0|1|2 ; <title> BEL`). This is a structured terminal protocol signal, not TUI text scraping: we never regex the screen. Ported from Orca (`onorca.dev`, MIT — attributed in the source headers), whose implementation encodes traps we would otherwise hit blind:

- **Hand-rolled parser, never a regex** (`src/shared/osc-title.ts`). PTY chunks can embed megabyte pastes; a global regex over every chunk is a performance and correctness trap.
- **Termination follows xterm exactly**, because xterm renders the same bytes and any divergence means Morz classifies text the user never saw as a title. An OSC string ends at BEL, at C1 ST, at `ESC \`, or at **any other ESC** — the escape both ends this string and begins the next sequence, so it is consumed by neither and scanning resumes *on* it. CAN and SUB abort, discarding the title. Both `ESC ]` and C1 introducers are accepted. Accepting only BEL and `ESC \` let `OSC 2;Claude idle ESC X permission BEL` read as a *waiting* agent; consuming that terminating ESC then swallowed the whole next sequence, so `ESC]2;first ESC]2;second BEL` yielded only `first` — a CLI that chains title writes without BEL would have lost every transition but the first.
- **1024-char head+tail truncation**, not a prefix clip — the trailing status word *is* the signal. The bound is applied while slicing out of the chunk, so an enormous title is never materialized in full first.
- **Cross-chunk carry**, because a title routinely splits across two `onData` chunks, with a bounded pending buffer so a malformed sequence cannot grow memory without limit. An ESC at the chunk edge is carried rather than guessed: it may be ST or a new sequence, and the two end the title in different places.
- **All titles per chunk, in byte order**, capped by a fixed-capacity ring — a `working → idle` pair coalesced inside one chunk is invisible if you only read the chunk's last title.
- **A keyword boundary guard that also excludes path separators**: `(?<![\w./\\-])(ready|idle|done)(?![\w-])`. Plain `\b` matches inside cwd paths like `~/codex/ready`. This single line is the difference between a working classifier and a useless one. The same guard matches agent *names*, so `claude-tools` is not an agent.
- **Animation frames normalized before storage**, or the UI strobes several times per second.
- **Edge-triggered, no timers.** A `null` classification never overwrites the last known state — while working, transient internal titles are common.

Classifier output is three states: `working`, `waiting` (Orca calls it `permission`), `idle`.

**The classifier fails closed, which is stricter than Orca.** Anything a pane's child process writes reaches it, and an activity moves an agent's lifecycle state, so a title must prove it belongs to an agent before it is read as one:

1. **Ownership first.** Either the caller names the CLI the pane was launched with — the dispatcher always knows — or the title carries a boundary-matched product name. Without ownership the answer is `null`, whatever the title says.
2. **Glyphs are anchored** to the canonical leading position and scoped to the CLI that uses them. `✋ build paused` in an unowned pane is not waiting; `Claude Code ✳` is not idle.
3. **Keyword rules additionally require a named agent**, because `permission`, `ready` and `working` are ordinary English that anything may print.
4. **No fallback.** A title matching nothing returns `null` rather than defaulting to a state.

Orca can afford looser heuristics because their authoritative channel is agent hooks and titles are only a fallback. Here, titles *are* the channel, so an unowned title has to mean nothing at all.

**Deliberately not built here:** any transition to `done`. Orca's own source documents why (`orca-runtime.ts` ~8471): fast tasks jump `null → idle` skipping `working` entirely, so a `working → idle` waiter hangs forever; and `waiting → idle` means the user *denied* an approval, which is not completion. `idle` means "the CLI is at its prompt", nothing more. Auto-advancing a run to `done` is 0.0.7 and needs a definition-of-done signal, not a title.

### Channel B — transcript reads → real metering

Claude Code writes a per-project JSONL transcript, and this reads it. Two properties do the work:

**Attribution is per record, never per directory.** The transcript directory name is a lossy slug: `C:\Projects\foo-bar` and `C:\Projects\foo\bar` both become `C--Projects-foo-bar`, so two different worktrees can share one directory. The directory only narrows the search; ownership is decided by canonically matching each record's own `cwd` against the agent's worktree (`realpath`, case-folded on Windows). A record that cannot prove ownership is skipped rather than guessed, and records stamped before the run began belong to an earlier run.

**Accounting is incremental and deduplicated by message id.** Claude Code's session fork copies history into the new session file — the Orca research (§P2.6b) records that naive counting double-counts across forks — so a reader returns only records it has never seen, as a **delta**. Nothing ever re-reports a running total, which also removes the failure mode where a transcript reading lower than last time (rotation, truncation) gets added a second time. A read is therefore idempotent, which is what makes the extra teardown pass free.

Token keys match the preload lane meter (`src/preload/index.ts:381-386`): input, output, **and both cache fields**. The deltas feed `costMeter.track(runId, agentId, …)`, the documented dispatch integration seam since wave 5 that had never been called with a `runId`, and `getRunStatus().usage` reports the meter's real per-run totals instead of the hardcoded nulls.

Reads are triggered by a Channel A transition **to** idle or waiting — a turn just ended — plus once during teardown. No polling loop. They are serialized per agent: a request arriving mid-read queues a rescan rather than being dropped, so the last turn of a burst is never the one that is lost.

**Honest limit:** transcripts carry tokens, not dollars, and Morz ships no price table. Dispatched runs report real `tokens` and leave `usd: null`. Lane runs are unaffected — they still get `costUsd` straight from claude's `result` event.

### What each CLI actually gets

| CLI | State | Metering |
|---|---|---|
| `claude` | working / waiting / idle: leading `✳` U+2733, leading braille U+2800–28FF spinner, `". "` / `"* "` conventions, plus named-agent keywords | real tokens from the transcript |
| `codex` | spawn / exit / duration always; leading braille spinner; named-agent keywords. No verified glyph vocabulary, so none is invented | none — nothing structured to read |
| `agy` | spawn / exit / duration; leading Gemini glyphs `✦` `⏲` `◇` `✋`; braille spinner | none |
| `opencode` | spawn / exit / duration; leading braille spinner | none |

The table is a claim about what the classifier *can* resolve, not a promise that every CLI paints titles. A title that proves nothing classifies as nothing, and the run card shows no activity chip — the honest empty state, asserted in the e2e against a deliberately title-silent agent.

Two precise limits worth knowing before trusting the chip:

- **The spinner is treated as universal, but only inside a pane an agent owns.** A dispatched pane's own child process (an `npm install` with a braille spinner in its title, say) can therefore read as `working`. The blast radius is bounded by design: the only lifecycle states a title can reach are `running` and `blocked`, both non-terminal and reversible, and no title can ever reach `done`.
- **On Windows the glyph channel depends on the CLI declaring UTF-8.** A CLI writing its spinner under the default OEM code page emits `?` instead of the braille frame, and that title then classifies as nothing rather than as working. The real node-based CLIs set UTF-8 themselves; the e2e fixture has to do it explicitly, and it is the first thing to check if a CLI's activity never appears.

## Event contract

Additive to the existing normalized union in `shared/ipc.ts` — no rename, no removal:

```ts
export type AgentActivity = 'working' | 'waiting' | 'idle'

// added to AdapterEvent
| { type: 'state'; activity: AgentActivity; source: 'title'; title?: string }
```

`waiting` is the state the audit said Morz could not see. It is fed by the title classifier's permission state and, later, by real adapter permission events — same event, better source.

Bridge-internal events (`src/main/orchestrator/pane-bridge.ts`) carry run identity:

```ts
type PaneBridgeEvent =
  | { type: 'spawn';  runId; agentId; cli; paneId; at }
  | { type: 'state';  runId; agentId; activity; title; at }
  | { type: 'usage';  runId; agentId; inputTokens; outputTokens; at }
  | { type: 'exit';   runId; agentId; code; durationMs; at }
```

They land in the run store and ride the **existing** `run:changed` push. No new IPC channel, no new renderer subscription: `AgentRunDetail` gains an optional `activity` field, `RunStatus.usage` starts telling the truth, and the run card renders both.

## Lifecycle mapping (conservative on purpose)

`AGENT_TRANSITIONS` (`run-store.ts:115`) already has `running ⇄ blocked`, both non-terminal and reversible. That is the honest home for `waiting`:

| Title activity | Lifecycle state | Condition |
|---|---|---|
| `waiting` | `blocked` | always |
| `working` | `running` | always |
| `idle` | `running` | **only** when this bridge applied the `blocked` |
| `idle` | *unchanged* | otherwise |

`idle` still never means done. But it does end a wait: when the bridge blocked the agent and the CLI returns to its prompt — including when the owner **denied** the approval — leaving the ledger `blocked` forever is simply wrong, and that is exactly what the first cut did. Only a block this bridge applied is cleared, so a block from anywhere else is left alone.

Every decision reads the ledger's **current** state rather than a cached value, because Stop and the liveness watcher can invalidate the cache underneath an in-flight observation. Transitions are wrapped: an agent that has reached a terminal state rejects the update and the bridge drops it silently. The bridge never creates, deletes, or terminates a run.

Ledger writes are coalesced to **one per chunk**. Every title is still classified and every transition still emits a `state` event, but only where the chunk *landed* is written to SQLite and broadcast — a chunk carrying thousands of alternating titles would otherwise put thousands of synchronous writes in front of the PTY relay. Intermediate states inside a single chunk are sub-frame.

## Teardown ordering

Stop kills the panes, but the last turn's tokens are still only on disk, and nothing has read them. So `teardownAgents` kills every agent, then **awaits** `paneBridge.finalizeRun(runId)` — which drains any in-flight read and takes one guaranteed final reading — and only then removes the worktrees. Getting this backwards (detaching before the kill, as the first cut did) meant a run stopped while an agent was still `working` reported zero usage. The e2e asserts the exact figure after Stop, so a regression shows up as a wrong number rather than a missing feature.

**That await is bounded.** A filesystem read cannot be cancelled, so a stalled or locked transcript would otherwise hang Stop indefinitely — an unbounded wait on an uncancellable operation is a deadlock, not a safeguard. `finalizeRun` races the read against a 5s deadline (`DEFAULT_FINALIZE_TIMEOUT_MS`, injectable for tests). On expiry the pane is released and teardown proceeds immediately; the abandoned read still resolves eventually, sees `released`, and records nothing.

A skipped read is reported, never silently treated as final. The run is flagged, `RunStatus.usage.partial` goes true, a `metering-gap` event is emitted, and a warning naming the agent and the wait is logged. The run card then renders the figure as `2,600+` beside an "at least" marker, so the owner sees a floor rather than a number that quietly under-reports.

## Publishing changes to the UI

The renderer learns about runs from exactly one place: the `run:changed` push (`runsStore.ts:223`, plus a single hydrate when the panel subscribes). So **any observable change must push**, not only the ones that write a ledger row. Pushing on ledger writes alone left the activity chip frozen for whole runs, because the most common transition — `working → idle` — moves no row at all: the agent was already `running` and stays `running`.

`observe()` therefore pushes once per chunk when the ledger changed **or** the observed activity changed, and `finalize` pushes when it clears a dead pane's activity. It is still at most one push per chunk. The e2e proves this specifically: it mounts the run card *before* the agent writes its first title, so the store's one hydrate-on-subscribe cannot be what fills the chip in, then asserts the chip appears on a `working` transition that provably moves no ledger row. Reverting the fix makes that assertion fail — verified, not assumed.

One accepted consequence of coalescing: a `waiting → idle` pair landing inside a single chunk shows the owner only the `idle` it settled on. The `state` events still record both, so an event log (0.0.7) can surface the transient wait; the chip reflects where things actually are.

## What stays PTY-only, permanently

- **stdin.** The bridge never writes to a pane. Approvals stay in the visible TUI where the owner answers them; Morz reports that an approval is pending, and that is the whole feature. No auto-approve, no `--dangerously-skip-permissions` (Orca ships that as its *default*; Morz will not).
- **Rendering.** The renderer receives the identical byte stream it received before this slice.
- **Scrollback, resize, flow control, kill.** Untouched.
- **Codex/agy permission gates.** Neither CLI exposes a structured signal Morz can read without installing something into the user's config. Guessing from screen text is explicitly out of scope.

## Deferred, with the reason

- **Claude hooks channel** (`~/.claude/settings.json` → local HTTP server). This is the accurate channel — authoritative `working`/`blocked`/`waiting`/`done`, plus `AskUserQuestion` payloads. It is deferred because it writes to a file the user owns, outside any Morz space, which under the graduated-autonomy law is an approval-gated install with its own consent surface and uninstall path. Titles cost nothing and cover every CLI; hooks are the 0.0.7 fidelity upgrade and compose with this design rather than replacing it (the `state` event just gains `source: 'hook'`).
- **statusLine rate-limit piggyback.** Same install gate, and only Claude has it.
- **Auto-`done` advancement and waking dispatched agents via the bus.** Audit items 1 and 3, explicitly 0.0.7.

## Files

| Path | Role |
|---|---|
| `src/shared/osc-title.ts` | OSC extractor, xterm termination, cross-chunk carry (pure) |
| `src/shared/agent-title-status.ts` | ownership-first activity classifier + edge-triggered tracker (pure) |
| `src/main/orchestrator/pane-bridge.ts` | pane registry, chunk observation, run-store + meter wiring |
| `src/main/orchestrator/claude-usage.ts` | per-record attributed, deduplicated transcript reader |
| `src/main/orchestrator/run-store.ts` | activity/usage provider hooks, `getAgentState` |
| `src/main/orchestrator/dispatcher.ts` | pane registration, transcript root, teardown ordering |
| `src/main/index.ts` | the one-line observation tap |
| `src/renderer/src/components/RunsPanel.tsx` | activity chip + usage row |
| `e2e/dispatch-seam.spec.ts` | real dispatch, real ConPTY, real OSC titles |

Unit tests live in `src/main/orchestrator/title-seam.test.ts` (parser + classifier), `pane-bridge.test.ts` (event mapper, lifecycle, scan serialization, teardown) and `claude-usage.test.ts` (attribution, dedupe, delta accounting) — under `src/main` by repo convention, because `src/shared` is compiled by the web tsconfig, which has no node types.

The transcript root is **injected** by the dispatcher, so `claude-usage.ts` reads no environment at all. The e2e override requires both `MORZ_E2E=1` and an unpackaged build, so a shipped Morz cannot be pointed at another transcript root at runtime.

## Reversibility

Deleting `paneBridge.observe(...)` from `main/index.ts` returns the app to exactly today's behavior: panes still spawn, render, and get killed identically; run cards lose the activity chip and go back to reporting null usage. Nothing else depends on the bridge.

---

*Channel A is a port of the state-detection approach in [Orca](https://onorca.dev) (MIT). The mechanics — parser shape, truncation strategy, glyph table, boundary regex, edge-trigger rules, and the traps documented above — are recorded in `docs/research/ORCA-COMPETITOR-RESEARCH.md` §P2.1. Source files carry the attribution.*
