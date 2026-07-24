# Wave 15 — agent launch pack (12 agents)

**Scope:** [`WAVE15.md`](WAVE15.md) · designs: claude-design project "Morz — Modular Shell & First-Run Onboarding" · research: [`../research/`](../research/)

## Setup (run once per agent, from C:\Projects)

```powershell
git -C C:\Projects\morz worktree add C:\Projects\morz-<slug> -b <branch> main
cmd /c mklink /J C:\Projects\morz-<slug>\node_modules C:\Projects\morz\node_modules
```

## Common rules — PREPEND TO EVERY PROMPT

> You are one agent of wave 15 on Morz (Electron + React + TS, Windows). Work ONLY in your worktree and branch. Read `docs/in-progress/WAVE15.md` (your slice) + `docs/in-progress/STATUS.md` first.
> Rules: colors/fonts ONLY from `src/renderer/src/lib/tokens.ts` (never invent); Manual mode stays provably inert; every user-facing write is approval-gated/diff-first; match existing code style; e2e tests land WITH the slice (Playwright, `e2e/`, launch via `e2e/app.ts` helpers); commit messages `<type>(<area>): ...`, small commits.
> Contracts other agents rely on (define EXACTLY, do not rename): see your brief.
> Verify before finishing: `npm run typecheck` && `npm run build` && `npx playwright test e2e/<your-specs>`. Report honestly what passed/failed. Do not merge; leave the branch for the integrator.

---

## Agent 1 — modules-core · **Fable 5**
Branch `w15/modules-core` · dir `C:\Projects\morz-modules`

> Build the module registry + gated shell state (WAVE15 slice 1).
> Create `src/shared/modules.ts` — THE contract of the wave (5 other agents import it): `export type ModuleId = 'sessions'|'orchestration'|'commit'|'review'|'browser'|'organizer'|'workshop'|'pulse'|'voice'|'obsidian'`; `export interface ModuleDef { id: ModuleId; label: string; defaultOn: boolean; requires?: ModuleId[] }`; `export const MODULES: readonly ModuleDef[]` (defaults: sessions ON, all else OFF); IPC channels `ModulesApi = { get:'modules:get', set:'modules:set' }` + `ModulesBridge { get(): Promise<Record<ModuleId,boolean>>; set(id, on): Promise<Record<ModuleId,boolean>> }`.
> Main: persist enabled-map in the settings SQLite DB (pattern: `PlannerEngineStore` in `src/main/orchestrator/planner.ts:934`). Preload: expose `window.morzModules`. Renderer: `modulesStore` (zustand) hydrated at boot.
> Gating: `Shell.tsx` VIEWS derive from enabled modules — disabled = no tab/icon, component not mounted, no sync/notifications registered (check registry/pulse/workshop sync registration points). Autonomy interlock: Orchestrated dial requires `orchestration`; disabling while Orchestrated drops dial to Manual with a visible notice (modeStore). Module drawer component (list + toggles + core-locked chips) reachable from a `+` affordance and Ctrl-K actions `module: enable/disable <name>`.
> E2E `e2e/modules.spec.ts`: all-off leaves core only + zero module IPC; enable orchestration → surfaces appear without restart; interlock drops dial with notice.

## Agent 2 — shell-layout · **Fable 5**
Branch `w15/shell-layout` · dir `C:\Projects\morz-shell`

