# Morz — In-Progress Tracker

*Live status of what's being built. Update as slices land. Roadmap: [`../roadmap/`](../roadmap/).*

## Current target: **0.0.1 — "The Terminal"** ([spec](../roadmap/0.0.1.md))

Waves 1+2 (4 then 6 parallel Fable-5 agents) merged to `main` + integrated. E2E suite: 5 passed, 1 skipped.

| Slice | Status | Notes |
|-------|--------|-------|
| 1 — PTY-host + real terminals | ✅ verified | live pwsh/cmd/WSL; PATH gate Playwright-asserted. Micro-UX in (copy-on-select, ctrl+scroll zoom, context menu, split/close). **GAP: OSC-133 prompt hook never injected by PTY-host → blocks don't render (wave 3). Framed-TUI detection missing (wave 3).** |
| 2 — Session restore + PTY survival | ✅ verified | E2E: window-close reattach + scrollback replay PASS; hard-kill → SQLite layout restore PASS. Scrollback-into-dead-pane not restored (accepted). |
| 3 — Ctrl-click → IDE pane | ⏳ mostly | IdePane polished (tabs, save/conflict, silent reload, open-in-VSCode). **GAP: link ACTIVATION bug in terminal-links (E2E ide.spec is fixme on it) — wave 3.** |
| 4 — Spaces + git | ✅ verified | live branch/dirty per space. File explorer real (fs:list IPC, lazy tree). |
| 5 — Claude Code adapter | ⏳ wired, untested live | ClaudeLane mounted; Start-Claude button + cmd-K entry; permission dialog wired. **Needs live pass with real `claude` + meters (wave 3).** |
| 6 — Mode gating | ✅ wired | dial live; Manual strips lanes + never calls claude. **CI zero-LLM-call gate test missing (wave 3).** |

**Wave-2 integration:** merged w2/{shell,termux,ide,explorer,pkg,e2e}; seams fixed (context menu → ShellTerminalPane, e2e pane IDs, idempotent closeMorz); packaging seam in (electron-builder NSIS, BUILD.md); typecheck+build clean.

**Wave 3 (in flight):** OSC-133 hook + blocks e2e, Claude lane live + meters, link-activation fix, PTY-host watchdog + torture tests, real split layout (dockview-style tree), Manual CI gate + protocol.md freeze.

Legend: ✅ done · ⏳ in progress · ⬜ pending · 🚧 blocked

## Done so far (Phase 0)
- ✅ Electron + React + Tailwind4 + Framer Motion scaffold, Slate theme, all mock UI surfaces (terminals, sidebar, orchestrator, commit, reviewer, DAG, browser, remote, settings, workshop). Runs via `npm run dev`.
- ✅ Repo on GitHub (`orlrami/morz`, private). Docs reorganized under `docs/`.

## Decisions of record
See [`../../` memory: morz-decisions-locked] and [`../roadmap/README.md`](../roadmap/README.md). Key: name = **Morz**; auth = automate launching the user's own CLIs; per-plan approval; PTY survival in 0.0.1; unsigned for now; local-only telemetry; remote app parked.

## Open confirmations
- 0.0.3 cost-cap UX — revisit when reached.
- Voice exact approach — revisit at 0.0.4.
