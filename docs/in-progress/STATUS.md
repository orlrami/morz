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

### Wave 9 (4 Sol agents) — merged. **E2E 92 passed + 6 live-gated. 0.0.4 COMPLETE.**
| Deliverable | Status | Notes |
|---|---|---|
| Browser + element-pick | ✅ | WebContentsView + CDP pick → full ElementContext (selector/a11y/styles/screenshot/sourceLoc); send to critique/builder; view never bleeds over other panels |
| Real spaces | ✅ | open ANY folder as a space (native picker); active root wired through terminals/explorer/git/commit/organizer; stale Phase-0 seed gone; missing roots marked unavailable |
| Installer + updater | ✅ | branded 0.0.4 NSIS installer PROVEN installed+launched+uninstalled; electron-updater silent-off (private repo) w/ token/stub-feed support; release flow in BUILD.md |
| Polish | ✅ | command palette drives the app for real (views/panes/lanes/settings/themes/sync); mock purge — real data or honest empty state everywhere; pill bar = live lanes + dispatched agents |

**Integration:** Shell palette kept polish's action system with spaces' one-lane-per-SPACE gate; AgentPillBar took polish's real-data version.

**STATE: 0.0.1→0.0.4 ALL SHIPPED.**

### Wave 10 (dogfood round 1, 3 Sol agents) — merged. E2E 97 passed + 6 live-gated.
From owner's first look at the running app:
- **Space tabs**: titlebar mock tabs (morz-core/api-service) → real space tabs (switch/add/close), driven by spaceStore.
- **Sidebar**: live per-space state (branch/dirty/lanes/dispatched agents) + honest empty states; **mock.ts DELETED** (zero importers left).
- **Identity**: dev-launch brand taskbar icon; orchestrator toggle + panel header now carry the Morz Signal glyph; default Electron menu removed (Ctrl+K/B still app-level).

**Installed & running as a real app:** `npm run build:win` → signed NSIS `release/morz-0.0.4-setup.exe` → installed to %LOCALAPPDATA%\Programs\Morz with Start-Menu + Desktop `Morz.lnk`. Owner now launches without a command.

**MODE CHANGE: owner is dogfooding — coding Morz *with* Morz, and will NOT report every bug.** Waves become owner-driven from real usage, not roadmap-driven. Integration cadence: after each wave I rebuild+reinstall the signed exe so what the owner sees is always the packaged product. Parked: remote app, code signing cert, SaaS.

### Waves 11–13 (dogfood cycle, capsule)
- **w11** (9 agents): CLI connections detection + real Limits, AI report engine (BYO OpenAI/Gemini/OpenRouter, default claude), commit-AI summaries, demo-able reviewer, curated MCP catalog, settings scroll+theme-preview, IDE send-to-agent, per-project sessions, live pill-bar model detection.
- **w12** (7 agents): orchestrator unblocked (plan immutability loop), multiline goal composer, selectable planner engine + Codex fallback, honest post-commit refresh, dictation/injected-keys land in fields, session pin+resume, live orch audit (found: dispatched agents never execute).
- **w13** (9 agents, from the Fable-5 desktop QA review): **dispatched agents now execute in VISIBLE renderer panes** (attach handshake fixed the flow-control stall — the engine turns over), planner repairs real specs instead of rejecting (200-char rule), immutable-fields normalize (dependsOn), paste-once, syncpack packaged, curated-first workshop ranking + spam denylist, pin/resume on every session row, Assisted dial reachable (hover moved the hit target), pristine panes follow the active space. E2E ~140 passing.
## Current: **0.1.5 — "Polish & Fix"** SHIPPED (wave 16) — E2E 199 passed + 13 live-gated

### Wave 16 (4 agents: 2 Fable + 2 Sol) — merged, reviewed, integrated. Installer `morz-0.1.5-setup.exe`.
From owner dogfood round 1 ([scope](WAVE16.md)): drawer portaled (was clipped to the rail), context-hub scan fixed (picker-only root authority removed — structural validation like fs:list), draggable setup/launcher (drag strips), dark native dropdowns (color-scheme), CLI version re-probe + Refresh + "Update now" button (visible pane, consent-gated restart-sessions w/ --resume), Spotlight palette (centered modal + titlebar icon; persistent bar gone), motion pass (springs-only, reduced-motion honored), Voice module deleted (Wispr Flow compat kept via voice-input.spec), planner engine = detected-CLI roster + OpenCode engine, memory bootstrap ("Build memory from my files" — op-set gated bulk import). Integration fixes: drawer = A's portal + C's animation; shared root validator keeps the friendly error contract; updater args quoted; palette focus restore.
Known flaky under full-suite load only: model-choice dispatched --model (passes isolated every run).

