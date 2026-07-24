# Wave 15 — "Your Morz" build wave (0.0.5)

**Theme:** modular shell + premium reorganization + bring-your-own-tools onboarding.
**Inputs:** approved mockups (claude.ai/design project "Morz — Modular Shell & First-Run Onboarding": `Morz Onboarding.html`, `Morz Shell Redesign.html` v2), [`../roadmap/0.0.5.md`](../roadmap/0.0.5.md), owner feedback 2026-07-23.
**Already merged pre-wave:** `w15/plan-route-optin` (opt-in route chips, no silent plan rewrite), `w15/planner-fast-default` (fast = Sonnet + GPT-5.5 race, Claude model picker).

---

## Slice 1 — `w15/modules-core`
Module registry + gated shell state.
- `src/shared/modules.ts`: `{ id, label, icon, defaultOn, requires? }`. Core (always on, unlisted): terminals, explorer, ide-overlay, spaces, settings.
- Modules (defaultOn marked): commit ⬜, review ⬜, orchestration ⬜ (= orchestrator + waves + runs), sessions ✅, browser ⬜, organizer ⬜, workshop ⬜, pulse ⬜, voice ⬜, obsidian ⬜.
- `modulesStore` (renderer) + settings-DB persistence over IPC; gating is REAL: disabled module mounts no component, registers no sync/notifications, spawns nothing.
- Autonomy interlock: Orchestrated dial requires orchestration module; disabling while Orchestrated drops dial to Manual with a visible notice.
- Module drawer component (used by `+` rail slot and Settings → Modules) + Ctrl-K `module: enable/disable <name>` actions.
- **DoD:** e2e — all-off leaves 5 core surfaces and zero module IPC traffic; enabling orchestration adds dock + runs without restart; interlock test.

## Slice 2 — `w15/shell-premium`
Apply the approved redesign. Tokens/fonts unchanged.
- Titlebar = brand + space tabs ONLY. Kill the top view-tab strip and the floating AgentPillBar.
- Left icon rail (56px): Core group (Terminals, Explorer) / Modules group (enabled modules only) / bottom: `+` add-modules, Settings. Active = bronze bar + tint. Tooltips.
- **Explorer (core):** toggleable 224px tree panel between rail and stage; git status badges; click file → IDE slide-over.
- **IDE slide-over (core, the old behavior kept):** ctrl-click a path in any terminal, or click a file in Explorer → IDE panel slides in from the right OVER the app (above the dock, z-top, dismissable). No dedicated IDE tab. "Open in VS Code" action in its header. A setting later allows "open in external editor instead" (slice 4 wires it).
- **Orchestrator = dial-owned dock:** Manual → no orchestrator button, no dock, anywhere. Assisted → one "Orchestrator" toggle in the stage header, dock closed by default. Orchestrated → dock auto-opens. Exactly ONE control opens/closes it.
- Statusbar three groups: left context (branch/dirty, panes·lanes) — center autonomy dial — right meters ($, tokens) + notification bell. Live agents move into the dock card + statusbar count.
- **DoD:** e2e — manual-mode DOM has zero orchestrator affordances (extends manual-gate.spec); slide-over opens from terminal link-click and Explorer; screenshot parity check against the mockup for spacing groups.

## Slice 3 — `w15/onboarding`
First-run wizard (5 steps, skippable → minimal shell), per `Morz Onboarding.html`.
- Steps: Welcome → Connect your CLIs (PATH detection + versions) → Choose modules (live tab/rail preview) → Autonomy (Manual default; Orchestrated locked unless orchestration module on) → Ready (summary).
- First-run flag in settings DB; "Run setup again" from Settings → Modules.
- Detection targets (PATH/where.exe): claude, codex, agy, **lazygit**, **gitui**, **code** (VS Code), **cursor**, ollama. Show found version; "Get it" link when missing.
- **DoD:** e2e — fresh userData boots wizard; Skip → minimal; choices persist and match rendered rail; re-run entry works.

## Slice 4 — `w15/integration-slots`
Bring-your-own-tool slots — first-run AND Settings let users pick alternatives to our modules. Researched landscape (2026):

