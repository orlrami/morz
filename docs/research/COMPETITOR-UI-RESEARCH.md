# Competitor UI research — AI terminals & agent orchestrators (2026-07-24)

Condensed from a 4-stream research pass (~40 sources). Full detail lives in the wave-15 planning session; this file keeps the durable conclusions.

## Products studied
**Warp 2.0** (agentic dev environment, vertical-tab agent dashboard), **Wave Terminal** (block canvas), **Conductor** (worktree-per-workspace, attention badges), **Crystal** (session tree, drag-to-split, editable Monaco diff — sunset 2026-02), **Vibe Kanban** (task board, Task Attempts), **Sculptor**, **Claude Code Desktop** (inline pre-flight launcher row), **Cursor 3 Agents Window**, **opencode TUI** (logo + recents + one composer), **Terragon** (daily queue, shut down), **Amp**.

## Patterns adopted for Morz (synthesis)
1. **Launcher = home = session list** (opencode/Sculptor). No separate dashboard vs new-session screens. → Morz Start Screen.
2. **Inline pre-flight row above the composer** (Claude Code Desktop): folder · CLI · model · autonomy mode — the whole session contract visible before launch, nothing modal. Maps 1:1 onto the Morz dial.
3. **Left rail of parallel runs** with per-row status badge + branch + diff stats + unread dot (Warp vertical tabs / Conductor attention badges / Cursor agents window); nested per space (Crystal tree) for scale.
4. **Per-run isolation bundle** = worktree + branch + terminal + diff (universal convergence; Morz dispatcher already does this).
5. **Summary/scan mode** for many agents (Claude Code Summary view / Warp Summary Mode).
6. **Inline-on-diff instruction back to the agent**; run-dev-server-in-worktree before merge; squash-rebase as ONE finalize action (Conductor/Crystal/VK convergence).
7. **Task Attempts** (Vibe Kanban): run one task across 2–3 agents, diff results, keep the winner — natural fit for Morz's parallel worktrees; genuine differentiator.
8. **AI context as explicit, per-session, approval-gated toggle with diff preview** (Wave) — matches "assist, don't take over" exactly.

## Warnings (converged failure modes)
- **PTY/ANSI fidelity is existential**: CLI agents render badly inside Wave's block model (orphan cursors, stuck redraws). Morz's xterm-based panes are the right call — protect them.
- **Login-optional, local-first**: Warp's mandatory account + telemetry is its #1 complaint.
- **Never gate first prompt behind infra** (Sculptor's Docker dependency).
- **Monitor must show ALL agents**, not one at a time (Vibe Kanban weakness).
- **Feature sprawl dilutes** (Crystal spreadsheets; Claude Desktop 3-tab confusion).
- Blocks UIs break TUIs; auto-commit noise needs a squash companion.
