# Wave 16 (0.1.5 "Polish & Fix") — agent launch pack (4 agents)

Scope: [`WAVE16.md`](WAVE16.md) · reference screenshots: [`../qa/w16/`](../qa/w16/) · vision: [`../roadmap/REMAINING.md`](../roadmap/REMAINING.md) + [`STATUS.md`](STATUS.md)

## Setup (run once per agent, from C:\Projects)

```powershell
git -C C:\Projects\morz worktree add C:\Projects\morz-<dir> -b <branch> main
cmd /c mklink /J C:\Projects\morz-<dir>\node_modules C:\Projects\morz\node_modules
```

| Agent | Model | Branch | Dir |
|---|---|---|---|
| A p0-fixes | Fable 5 | `w16/p0-fixes` | `morz-p0` |
| B cli-updates | GPT-5.6 Sol | `w16/cli-updates` | `morz-cliupd` |
| C polish-motion | Fable 5 | `w16/polish-motion` | `morz-motion` |
| D planner-memory | GPT-5.6 Sol | `w16/planner-memory` | `morz-planmem` |

## Common rules — PREPEND TO EVERY PROMPT

> You are one agent of wave 16 on Morz (Electron 32 + React 18 + TS + Tailwind 4, Windows-first AI terminal). Work ONLY in your worktree/branch. Read `docs/in-progress/WAVE16.md` (your items) and `docs/in-progress/STATUS.md` first.
> Product vision in one line: a fast Windows terminal that orchestrates the user's OWN AI CLIs — assist, don't take over; every risky action approval-gated, diff-first, reversible; Manual mode provably inert.
> Rules: colors/fonts ONLY from `src/renderer/src/lib/tokens.ts` and motion from `src/renderer/src/lib/springs.ts` (never invent values); e2e tests (Playwright, `e2e/`, helpers in `e2e/app.ts` — note `launchMorz` walks the first-run wizard and launcher unless you pass `skipOnboarding:false` / `showStartScreen:true`) land WITH the change; commits `<type>(<area>): ...`, small; file encoding stays UTF-8 — never let a tool re-encode non-ASCII (em-dashes/arrows) into mojibake.
> Verify before finishing: `npm run typecheck` && `npm run build` && `npx playwright test e2e/<your-specs>`. Report honestly. Do not merge; leave the branch for the integrator.

---

## Agent A — p0-fixes · **Fable 5** · `w16/p0-fixes` · `C:\Projects\morz-p0`

> Six surgical fixes, one commit each. You can Read PNG files — LOOK at the two reference screenshots before touching UI.
>
> 1. **Module drawer renders as a clipped toggle column** (see `docs/qa/w16/drawer-clipped.png` — that skinny cut-off strip of switches IS the bug). Root cause: `ModuleDrawer` is mounted inside the 56px rail `<nav>` (`src/renderer/src/components/IconRail.tsx` ~line 130) and its overlay uses `absolute inset-0`, so it is clipped to the rail's width. Fix: render the drawer through `createPortal(..., document.body)` (or a dedicated overlay root) so it overlays the whole window as designed — full-height 320px right sheet, dimmed backdrop, Escape/backdrop-click closes (all that logic already exists in `src/renderer/src/components/ModuleDrawer.tsx`; only the mount is wrong). Keep the `data-testid="module-drawer"` and aria contracts — `e2e/modules.spec.ts` and `e2e/shell-premium.spec.ts` must stay green. Add an e2e assert that the drawer's bounding box is ≥300px wide and overlays the stage (regression for this exact bug).
> 2. **Context module dead: "Error invoking remote method 'context-hub:scan'"**. Root cause: `src/main/services/context-space-authority.ts` only authorizes roots added through the native folder picker (`src/main/index.ts` ~line 827); every pre-existing space (persisted in renderer localStorage `morz.spaces`) is unauthorized, so `registerContextHubIpc`'s `isSpaceRootAuthorized` check (`src/main/index.ts` ~678-690) rejects ALL scans. Decision (made by the lead, implement as stated): per-root picker authority is security theater here — the renderer already has `fs:list`/`file:read` IPC for arbitrary paths — so REMOVE the authorized-roots requirement from the scan path and instead validate each root the same way `fs:list` does: absolute, exists, is a directory, no `..` traversal, resolves outside no forbidden roots. Keep `context_authorized_roots` table code deleted or clearly retired (no half-dead code). Update `e2e/context-hub.spec.ts` (the forged-root test should now assert path-hygiene rejection, e.g. a relative or nonexistent root still throws). Manual proof in your report: with the Context module enabled, the matrix loads for a legacy space.
> 3. **Setup/launcher windows can't be dragged**. The first-run `OnboardingScreen` and `StartScreen` are full-window surfaces over a frameless window, so there's no drag region. Copy the pattern from `src/renderer/src/components/TitleBar.tsx` (`-webkit-app-region: drag` + a `noDrag` style on interactive children): give both screens a top strip (~40px, can be invisible or carry the brand row) that drags, with every button/select/input inside marked no-drag. Verify interactive elements still click (e2e: first-run + start-screen suites stay green).
> 4. **Native dropdowns render white** (see `docs/qa/w16/dropdown-white.png` — white menu, OS-blue highlight, wrong everywhere). Fix globally: add `color-scheme: dark` on `:root` in the global stylesheet (find it: `src/renderer/src/assets/*.css` imported by `main.tsx`) so Chromium renders dark native menus, AND style `select` + `option` (background `colors.panel`, color `colors.quartz`) so option rows match the app. Audit every `<select>` (PlanCard model pickers, OrchestratorPanel engine/model, SettingsPanel history policy, ConnectionsModelsSettings, IntegrationsSettings, StartScreen pre-flight, OnboardingScreen) — one shared class or global rule, not per-component copies.
> 5. **Version bump**: `package.json` version → `0.1.5`. Check nothing asserts the old string (grep `0.0.4` in src/ and e2e/; `e2e/updater.spec.ts` may reference it).
> 6. **Mojibake**: `src/main/assistant/bridge.ts` has UTF-8 double-encoded text (search `â€`) — the sign-in footer must read "I'm signed in and ready". Fix every mojibake sequence in that file only.
>
> Deliverables: 6 commits, each with its test; full affected suites green (`modules`, `shell-premium`, `context-hub`, `first-run`, `start-screen`, plus a new drawer-width assert). Report which specs you ran.

