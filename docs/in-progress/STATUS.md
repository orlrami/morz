# Morz — In-Progress Tracker

*Live status of what's being built. Update as slices land. Roadmap: [`../roadmap/`](../roadmap/).*

## Current target: **0.0.1 — "The Terminal"** ([spec](../roadmap/0.0.1.md))

| Slice | Status | Branch | Notes |
|-------|--------|--------|-------|
| 1 — PTY-host + real terminals | ⏳ not started | `slice-1-pty` | next up |
| 2 — Session restore + PTY survival | ⬜ pending | — | |
| 3 — Ctrl-click → IDE pane | ⬜ pending | — | |
| 4 — Spaces + git | ⬜ pending | — | |
| 5 — Claude Code adapter | ⬜ pending | — | |
| 6 — Mode gating | ⬜ pending | — | |

Legend: ✅ done · ⏳ in progress · ⬜ pending · 🚧 blocked

## Done so far (Phase 0)
- ✅ Electron + React + Tailwind4 + Framer Motion scaffold, Slate theme, all mock UI surfaces (terminals, sidebar, orchestrator, commit, reviewer, DAG, browser, remote, settings, workshop). Runs via `npm run dev`.
- ✅ Repo on GitHub (`orlrami/morz`, private). Docs reorganized under `docs/`.

## Decisions of record
See [`../../` memory: morz-decisions-locked] and [`../roadmap/README.md`](../roadmap/README.md). Key: name = **Morz**; auth = automate launching the user's own CLIs; per-plan approval; PTY survival in 0.0.1; unsigned for now; local-only telemetry; remote app parked.

## Open confirmations
- 0.0.3 cost-cap UX — revisit when reached.
- Voice exact approach — revisit at 0.0.4.
