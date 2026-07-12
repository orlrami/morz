# Morz — In-Progress Tracker

*Live status of what's being built. Update as slices land. Roadmap: [`../roadmap/`](../roadmap/).*

## Current target: **0.0.1 — "The Terminal"** ([spec](../roadmap/0.0.1.md))

Wave 1 (4 parallel Fable-5 agents) merged to `main` + integrated + fixed.

| Slice | Status | Notes |
|-------|--------|-------|
| 1 — PTY-host + real terminals | ✅ verified | live pwsh/cmd/WSL prompts render in the Slate shell; smoke PASS; PATH resolves like Windows Terminal. PTY data relays through main (direct MessagePort didn't entangle). |
| 2 — Session restore + PTY survival | ✅ mostly | tray-resident host; scrollback reattach verified by smoke. Full layout-restore across relaunch: needs a live pass. |
| 3 — Ctrl-click → IDE pane | ⏳ built, wired | FileService + CodeMirror IdePane + editor handoff done; IdePane mounted in Shell. Live ctrl-click open: needs a manual pass. |
| 4 — Spaces + git | ✅ verified | sidebar shows live branch/dirty per space + per-agent worktrees. |
| 5 — Claude Code adapter | 🚧 built, not triggered | adapter + ClaudeLane + mode gating built; ClaudeLane not yet mounted in Shell (no start-a-lane UI). Next wire-up. |
| 6 — Mode gating | ⏳ built | modeStore + Manual-inert logic present; dial UI wiring pending. |

**Integration fixes applied:** register-fn signatures, chokidar 5→4 (ESM), CSP data: fonts, unified app-events.ts, and PTY MessagePort → main-relay (the big one). typecheck + build clean; smoke PASS; window screenshot confirms live terminals.

Legend: ✅ done · ⏳ in progress · ⬜ pending · 🚧 blocked

## Done so far (Phase 0)
- ✅ Electron + React + Tailwind4 + Framer Motion scaffold, Slate theme, all mock UI surfaces (terminals, sidebar, orchestrator, commit, reviewer, DAG, browser, remote, settings, workshop). Runs via `npm run dev`.
- ✅ Repo on GitHub (`orlrami/morz`, private). Docs reorganized under `docs/`.

## Decisions of record
See [`../../` memory: morz-decisions-locked] and [`../roadmap/README.md`](../roadmap/README.md). Key: name = **Morz**; auth = automate launching the user's own CLIs; per-plan approval; PTY survival in 0.0.1; unsigned for now; local-only telemetry; remote app parked.

## Open confirmations
- 0.0.3 cost-cap UX — revisit when reached.
- Voice exact approach — revisit at 0.0.4.