## Agent B — cli-updates · **GPT-5.6 Sol** · `w16/cli-updates` · `C:\Projects\morz-cliupd`

> Two connected features on the connections service (`src/main/services/connections.ts` + `src/renderer/src/components/ConnectionsSettings.tsx` / `ConnectionsModelsSettings.tsx`).
>
> 1. **Version freshness.** Today the detected CLI version (e.g. `claude 2.1.187`) is cached and never re-probed — the owner's real CLI is 2.1.200. Fix: re-probe all CLI versions on app boot (async, non-blocking) and add a "Refresh" action in the Connections & Models section; store+show `detectedAt` ("checked 2m ago"). Probe = run `<cli> --version` with a short timeout, never block the UI; a failed probe keeps the last value marked stale, never fakes green (Morz honesty rule).
> 2. **Update button.** For each CLI where an update check is possible, show "Update available → Update now" on its connection card. Mechanics per CLI: `claude update` (self-updater: checks AND installs); `codex` — detect installer channel (`npm ls -g @openai/codex` → `npm update -g @openai/codex`); `agy` — probe for a self-update subcommand (`agy update --help`), if none, hide the button for agy (do NOT invent one). The update RUNS IN A VISIBLE TERMINAL PANE (spawn via the existing PTY seam, like the lazygit slot provider does — see `src/main/services/slots.ts`) so the user sees exactly what executes. Never auto-run.
> 3. **Restart sessions after update.** When the update pane's process exits 0, surface a notice (notify-center pattern, `src/shared/notify.ts`) with a "Restart Claude sessions" action: for each live lane, capture its `--resume` session id where the adapter holds one (`src/main/adapters/claude.ts`), kill, respawn with resume. If no resume id, restart plain and say so. Approval-gated: the notice button IS the consent.
> 4. How you know the latest version: prefer the CLI's own check output; do NOT scrape websites or call update APIs directly.
>
> Deliverables: probe-on-boot + Refresh + detectedAt UI; update button with visible-pane execution (stub binary in e2e); restart-sessions flow. New `e2e/cli-update.spec.ts`: stale version refreshes on boot (stub `claude --version` output change between launches); Update-now spawns the stubbed updater in a pane; exit 0 → notice with restart action; restart respawns a lane (stub adapter). Run `e2e/connections.spec.ts` too.

## Agent C — polish-motion · **Fable 5** · `w16/polish-motion` · `C:\Projects\morz-motion`

