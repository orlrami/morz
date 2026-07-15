# Morz — In-Progress Tracker

*Live status of what's being built. Update as slices land. Roadmap: [`../roadmap/`](../roadmap/).*

## Current target: **0.0.3 — "Orchestrated"** ([spec](../roadmap/0.0.3.md))

Wave 5 (8 agents: 3 Fable + 5 GPT-5.6 Sol) merged. **E2E: 40 passed + 6 live-gated (verified per-branch); planner→dispatch proven live end-to-end.**

| 0.0.3 deliverable | Status | Notes |
|---|---|---|
| Interactive Claude (bugfix) | ✅ live-verified | real `claude` TUI in a lane (Interactive/Structured toggle) — text + all slash commands (/config,/model,/mcp) work; headless stream-json can't run them (root-caused). Fixes both user-reported bugs. |
| Planner (NL→SpawnPlan) | ✅ | live claude → schema-validated plan card → per-plan hash approval → edits re-hash; amendment flow. Orchestrated dial ENABLED (still approval-gated). |
| Dispatcher | ✅ verified | approved plan → worktree+$PORT+visible pane per agent; SQLite run-state machine; global Stop kills the tree (no zombies); cleanup removes run worktrees. MORZ_SPACE routes bus mailbox to the space root. |
| Adapters (claude/codex/agy) | ✅ live-verified | one AgentAdapter interface; codex `exec --json` (stdin-ignored); agy PTY bracketed-paste; Claude refactored, zero regressions. Smoke: codex+agy ADAPTER_OK live. |
| Cross-model reviewer | ✅ live-verified | non-author brain refutes each diff; finding cards (apply-fix → IDE, send-to-agent → bus handoff). Planted-bug found live. |
| DAG waves + DoD | ✅ | machine-verified completion gate (completeVerified runs dod commands; self-report never completes); DagView renders live wave/state graph. |
| Commit UX | ✅ | real git staging (file+hunk), discard-confirm, commit w/ hooks, AI message from staged diff (Assisted+). |
| Cost/token kill-switch | ✅ | per-run+per-lane meters in StatusBar; caps → pause-on-breach banner (Resume+25% / Stop); "no data" first-class. |

**Integration wiring of note:** planner's LoggingDispatchStub → REAL dispatcher (approve registers in the dispatcher store AND dispatches — the two approval stores can't drift); single `window.morz` expose (a duplicate expose was aborting the rest of preload → dropped morzCommit/morzCost + dag.completeVerified); planner/dispatch hash canonicalizers confirmed identical.

**0.0.3 remaining:** bring-your-own-assistant + Daily Pulse → done in wave 6.

### Wave 6 (5 GPT-5.6 agents) — merged, E2E 55 passed + 6 live-gated
| Deliverable | Status | Notes |
|---|---|---|
| Sync reliability + Notification Center | ✅ | registry/GitHub/benchmarks sync fixed: OpenRouter benchmarks 401 → "needs-key" (optional OPENROUTER_API_KEY), GitHub 403 → rate-limited warning not error, offline = one warning not per-page spam. New in-app Notification Center (bell + unread in StatusBar, SQLite-persisted, per-source status, retry actions) via src/shared/notify.ts — nothing fails silently to console. |
| Bring-your-own-assistant | ✅ | Hermes/OpenClaw/Comet providers → propose SpawnPlan → enters the SAME per-plan hash approval (never auto-dispatches); Manual-inert. |
| Daily Pulse | ✅ | scheduled brief (git+board+inbox → headless claude); Run-now live; surfaces via Notification Center + tray; gated (enabled + non-Manual). |
| Organizer GUI | ✅ | Organizer view in the switcher: audit → violations → propose (hash+tree) → apply in sandbox worktree; closes the 0.0.2 backend's missing UI. |
| Runs monitor | ✅ | live dispatched-team view in OrchestratorPanel: per-agent state, Stop (kill tree) + Cleanup (remove worktrees) from the UI. |

**Integration notes:** SettingsPanel hosts assistant+pulse mounts; single `window.morz` expose invariant held (notify attached before it); deduped NotifyItem import.

### Wave 7 — merged (brand adoption + error audit). E2E 62.
Brand tokens/fonts (Hanken Grotesk + Quicksand)/Signal logo/real icons adopted; registry pagination false-failure root-caused + fixed; global error handlers + boundary; ERROR-AUDIT.md.

## Current target: **0.0.4 — "Learns You"** ([spec](../roadmap/0.0.4.md))

### Wave 8 (5 agents: 4 Sol + 1 Fable) — merged. **E2E 84 passed + 6 live-gated.**
| Deliverable | Status | Notes |
|---|---|---|
| Learning-memory store | ✅ | markdown-per-entry (%APPDATA%\Morz\memory), scopes global/project/space/agent, FTS5 index, approval-gated proposals, MemorySettings UI |
| Correction learning + injection | ✅ | deterministic correction detector (fingerprinted repeats → staged proposal w/ evidence), notify chip, approved memory prepended to every lane's first prompt + every dispatched promptSeed. Integration wired learner→real store (stub swap) |
| Routing | ✅ | rules table (math→agy, review→codex, private→local), consult() MCP tool (untrusted-labeled), Ollama/LM Studio detect, RoutingSettings + plan suggestion chips |
| Voice | ✅ | optional push-to-talk via user's local whisper exe; hidden when unconfigured |
| **Browser + element-pick** | ❌ NOT DELIVERED | agent produced zero commits (2nd no-show, same as w4 organizer) — re-run in wave 9 |