## Previous: **0.0.5 — "Your Morz"** ([spec](../roadmap/0.0.5.md)) — COMPLETE

### Wave 15 (12 agents: 4 Fable + 5 Sol + 1 GPT-5.5 + 1 Gemini 3.1 Pro + 1 Sonnet) — merged. **E2E 189 passed + 13 live-gated.**
Scope: [`WAVE15.md`](WAVE15.md) · agent pack: [`WAVE15-AGENTS.md`](WAVE15-AGENTS.md) · designs: claude-design project "Morz — Modular Shell & First-Run Onboarding".

| Deliverable | Status | Notes |
|---|---|---|
| Module registry + gated shell | ✅ | `src/shared/modules.ts` is THE contract; disabled module = no rail icon, no mount, no sync/notification IPC (asserted by an E2E IPC tap). Drawer + palette toggles + Orchestrated interlock |
| Premium shell | ✅ | titlebar = brand + space tabs only; 56px icon rail replaces the tab strip; Explorer panel on the RIGHT; orchestrator dock is dial-owned (Manual = nothing anywhere); statusbar = context / centred dial / meters + bell; AgentPillBar deleted |
| IDE slide-over | ✅ | ctrl-click a terminal path or click a file in Explorer → IdePane slides in OVER the app (Esc/×, reduced-motion honoured); dedicated IDE view removed |
| Start screen (launcher) | ✅ | launcher = home when nothing is restorable; pre-flight row (space · session · model · autonomy) + spawn-transparency line; On-launch preference (straight-to-shell default) — a restorable session ALWAYS boots the shell |
| First-run setup | ✅ | one screen w/ live preview: CLI detection + per-CLI default model, module toggles, integration slots, autonomy. Re-runnable from Settings → Modules |
| Settings IA | ✅ | Workspace / Agents / App groups, breadcrumbed; every legacy panel migrated, none orphaned |
| ModelChoice | ✅ | per-CLI `inherit` (adds no flag) / session-flag / diff-first config write, wired into lanes, dispatcher, planner, pulse; Connections & Models settings card shows the exact mechanism |
| Integration slots | ✅ | git = terminal/Morz Commit/lazygit/gitui · review = off/Morz Reviewer/CodeRabbit/Greptile/Copilot · editor = slide-over/VS Code/Cursor. A slot hides the Morz surface only when another provider owns it |
| Context hub | ✅ | spaces × context-files matrix (CLAUDE.md/AGENTS.md/STATUS.md/…), templates, shared-block propagation, memory-export block — all diff-first proposals |
| Memory op-set | ✅ | ADD/UPDATE/DELETE/NOOP reconciliation as the approval payload + bi-temporal soft-expiry (research: [`../research/MEMORY-SYSTEMS-RESEARCH.md`](../research/MEMORY-SYSTEMS-RESEARCH.md)) |
| Review fixes + kickoff guard | ✅ | wave-14 findings closed; `.morz/` excluded from run worktrees (ORCH-AUDIT HIGH) |

**Integration bugs found and fixed (not in any agent's branch):** the first-run wizard kept a parallel module map so setup choices never gated anything (registry is now the single source of truth, wizard mirrors it); setup re-applied its saved autonomy on EVERY boot, silently overriding the dial (and disabling Manual-gated Pulse); the status-bar dial was absolutely positioned so siblings could block its clicks; the external-editor slot was never wired to the Explorer; "Run setup again" had no UI; the rail shipped a placeholder drawer calling a non-existent store API; four divergent copies of the module contract.

**Known flaky (pass in isolation, fail under full-suite load):** `blocks.spec` TUI transitions (flaky since 0.0.1), `model-choice` dispatched-`--model`.

**Still parked from w13:** Tetris end-to-end run, auto-completion loop, adapter metering, handoff wake (ORCH-AUDIT gaps) — see [`../roadmap/REMAINING.md`](../roadmap/REMAINING.md) 0.0.7.

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