> Rebuild the shell chrome to the approved premium layout (WAVE15 slice 2; mock: "Morz Shell Redesign.html" v3 — described precisely here).
> Layout: titlebar = brand + SPACE TABS ONLY (kill the top view-tab strip). Left 56px icon rail: groups CORE (Terminals, Explorer) / MODULES (enabled modules only, from `modulesStore` — coordinate contract with Agent 1's `src/shared/modules.ts`; if not merged yet, code against the interface above) / bottom `+` (module drawer) + Settings. Active icon = bronze left bar + card bg + tooltip. Center stage with a 40px header (view title, crumb, actions right). RIGHT side, in order: Explorer panel (Agent 3 builds its internals — mount point + toggle here), then Orchestrator dock (existing OrchestratorPanel).
> Orchestrator is dial-owned: Manual → no orchestrator button/dock anywhere in the DOM; Assisted → ONE "Orchestrator" toggle chip in the stage header, dock closed by default; Orchestrated → dock auto-open. Remove AgentPillBar (live agents = dock card + statusbar count).
> Statusbar 3 groups: left branch/dirty + "N panes · M lanes"; CENTER the autonomy dial; right $ meter, token meter, notification bell.
> Keep: all existing pane/terminal logic, session restore, palette. Extend `e2e/manual-gate.spec.ts`: Manual DOM has zero orchestrator affordances. New `e2e/shell-premium.spec.ts`: tab-strip gone, rail renders enabled modules only, dial drives dock presence.

## Agent 3 — ide-explorer · **GPT-5.6 Sol**
Branch `w15/ide-explorer` · dir `C:\Projects\morz-ide`

> Explorer panel + IDE slide-over per approved design (WAVE15 slice 2 half; mock "Morz Shell Redesign.html").
> Explorer: 224px tree panel (component `ExplorerPanel`), mounts right of the stage (Agent 2 owns the mount slot; build self-contained + a minimal mount in current Shell so your branch runs standalone). Reuse the existing file-explorer data source (`src/main` fs service used by the current explorer); git status badges (M/A/?); click file → IDE slide-over.
> IDE slide-over: the OLD overlay behavior restored — ctrl-click a path in ANY terminal (existing link detection in TerminalPane/useTerminal — extend, don't fork) or click in Explorer → `IdePane` slides in from the right OVER the app (absolute, above dock, 660px, shadow, ×-close, Esc-close, `prefers-reduced-motion` respected). Reuse the existing CodeMirror IdePane internals (tabs, save/conflict, open-in-VSCode) — you are changing its CONTAINER from a docked view to an overlay, not rewriting the editor. Remove the IDE center view.
> E2E `e2e/ide-overlay.spec.ts`: ctrl-click path opens overlay with the file; Explorer click same; Esc closes; overlay renders above the orchestrator dock (z-order assert); save round-trip still green (adapt existing ide.spec.ts, keep its cases).

## Agent 4 — start-screen · **GPT-5.6 Sol**
Branch `w15/start-screen` · dir `C:\Projects\morz-start`

> Launcher = home (WAVE15 slice 7; mock "Morz Start Screen.html").
> `StartScreen` component: LEFT column — brand row; composer (goal textarea) with pre-flight grid: Space select (spaces from spaceStore + "Open a folder…"), Session select (Plain shell default / Claude / Codex / Antigravity / OpenCode — only detected CLIs enabled, from connectionsStore), Model select (visible when Session ≠ shell; catalog per `docs/research/MODEL-CONFIG-RESEARCH.md`; first option ALWAYS "Inherit CLI default"; coordinate with Agent 7's `ModelChoice` — if unmerged, emit `{cli, model:'inherit'|string}` and wire spawn args yourself for the lane path), Autonomy select (Orchestrated disabled unless orchestration module on); launch button; SPAWN TRANSPARENCY line underneath showing the exact command ("morz adds no flag" for inherit). Spaces list with live badges (branch/dirty/agents/±) + recent sessions with resume (sessionsStore). RIGHT: Explorer preview of the selected space (read-only tree; reuse explorer data source).
> Boot logic: On-launch preference `straight-to-shell` (DEFAULT — if any restorable session exists, boot the shell and NEVER mount StartScreen) vs `always-start-screen`. Preference persisted in settings DB + a control on the screen itself. Empty goal + Plain shell = plain terminal (zero agents).
> E2E `e2e/start-screen.spec.ts`: fresh profile → start screen; profile with restored session → shell directly, no start screen in DOM; plain-shell open spawns zero agents; model pick lands in lane spawn args (stub assert); preference round-trips.

## Agent 5 — onboarding · **GPT-5.6 Sol**
Branch `w15/onboarding` · dir `C:\Projects\morz-onboard`

> First-run configure screen (WAVE15 slice 3; mock "Morz First Run.html").
> One screen, not a paged wizard: LEFT steps — (1) "Your CLIs & default models": detection rows (claude/codex/agy/opencode/lazygit/gitui/code/cursor/ollama via PATH probe in main; show version; "Get it" link when missing) each with a default-model select ("Inherit CLI default" first; catalogs from `docs/research/MODEL-CONFIG-RESEARCH.md`); (2) "Modules & your tools": core chips locked, module toggles (registry from Agent 1's contract), integration slots git/review/editor (Agent 8's contract — if unmerged, persist to a `slots` map in settings DB with keys `git|review|editor`); (3) Autonomy cards (Orchestrated locked unless orchestration on). RIGHT: LIVE PREVIEW — mini shell (rail icons + tabs from current choices) + "Launch defaults" list showing exact spawn lines + a one-line autonomy note. Footer: "Open Morz" + "Skip — start minimal".
> First-run flag in settings DB; re-entry via Settings → Modules "Run setup again" + start-screen link. Skip = defaults (minimal).
> E2E `e2e/first-run.spec.ts`: fresh userData boots configure screen; Skip → minimal shell; choices persist and match the rendered rail; re-run entry works; preview updates on toggle (assert a tab appears when orchestration toggled).

## Agent 6 — settings-ia · **GPT-5.5**
Branch `w15/settings-ia` · dir `C:\Projects\morz-settings`

> Settings information architecture (WAVE15 slice 8; mock "Morz Settings.html").
> Rebuild `SettingsPanel` nav: groups WORKSPACE (Modules / Connections & Models / Integrations) · AGENTS (Autonomy & Permissions / Planner / Memory / Routing) · APP (Limits & Usage / Sessions & History / Notifications / Appearance / About). Titlebar breadcrumb "Settings / <Section>".
> MIGRATION ONLY — zero behavior change: move existing panels (limits, appearance incl. theme preview, control/autonomy, memory settings, routing settings, assistant + pulse mounts, notifications) into the new nav. "Modules" hosts Agent 1's drawer; "Connections & Models" hosts Agent 7's section; "Integrations" hosts Agent 8's slots — mount whatever exists at integration time, otherwise a labeled placeholder mount point (`data-testid="settings-mount-<id>"`).
> Update every e2e spec that navigates settings (grep `SettingsPanel`, `settings-` testids, `Limits` etc.). New `e2e/settings-ia.spec.ts`: every legacy section reachable in the new nav; deep-link (openSettings(tab)) still lands correctly; zero orphaned panels (each old component imported exactly once).

## Agent 7 — model-choice · **Fable 5**
Branch `w15/model-choice` · dir `C:\Projects\morz-model`

> ModelChoice engine (WAVE15 slice 6; research `docs/research/MODEL-CONFIG-RESEARCH.md` — treat its matrix as the spec).
> `src/shared/model-choice.ts`: `interface ModelChoice { cli: 'claude'|'codex'|'agy'|'opencode'; model: string|'inherit'; source: 'inherit'|'session-flag'|'cli-config' }` + per-CLI static catalogs + flag builders (`claude --model X` / `codex -m X` / `agy --model "X"` / `opencode --model X`; inherit = NO flag). IPC get/set per CLI + per-space override table (settings DB), preload bridge `window.morzModels`.
> Wire every launch surface: Claude lanes (`ClaudeLane`/adapter spawn), dispatcher (`launchCommand` in `src/main/orchestrator/dispatcher.ts:183` — per-agent cli), planner engines (unify the existing `claudeModel` in `src/main/orchestrator/planner.ts` onto this store), pulse headless claude, BYO opencode. Catalog refresh: parse `agy models` / `opencode models` on connections sync (best-effort, static fallback).
> `source:'cli-config'` = diff-first proposal through the 0.0.2 config-writer (`~\.claude\settings.json` model key, `~\.codex\config.toml` model, `opencode.json` model) — NEVER a direct write. Build the "Connections & Models" settings section per mock (per-CLI card: status/version/applies-to chips, model select, apply-as radios, live mono mechanism line, Claude fallback-chain input) exposed as a component Agent 6 mounts.
> E2E `e2e/model-choice.spec.ts`: session-flag choice appears in spawn args for a lane AND a dispatched agent (stubbed spawn assert); inherit adds no flag; cli-config path yields a diff proposal, not a write; per-space override wins.

## Agent 8 — integration-slots · **GPT-5.6 Sol**
Branch `w15/integration-slots` · dir `C:\Projects\morz-slots`

> BYO-tool slots (WAVE15 slice 4).
> `src/shared/slots.ts`: `interface SlotDef { id:'git'|'review'|'editor'; providers: {id:string; label:string; kind:'builtin'|'pane'|'external'|'handoff'; requiresBin?:string}[] }` + chosen-map IPC/persistence (settings DB) + preload bridge. Providers: git = terminal(default) / morz-commit / lazygit(pane) / gitui(pane); review = off(default) / morz-reviewer / coderabbit / greptile / copilot (all three external = record preference + hide Morz Reviewer + show a PR-status link affordance, NO keys stored); editor = morz(default) / vscode / cursor.
> Behaviors: pane providers launch the binary in a dedicated Morz pane (existing PTY spawn seam; alt-screen TUI handling exists); editor external = file-open requests run `code|cursor -g <file>:<line>` (feature-detect on PATH) instead of the IDE overlay — expose ONE function `openFile(path, line)` the explorer/terminal link paths call (coordinate with Agent 3: he calls it, you own it; stub = always 'morz'). Chosen git provider controls whether the Commit module surface renders (compose with Agent 1's module gating: choosing lazygit force-disables morz commit module, visible notice).
> Settings "Integrations" section component (Agent 6 mounts): slot rows with provider choices, greyed + install link when binary missing.
> E2E `e2e/slots.spec.ts`: pick lazygit → no Commit icon + lazygit boots in a pane (stub bin); pick VS Code → openFile spawns `code -g` (stubbed); pick CodeRabbit → Morz Reviewer hidden, preference persisted; missing binary renders disabled + link.

## Agent 9 — context-hub · **GPT-5.6 Sol**
Branch `w15/context-hub` · dir `C:\Projects\morz-context`

> Context-files manager module (WAVE15 slice 9). Module id `context` — ADD it to Agent 1's registry contract (coordinate; if unmerged, add to your local copy of `src/shared/modules.ts` with defaultOn:false and flag the merge point in your PR notes).
> Scanner (main): per space walk KNOWN locations only (root + `.claude/` + `docs/`) for CLAUDE.md, AGENTS.md, GEMINI.md, STATUS.md, README.md, `.claude/settings.json`, `.mcp.json`, `config.toml`, `opencode.json`. State per file: present / missing / stale (mtime older than the last N=20 commits touching `src/`). No watching; scan on open + manual refresh.
> Surface: spaces × files matrix (module view); missing → "Create from template" (project-type-aware node/python/generic starters in `resources/context-templates/`); stale → highlight + last-touched; click → IDE slide-over (or Agent 8 openFile).
> Shared blocks: a named markdown block (`<!-- morz:block:<name> -->…<!-- /morz:block -->`) can propagate to selected spaces — each write is an INDIVIDUAL diff-first proposal via the 0.0.2 config-writer. Memory bridge: "Export approved memories as a managed `<!-- morz:memory -->` CLAUDE.md block" per space — proposal-only, refresh re-proposes, never auto-writes (memory store API: `src/main/memory/`).
> E2E `e2e/context-hub.spec.ts`: matrix detects missing CLAUDE.md → template create via diff approval; shared block to 2 spaces = 2 diffs; memory-export block proposed and idempotent; module disabled = zero scanning IPC.

## Agent 10 — memory-opset · **Fable 5**
Branch `w15/memory-opset` · dir `C:\Projects\morz-memory`

> Memory v2 core, pulled forward from 0.0.6 (items 1+2 of `docs/research/MEMORY-SYSTEMS-RESEARCH.md` — that doc is your spec).
> (1) Op-set reconciliation: on any candidate memory write (learner proposals, manual adds — entry points in `src/main/memory/`), retrieve top-k same-scope facts (existing FTS5) and classify **ADD / UPDATE(targetId, old→new) / DELETE(targetId, reason) / NOOP** — one bounded LLM call max, batched, NEVER on a lane-launch path; exact-hash pre-dedup skips the call. The op object becomes the approval payload (extend the existing proposal card + MemorySettings UI to render UPDATE/DELETE diffs). SQLite audit table logs every applied op (old, new, ts, source).
> (2) Bi-temporal schema migration: add `valid_at, invalid_at, created_at, expired_at, source_run_id` to the memory index DB (migrate like PlannerEngineStore does: rename-copy-drop; markdown frontmatter gains the same fields). DELETE/UPDATE = soft-expire the old row (kept, auditable, restorable). Injection (lane prompts + dispatched promptSeed) renders validity windows for superseded facts ("used X until <date>").
> Unit tests (node:test, extensionless-import style like `planner.test.ts` — runnable via tsx) for classifier prompts (stubbed), dedup, migration, soft-expiry. E2E `e2e/memory-opset.spec.ts`: duplicate proposal → NOOP (no card); contradiction → UPDATE card with old→new; applied DELETE keeps the row expired + restorable from MemorySettings.

## Agent 11 — review-fixes · **Gemini 3.1 Pro (agy)**
Branch `w15/review-fixes` · dir `C:\Projects\morz-fixes`

> Surgical fixes from the wave-14 review — SMALL diffs only, no refactors (WAVE15 slice 5):
> 1. `src/renderer/src/store/busStore.ts:99-111` — space-subscription race (early return can leave a stale board if space changes before start()) + the subscription is never unsubscribed; fix both.
> 2. `src/main/orchestrator/run-store.ts:348` — clear idempotency: add `AND cleared_at IS NULL` to the UPDATE; make re-clear a no-op, add a unit test.
> 3. `src/main/orchestrator/run-store.ts:88` — index column order → `(cleared_at, space_root, state, created_at)` (recreate index in a migration-safe way).
> 4. `src/renderer/src/store/runsStore.ts:105` + dock live-agents card — late status push after clear must not resurrect/flicker cleared runs; drop stale statuses for evicted run ids.
> 5. `src/main/orchestrator/planner.ts:397` — escape/validate `teamOptions.team` role strings before prompt embedding (strip newlines/backticks, length-cap, printable-ASCII fallback); `planner.ts:424`-area — post-parse promptSeed scan: reject seeds containing `\x1b` escapes or null bytes (documented decision: shell text stays agent's responsibility).
> 6. `src/main/adapters/claude.ts:437` — runtime guard: `resp.behavior` must be exactly 'allow'|'deny', anything else logged + treated as deny.
> 7. `src/renderer/src/store/planTeamStore.ts` — version guard on rehydrate: unknown version → reset with console warn. Also `RunsPanel.tsx:153` missing effect dep + `:237` clear-button gate should require terminal state from fresh status.
> Each fix = own commit + its own focused test. Run affected suites: `e2e/runs.spec.ts`, `e2e/orch-plan.spec.ts`, `e2e/multi-agent-plan.spec.ts`, `e2e/assisted-verify.spec.ts`.

## Agent 12 — kickoff-guard · **Claude Sonnet**
Branch `w15/kickoff-guard` · dir `C:\Projects\morz-kickoff`

> Close ORCH-AUDIT security finding #7 + adjacent hygiene (`docs/ORCH-AUDIT.md` HIGH finding, lines 81-93):
> 1. `.morz/kickoff.md` leak: before launching any dispatched agent, append `.morz/` to the RUN WORKTREE's `.git/info/exclude` (never the shared .gitignore); alternatively relocate kickoff material outside the worktree if the CLI can read an absolute path — choose the simpler, prove it: e2e asserts `git status --porcelain` in the run worktree shows no `.morz/` and a `git add -A` commit contains no kickoff content.
> 2. Same treatment for any other Morz-written run-local files (audit `dispatcher.ts` launchAgent for every write into the worktree).
> 3. Startup orphan sweep: verify `.morz/` remnants in stale worktrees are removed by cleanup; add coverage.
> 4. Small: `agy` connections `authStatus` currently always null (ORCH-AUDIT) — add a best-effort agy auth probe (parse `agy --version`/config presence), honest 'unknown' state in UI, no fake greens.
> E2E `e2e/kickoff-guard.spec.ts` (extend `e2e/orch-e2e.spec.ts` stubs, CI-safe): dispatch a stub run → exclude entry present, porcelain clean, cleanup removes everything.

---

## Model roster used
Fable 5 ×4 (foundation/contracts + risky spawn-path work) · GPT-5.6 Sol ×5 (feature builds) · GPT-5.5 ×1 (mechanical settings migration) · Gemini 3.1 Pro ×1 (cross-model surgical fixes) · Claude Sonnet ×1 (security hygiene). Terra/Luna held in reserve for re-runs/no-shows.

## Integration order (owner/integrator, after agents finish)
1 (modules-core) → 2, 3, 6 → 7, 8 → 4, 5, 9 → 10, 11, 12 anytime. Reconcile the three shared contracts first: `modules.ts`, `model-choice.ts`, `slots.ts` + `openFile()`. Then full suite, rebuild exe, dogfood.
