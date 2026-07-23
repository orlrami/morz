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

## Slice 5 — `w15/review-fixes` (small, carry-over)
Wave-14 review findings: busStore space-subscription race + unsubscribe; run-store clear idempotency (`AND cleared_at IS NULL`); pill/status stale-flicker guard (moves into dock card); planner role-text escaping + promptSeed scan; `respondPermission` behavior type guard; planTeamStore version guard.
- **DoD:** targeted unit/e2e per fix; full suite green.

---

**Wave order:** 1 → 2 depends on 1; 3 depends on 1; 4 depends on 1+3; 5 independent. Suggest agents: 2 Fable (slices 2, 4) + 3 Sol (1, 3, 5).
**Exit:** full e2e green, rebuild + reinstall signed exe, owner dogfood pass on the new shell.