**NEXT — wave 9 (final before daily-drive):** browser+element-pick re-run; installer produce+install with brand icons; auto-update enable; dogfood pass.

## Previous target: **0.0.2 — "The Bus + Additions"** ([spec](../roadmap/0.0.2.md)) — COMPLETE

Wave 4 (8 agents: 4 Fable-5 + 4 GPT-5.6 Sol) merged. **E2E: 29 passed + 3 live handoff tests passed (real claude). Full suite green.**

| 0.0.2 deliverable | Status | Notes |
|---|---|---|
| Bus v0 (board+mailbox+sweeper) | ✅ verified | SQLite CAS claim (one winner), lease reclaim, Maildir tmp→fsync→rename, identity stamped by Main; 4 e2e tests |
| Named pipe + morz-mcp shim | ✅ verified | 5 tools over token-handshake pipe; squatter defeated; single-file CJS shim; smoke green. Integration wired SqliteBoardPort (real board) into the pipe tools |
| Auto-handoff + chips + blackboard | ✅ live-verified | chip-gated dispatch → Maildir → pointer prompt lands in a REAL claude lane → task working (CAS). Integration swapped StubBus → real board/mailbox |
| Workshop marketplace | ✅ | real MCP Registry ingest + GitHub stars + OpenRouter models; offline-graceful; Add wired to config writer (feature-detected) |
| Config writer | ✅ verified | diff-first propose/apply for .mcp.json / config.toml / opencode.json; backups, atomic, mtime-guard; 5 fixture tests |
| Obsidian (optional) | ✅ | Local REST API connect (key in safeStorage), read/search, MADR ADR write w/ no-clobber; fixture-server e2e |
| **Organizer MCP** | ❌ NOT DELIVERED | Agent 4 (Fable) produced zero commits — re-run in wave 5 |
| 0.0.1 exit (w4/finish) | ✅ | NSIS installer built+installed+verified+uninstalled (BUILD.md documents flow); TUI registry + alt-screen signal; block gutter polish; blocks e2e (4 tests) |

**Integration notes:** unified ONE `window.morz.bus` (board API + blackboard UI API); `SqliteBoardPort` bridges MCP tools onto the real board; handoff rewired from stub to board+Maildir; workshop spec updated for live config writer.

## Previous target: **0.0.1 — "The Terminal"** ([spec](../roadmap/0.0.1.md)) — COMPLETE

Waves 1+2+3 (4 then 6 then 6 parallel Fable-5 agents) merged to `main` + integrated. **E2E suite: 13/13 passed.**

| Slice | Status | Notes |
|-------|--------|-------|
| 1 — PTY-host + real terminals | ✅ verified | pwsh/cmd/WSL; PATH gate asserted; micro-UX (copy-on-select, zoom, context menu, split/close). OSC-133 blocks end-to-end (consent-gated `-EncodedCommand` pwsh hook + WSL init-file, nonce anti-spoof, `MORZ_NO_SHELL_HOOK=1` kill-switch); TUI alt-screen signal. Torture: 20-pane storm, 50-resize storm PASS. |
| 2 — Session restore + PTY survival | ✅ verified | window-close reattach + scrollback replay PASS; hard-kill → SQLite layout restore PASS. |
| 3 — Ctrl-click → IDE pane | ✅ verified | ide.spec PASSES (root cause was dual-mounted IdePane + first-open race — fixed). Tabs, save/conflict, silent reload, open-in-VSCode. |
| 4 — Spaces + git | ✅ verified | live branch/dirty; real file explorer. |
| 5 — Claude Code adapter | ✅ live-tested | stream-json needs `-p` (verified claude 2.1.187); meters (result msgs + ~/.claude JSONL fallback, "no data" state); `--resume`; dead-lane restart; interrupt. |
| 6 — Mode gating | ✅ gated | manual-gate.spec (4 tests): boots Manual, zero claude processes in app tree during terminal use, no Claude affordance in DOM, dial round-trip strips lanes. docs/protocol.md frozen (Task→Message→Part→Artifact). |
| + Layout | ✅ | recursive split tree (right/down, nested), drag dividers, focus ring, legacy snapshot hydration. |
| + Resilience | ✅ | PTY-host watchdog respawn (bounded), dead-pane broadcast, orphan sweep; host hard-kill E2E PASS (no white screen). |

**Integration fix of note:** E2E isolation was fake — Electron ignores the APPDATA env var (Windows shell API). Added `MORZ_USER_DATA` main-process hook; e2e now truly isolated (verified: db+localStorage land in tmp dirs).

**0.0.1 remaining before exit:** daily-drive validation by owner; installer produced+installed once (`npm run build:win`); Framed-TUI known-process registry (only alt-screen signal in); block gutter UI polish. Then 0.0.2.

Legend: ✅ done · ⏳ in progress · ⬜ pending · 🚧 blocked

## Done so far (Phase 0)
- ✅ Electron + React + Tailwind4 + Framer Motion scaffold, Slate theme, all mock UI surfaces (terminals, sidebar, orchestrator, commit, reviewer, DAG, browser, remote, settings, workshop). Runs via `npm run dev`.
- ✅ Repo on GitHub (`orlrami/morz`, private). Docs reorganized under `docs/`.

## Decisions of record
See [`../../` memory: morz-decisions-locked] and [`../roadmap/README.md`](../roadmap/README.md). Key: name = **Morz**; auth = automate launching the user's own CLIs; per-plan approval; PTY survival in 0.0.1; unsigned for now; local-only telemetry; remote app parked.

## Open confirmations
- 0.0.3 cost-cap UX — revisit when reached.
- Voice exact approach — revisit at 0.0.4.
