# Wave 16 — 0.1.5 "Polish & Fix" (pre-0.0.6)

*Owner's first dogfood pass on 0.0.5 (2026-07-25). Everything here ships as one patch wave; 0.0.6 stays the memory release. Screenshots in the session; root causes verified in code before scoping.*

## P0 — bugs (verified root causes)

| # | Bug | Root cause | Fix |
|---|---|---|---|
| 1 | `+` (Add modules) renders a clipped toggle column | `ModuleDrawer` mounts inside the 56px rail `<nav>` with `absolute inset-0` — constrained to the rail's width | Portal the drawer to the app root (`createPortal`); full-height right sheet as designed |
| 2 | Context module: "Error invoking remote method 'context-hub:scan'" | `context_authorized_roots` is only ever written by the native folder picker; pre-existing spaces are never authorized, so every scan throws | Space-store roots ARE the authority (every space was user-picked); seed/authorize all registered spaces, keep path-traversal + symlink guards |
| 3 | First-run/setup window can't be moved | Onboarding + Start surfaces cover the titlebar drag region (frameless window) | Add a `-webkit-app-region: drag` strip (with no-drag on interactive children) to OnboardingScreen + StartScreen tops |
| 4 | Native dropdowns render white/OS-blue | Native `<select>` popup ignores app CSS | `color-scheme: dark` at `:root` + styled `<option>` (panel bg / quartz text); audit every select (model pickers, planner engine, slots, history policy) |
| 5 | Claude version shows 2.1.187, real is 2.1.200 | Connections detection cached; no re-probe | Re-probe versions on boot + a Refresh action in Connections & Models; show "detected just now" timestamp |
| 6 | Version string still 0.0.4 | never bumped | Bump `package.json` to **0.1.5**; installer becomes `morz-0.1.5-setup.exe` |
| 7 | "I'm signed in and ready" mojibake (assistant bridge footer) | pre-existing UTF-8 double-encode in `src/main/assistant/bridge.ts` | Fix the string |

## P1 — features (same wave)

**8. CLI update button.** When the detected version is older than latest (probe: run the CLI's own check — `claude update` handles both check+install; codex/agy analog where available), Connections card shows "Update available → Update now". Runs the updater in a visible pane; on success offers **Restart sessions** (kill lanes → respawn with `--resume <sessionId>` where we hold one). Never auto-runs.

**9. Palette = Spotlight.** Remove the persistent "Search agents, files, actions" bar from the status bar. Ctrl-K opens a **centered** modal palette (Mac-style: centered, dimmed backdrop, spring in). Optional affordance: small search icon top-right of the titlebar that opens the same palette. Nothing persistent.

**10. Motion pass.** Low-key spring animations from the existing `springs` tokens, `prefers-reduced-motion` respected, nothing >250ms: Explorer panel slide-in/out, module drawer sheet, orchestrator dock slide, view crossfade (rail switches), IDE overlay already animates — align timings. One orchestrated feel, no scattered effects.

**11. Voice module removed.** Owner uses Wispr Flow (system-wide dictation) — injected keystrokes already land in every Morz field (w12/voice-input tests stay as the compatibility guarantee). Delete the Voice module, VoiceSettings, and whisper plumbing. Future idea (parked, not scoped): global push-to-talk would need an OS-level hook + local STT — only worth revisiting if Wispr ever falls short.

**12. Planner = any detected CLI.** The planner is a headless CLI run; the engine roster should be exactly the connections roster: Claude / Codex / Antigravity / **OpenCode** (new engine: `opencode run --model … -q` headless, JSON extraction like codex) + Local + Fast race. Engine dropdown reads from detected connections (undetected = greyed). **BYO API engine** (OpenAI/Gemini key like the report engine) → 0.0.6, needs the key-storage path.

**13. Memory bootstrap ("Build my memory").** Button in Settings → Memory + first-run mention: scan the global `~/.claude/*.md` (CLAUDE.md, MEMORY.md + topic files) and every space's CLAUDE.md/AGENTS.md/docs *.md (reuse the context-hub scanner), chunk into candidate memory entries (one fact per entry, source-file provenance), run each through the op-set pipeline (dedupe/NOOP), and present ONE bulk-approval review (select-all / per-entry). Nothing imports silently. This seeds the store so the learner isn't starting cold.

## Explicitly NOT in this wave
BYO-API planner (0.0.6) · procedural learning (0.0.6) · Obsidian/Hermes deepening (0.0.6) · run-rail/attention badges + Task Attempts (0.0.8) · ORCH-AUDIT auto-done loop (0.0.7).

## Suggested split
Small enough for 4 agents (or lead does P0 directly): A = P0 1-7 (surgical) · B = 8+5 update/refresh (connections) · C = 9+10+11 (palette, motion, voice removal) · D = 12+13 (planner roster + memory bootstrap). Exit: full suite green → `morz-0.1.5-setup.exe` → dogfood.
