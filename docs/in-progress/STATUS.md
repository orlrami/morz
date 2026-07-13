# Morz — In-Progress Tracker

*Live status of what's being built. Update as slices land. Roadmap: [`../roadmap/`](../roadmap/).*

## Current target: **0.0.1 — "The Terminal"** ([spec](../roadmap/0.0.1.md))

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