| Slot | Ours | External options offered | Integration shape |
|---|---|---|---|
| **Git surface** | Morz Commit (staging UI + AI messages) | **lazygit** (most popular TUI, ~76k stars), **gitui** (Rust, faster on huge repos); "open in GitKraken/Fork" as a link-out, not embedded | TUI opens in a dedicated Morz pane (we already do PTY + alt-screen); chosen tool replaces the Commit rail icon |
| **Code review** | Morz Reviewer (cross-model refutation, local) | **CodeRabbit** (easiest GitHub App, ~$24/dev/mo), **Greptile** (full-repo indexing), **GitHub Copilot code review** (free with Copilot Business) | These are PR-side services: Morz records the preference, hides Morz Reviewer, and shows their PR status/link in the Commit/Sessions surfaces. No API keys stored by us |
| **Editor** | Morz IDE slide-over (default) | **VS Code**, **Cursor** | ctrl-click / Explorer click launches `code -g file:line` / `cursor -g file:line` instead of the slide-over; per-space override allowed |
| **Terminal git default** | — | plain git in terminal (slot default when nothing picked) | nothing rendered |

- Generic slot model `{ slotId, providers[], chosen }` persisted with modules; wizard step 3 renders slots from this table.
- Provider availability = detection (slice 3); unavailable providers shown greyed with install link.
- **DoD:** e2e — pick lazygit → no Commit icon, lazygit boots in a pane; pick VS Code → file click spawns `code -g` (stubbed); pick CodeRabbit → Morz Reviewer module hidden and preference persisted.

## Slice 6 — `w15/model-choice`
Per-session and default model per CLI — research: [`../research/MODEL-CONFIG-RESEARCH.md`](../research/MODEL-CONFIG-RESEARCH.md); mockup: `Morz Settings.html`.
- `ModelChoice` abstraction per connection: `{ cli, model, source: 'inherit' | 'session-flag' | 'cli-config' }`. Default **inherit** (Morz adds no flag — control philosophy).
- Spawn wiring: lanes (`claude --model`), dispatcher (`claude/codex -m/agy --model` per agent cli), planner engines (already has claude model — unify onto this), pulse, BYO opencode (`--model provider/model`).
- Model catalogs: static tables + `agy models` / `opencode models` refresh on connections sync.
- `source: 'cli-config'` = diff-first write via the 0.0.2 config-writer (`~\.claude\settings.json`, `~\.codex\config.toml`, `opencode.json`) — never silent; backups + mtime-guard.
- Settings → **Connections & Models** section per mockup: per-CLI card (status/version/applies-to chips, model select, apply-as radio, mono mechanism line), Claude fallback chain, per-space overrides.
- **DoD:** e2e — session-flag choice appears in spawn args (stubbed spawn assert) for lane + dispatched agent; inherit adds no flag; config-write path produces a diff proposal, not a write; per-space override wins over global.