> UI feel wave. FIRST load your `/frontend-design` skill (installed globally) for motion restraint principles. Motion values come ONLY from `src/renderer/src/lib/springs.ts`; respect `prefers-reduced-motion` everywhere (pattern already in `IdePane`'s overlay).
>
> 1. **Palette becomes Spotlight.** Today the status bar shows a persistent "Search agents, files, actions" affordance and the palette drops from wherever it's anchored. Remove the persistent bar/affordance from the StatusBar entirely. `Ctrl+K` opens the `CommandPalette` as a CENTERED modal — macOS Spotlight geometry: horizontally centered, top ~28% of the window, ~560px wide, dimmed backdrop (`rgba(20,18,12,0.45)` like ModuleDrawer), spring scale/fade in (springs.float), Escape/backdrop closes. Add a small search icon button at the TOP-RIGHT of the titlebar (next to window controls, `TitleBar.tsx`, no-drag) that opens the same palette — icon only, nothing expands inline. Keep every palette action + keyboard behavior identical (`e2e/palette.spec.ts` must pass — update its open-affordance selector only).
> 2. **Motion pass** — one orchestrated feel, nothing over 250ms, AnimatePresence exits included: Explorer panel slides in/out from the right (it currently pops); module drawer sheet springs (verify after Agent A's portal fix — coordinate: you own the animation, A owns the mount; build yours against current main and note the merge point); orchestrator dock slides from the right on open/close; center view switches get a fast crossfade (~120ms, no layout shift); rail active-pill already animates — align its timing. File-tree rows in Explorer: NO per-row animation (noise) — just the panel.
> 3. **Voice module removal.** Owner uses Wispr Flow (system-level dictation); in-app voice is dead weight. Delete: `voice` from `src/shared/modules.ts` ModuleId/MODULES + drawer hint, `VoiceSettings` component + its SettingsPanel mount, `VoiceInput` component usage in OrchestratorPanel, the main-process whisper service (`src/main/services/voice*.ts` — find it), its IPC + preload bridge, `e2e/voice.spec.ts` (module UI) — but KEEP `e2e/voice-input.spec.ts` (system-wide injected-keystroke compatibility = the Wispr Flow guarantee) and rename its describe to say so. Migration: a persisted `voice` row in modules_enabled must not crash hydration (unknown ids are already filtered by `isModuleId` — verify + test).
>
> Deliverables: Spotlight palette + titlebar icon; motion on explorer/drawer/dock/views; voice module fully removed with clean grep (`voice` in src/ only in voice-input compat contexts). Specs: updated `palette.spec.ts`, new `e2e/motion.spec.ts` (reduced-motion => no transition styles; explorer/dock mount states), updated modules/settings specs that referenced Voice. Run `modules`, `settings-ia`, `shell-premium`, `palette`, `voice-input`.

## Agent D — planner-memory · **GPT-5.6 Sol** · `w16/planner-memory` · `C:\Projects\morz-planmem`

> Two backend features.
>
> 1. **Planner = any detected CLI (add OpenCode).** The planner is a headless CLI invocation (see `src/main/orchestrator/planner.ts`: `runClaudePlanner` spawns `claude -p …`; `runAdapterPlanner` handles codex/agy). Add engine `opencode`: headless run via `opencode run -m <model> -q "<prompt>"` (VERIFY the exact non-interactive flags against the opencode CLI docs/`opencode run --help` before coding — do not guess; if the machine has no opencode binary, code against the documented interface and stub it in tests like codex is stubbed). Extraction: same single-JSON-fence contract (`extractSpawnPlanBlock`). Wire: `PlannerEngine` union + `PLANNER_ENGINES` + engine-store CHECK constraint migration (follow the exact rename-copy-drop migration pattern already in `PlannerEngineStore` for the w15 'fast' migration), `e2ePlannerResponse` stub, engine dropdown in `OrchestratorPanel` — the dropdown should render from the CONNECTIONS roster: detected CLIs enabled, undetected greyed with title "not detected on PATH" (connections store: `src/renderer/src/store/connectionsStore.ts`). Fast race stays Claude+Codex. BYO-API engines are OUT of scope (0.0.6).
> 2. **Memory bootstrap — "Build my memory".** Button in Settings → Memory (`MemorySettings.tsx`) labeled "Build memory from my files…". Flow: (a) main-process scan of the global Claude config dir (`%USERPROFILE%\.claude\CLAUDE.md`, `MEMORY.md`, `*.md` topic files, plus `projects/*/memory/*.md`) AND each registered space root's `CLAUDE.md`/`AGENTS.md`/`GEMINI.md`/`docs/**/*.md` (cap: 200 files, 256KB/file — reuse the context-hub scanner's file walking, `src/main/services/context-hub.ts`); (b) split into candidate entries — heading-bounded sections, one fact/section per entry, ≤2KB each, frontmatter `source: <absolute path>#<heading>`; (c) run every candidate through the EXISTING op-set pipeline (`src/main/memory/opset*.ts` — exact-hash dedupe + ADD/UPDATE/NOOP classification; batch, never on a launch path); (d) present ONE review surface listing all proposed ops grouped by source file with select-all/none + per-entry toggles + Apply — nothing writes without this approval (extend the existing proposal-card UI in MemorySettings rather than inventing a new surface). Provenance survives into the stored entry. Re-running bootstrap is idempotent (dedupe → NOOPs, no duplicate cards).
> 3. Scale honesty: show counts ("214 files scanned, 61 candidates, 48 new / 9 updates / 4 duplicates skipped"); truncations logged in the review surface, never silent.
>
> Deliverables: opencode engine + roster-driven dropdown + migration; bootstrap end-to-end. Tests: extend `src/main/orchestrator/planner.test.ts` (node:test via tsx — opencode extraction + engine normalization + migration) and `src/main/memory/opset.test.ts` (candidate splitting, idempotent re-run); new `e2e/memory-bootstrap.spec.ts` (fixture md tree → review lists candidates → Apply imports → re-run shows NOOPs → nothing imported without Apply); update `e2e/orch-engine.spec.ts` for the new dropdown source. Run `memory.spec.ts`, `memory-opset.spec.ts`, `orch-engine.spec.ts`.

---

## Integration order (lead)
A first (P0s touch shared UI), then C (motion over A's portal), B and D anytime. Reconcile: ModuleDrawer (A portal + C animation), StatusBar/TitleBar (C palette + B nothing), modules.ts (C removes voice). Then full suite → `npm run build:win` → `morz-0.1.5-setup.exe` → owner dogfood.
