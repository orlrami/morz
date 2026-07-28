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

- **Hand-rolled parser, never a regex** (`src/shared/osc-title.ts`). PTY chunks can embed megabyte pastes; a global regex over every chunk is a performance and correctness trap. Terminated by BEL or ST, whichever comes first.
- **1024-char head+tail truncation**, not a prefix clip — the trailing status word *is* the signal.
- **Cross-chunk carry**, because a title routinely splits across two `onData` chunks, with a bounded pending buffer so a malformed sequence cannot grow memory without limit.
- **All titles per chunk, in byte order** — a `working → idle` pair coalesced inside one chunk is invisible if you only read the chunk's last title.
- **A keyword boundary guard that also excludes path separators**: `(?<![\w./\\-])(ready|idle|done)(?![\w-])`. Plain `\b` matches inside cwd paths like `~/codex/ready`. This single line is the difference between a working classifier and a useless one.
- **Bail to `null` when no known agent token appears** — this is what stops ordinary shell titles from being classified as agent state.
- **Animation frames normalized before storage**, or the UI strobes several times per second.
- **Edge-triggered, no timers.** A `null` classification never overwrites the last known state, and reverting to `null` counts as an exit only from idle/waiting — while working it is usually a transient internal title.

Classifier output is three states: `working`, `waiting` (Orca calls it `permission`), `idle`.

**Deliberately not built here:** any transition to `done`. Orca's own source documents why (`orca-runtime.ts` ~8471): fast tasks jump `null → idle` skipping `working` entirely, so a `working → idle` waiter hangs forever; and `waiting → idle` means the user *denied* an approval, which is not completion. `idle` means "the CLI is at its prompt", nothing more. Auto-advancing a run to `done` is 0.0.7 and needs a definition-of-done signal, not a title.

### Channel B — transcript scan → real metering

Each dispatched agent gets its own git worktree, so `~/.claude/projects/<slug(worktree)>/*.jsonl` belongs to exactly one agent of one run — attribution needs no session id. The scan sums `message.usage` token counts per assistant record (the same shape `adapters/claude.ts:151` already reads for lanes) and feeds `costMeter.track(runId, agentId, …)`, which has been the documented dispatch integration seam since wave 5 and was never called with a `runId`. `getRunStatus().usage` then reports the meter's real per-run totals instead of the hardcoded nulls.

Scanning is triggered by a Channel A transition **to** idle or waiting — a turn just ended — plus once at agent exit. No polling loop.

**Honest limit:** transcripts carry tokens, not dollars, and Morz ships no price table. Dispatched runs report real `tokens` and leave `usd: null`. Lane runs are unaffected — they still get `costUsd` straight from claude's `result` event.

### What each CLI actually gets

| CLI | State | Metering |
|---|---|---|
| `claude` | working / waiting / idle from titles (`✳` U+2733 prefix, braille U+2800–28FF spinner, `". "` / `"* "` conventions) | real tokens from the transcript scan |
| `codex` | spawn / exit / duration always; title states only when it paints a recognizable title | none — nothing structured to read |
| `agy` | spawn / exit / duration; Gemini glyphs `✦` `⏲` `◇` `✋` when present | none |
| `opencode` | spawn / exit / duration | none |

The table is a claim about what the classifier *can* resolve, not a promise that every CLI paints titles. When a CLI's title does not classify, the bridge emits nothing and the run card shows no activity chip — the honest empty state, never a guess. The e2e spec asserts exactly this asymmetry.

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

| Title activity | Lifecycle state | Direction |
|---|---|---|
| `waiting` | `blocked` | running → blocked |
| `working` | `running` | blocked → running |
| `idle` | *unchanged* | — |

`idle` moves no lifecycle state — see above. Every transition is wrapped: an agent that has reached a terminal state (cancelled by Stop, failed by the liveness watcher) rejects the update and the bridge drops it silently. The bridge never creates, deletes, or terminates a run.

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
| `src/shared/osc-title.ts` | OSC 0/1/2 extractor + cross-chunk tail (pure, unit-tested) |
| `src/shared/agent-title-status.ts` | title → activity classifier + edge-triggered tracker (pure, unit-tested) |
| `src/main/orchestrator/pane-bridge.ts` | pane registry, chunk observation, run-store + meter wiring |
| `src/main/orchestrator/claude-usage.ts` | worktree-attributed transcript token scan |
| `src/main/orchestrator/run-store.ts` | `activity` column, usage provider hook |
| `src/main/orchestrator/dispatcher.ts` | register/unregister panes at launch and teardown |
| `src/main/index.ts` | the one-line observation tap |
| `src/renderer/src/components/RunsPanel.tsx` | activity chip + usage row |

## Reversibility

Deleting `paneBridge.observe(...)` from `main/index.ts` returns the app to exactly today's behavior: panes still spawn, render, and get killed identically; run cards lose the activity chip and go back to reporting null usage. Nothing else depends on the bridge.

---

*Channel A is a port of the state-detection approach in [Orca](https://onorca.dev) (MIT). The mechanics — parser shape, truncation strategy, glyph table, boundary regex, edge-trigger rules, and the traps documented above — are recorded in `docs/research/ORCA-COMPETITOR-RESEARCH.md` §P2.1. Source files carry the attribution.*