## Slice 7 — `w15/start-screen`
Launcher = home = session list (competitor synthesis #1/#2 — [`../research/COMPETITOR-UI-RESEARCH.md`](../research/COMPETITOR-UI-RESEARCH.md)); mockup: `Morz Start Screen.html`.
- Boot lands here (after wizard on first run): brand hero + ONE composer with the **pre-flight row**: Space · Session (Plain shell default / Claude / Codex / Antigravity / OpenCode) · Model (from slice 6 catalogs, "Inherit" first) · Autonomy (Orchestrated locked unless module on) · launch button.
- **Spawn transparency line** under the composer: the exact command that will run (`claude --model sonnet …` / "Morz adds no flag").
- Left rail: spaces with live badges (branch, dirty, agents working, diff stats) + recent sessions per space with resume (reuses w13 sessions).
- Empty composer + Plain shell = plain terminal — terminal-first stays true; goal text + agent CLI = lane with that model; goal + Orchestrated = straight into planner.
- Quick cards: Ctrl-K, Plan-a-team, drop-a-folder.
- **Startup behavior setting** (owner decision 2026-07-24): "On launch" preference — `straight-to-shell` (default; reopen sessions exactly as left, start screen only when nothing is open) vs `always-start-screen`. Open sessions ALWAYS win and boot the shell directly. Control lives on the start screen itself + Settings → Sessions & History.\n- Layout per approved mock v2: everything (composer/pre-flight/spaces/sessions/boot pref) in the left column, File Explorer of the selected space on the right.\n- **DoD:** e2e — fresh profile boots start screen; with a restored session the app boots the shell and never mounts the start screen; preference round-trips; plain-shell open spawns zero agents; model pick flows into the lane's spawn args; recent-session resume works from the rail.

## Slice 8 — `w15/settings-ia`
Settings information architecture per mockup nav: **Workspace** (Modules / Connections & Models / Integrations) · **Agents** (Autonomy & Permissions / Planner / Memory / Routing) · **App** (Limits & Usage / Sessions & History / Notifications / Appearance / About).
- Migrate existing panels (limits, appearance, control, memory, routing, assistant, pulse mounts) into the new nav without behavior changes; breadcrumb in titlebar (`Settings / Section`).
- **DoD:** every existing settings surface reachable in the new nav; e2e settings specs updated; zero orphaned panels.

## Slice 9 — `w15/context-hub`
Manage the context files AI CLIs live off — CLAUDE.md, AGENTS.md, GEMINI.md, STATUS.md, README, `.claude/settings.json`, `.mcp.json`, `config.toml`, `opencode.json` — across every space, so no CLI ever misses context. Ships as a **module** (rail icon "Context", defaultOn ⬜).
- **Scanner:** per space, walk known context-file locations (root + `.claude/` + docs/); build a matrix spaces × files with state: present / missing / stale (file older than last N commits touching src).
- **Dashboard:** the matrix as the module's surface — missing = one-click "create from template", stale = highlighted with last-touched info; click opens the IDE slide-over.
- **Templates:** starter CLAUDE.md / AGENTS.md / STATUS.md templates (project-type aware: node/python/generic); shared blocks that can propagate to multiple projects ("apply this section to N spaces" → diff-first multi-write via the config-writer, per-file approval).\n- **Status upkeep (optional per space):** Morz maintains a STATUS.md section from real data (branch, last runs, E2E state) behind approval — the same discipline as this repo's docs/in-progress/STATUS.md.\n- **Memory bridge:** approved entries from the 0.0.4 learning-memory store can be exported as a managed CLAUDE.md block (marked `<!-- morz:memory -->`), replacing prompt-prepend-only injection — the memory system becomes useful to EVERY CLI (codex/agy read the same files), not just Claude lanes. Approval-gated, diff-first, reversible.\n- **DoD:** e2e — matrix detects a missing CLAUDE.md and creates it from template via diff approval; a shared block propagates to 2 spaces as two individual diffs; memory-export block round-trips (update memory → refreshed block proposed, never auto-written); disabled module scans nothing.

## Slice 5 — `w15/review-fixes` (small, carry-over)
Wave-14 review findings: busStore space-subscription race + unsubscribe; run-store clear idempotency (`AND cleared_at IS NULL`); pill/status stale-flicker guard (moves into dock card); planner role-text escaping + promptSeed scan; `respondPermission` behavior type guard; planTeamStore version guard.
- **DoD:** targeted unit/e2e per fix; full suite green.

---

**Wave order:** 1 first; 2, 3, 6 depend on 1; 4 depends on 1+3; 7 depends on 3+6; 8, 9 depend on 1; 5 independent. Suggest agents: 3 Fable (slices 2, 6, 7) + 5 Sol (1, 3+8, 4, 5, 9).
**Exit:** full e2e green, rebuild + reinstall signed exe, owner dogfood pass on the new shell + start screen.

## Adopted from competitor research (this wave)
Pre-flight launcher row (Claude Code Desktop), launcher-as-home (opencode), spawn transparency, login-free local-first (Warp warning), no-infra-gate first prompt (Sculptor warning). PTY fidelity stays sacred (Wave warning).

## Parked for 0.0.6 (do NOT build this wave)
**From competitor research:** run-rail with attention badges as a first-class left column (Warp vertical tabs / Conductor), summary/scan transcript mode, **Task Attempts** (same task → 2-3 agents → diff → keep winner), inline-on-diff reply-to-agent, squash-rebase one-click finalize, drag-to-split session compare (Crystal).

**Obsidian deepening (0.0.2 integration exists: REST connect, read/search, ADR write):**
- Two-way memory backing: the learning-memory store optionally persists into the user's vault (one note per entry, morz-tagged) instead of only %APPDATA% — vault becomes the durable brain, Morz the approval gate.
- Context-hub bridge: managed CLAUDE.md blocks and STATUS summaries mirrored to vault notes; ADR browser UI (list/search MADR files, open in slide-over).
- Still optional + read-mostly; every write stays no-clobber.

**Hermes assistant deepening (0.0.3 BYO-assistant exists: Hermes/OpenClaw/Comet → SpawnPlan proposals):**
- Hermes proposals get context injection from the context-hub (same CLAUDE.md/AGENTS.md the CLIs read) so its plans stop being context-blind.
- Pluggable memory providers (Honcho/mem0, Hermes-style) behind the 0.0.4 memory store interface — external provider = another backend, same approval gates.
- Assistant slot in Integrations (same slot model as git/review): Morz planner / Hermes / OpenClaw / Comet as the "who proposes plans" provider.
