# Morz — Version Plans (pre-alpha line)

*Decisions locked 2026-07-12 (owner). Companion to `MORZ-Backend-Plan.md` (architecture) and `MORZ-Backend-Research.md` / `MORZ-Round4-Research.md` (research). Repo: `github.com/orlrami/morz` (private).*

**Identity (re-anchored):** Windows-first · real multi-file IDE · no-code agent-to-agent handoff · the control dial (Manual/Assisted/Orchestrated). Personal-first now; SaaS/open-source possible later. Name: **Morz**.

**Orchestration pattern (owner-defined, ToS-clean):** the orchestrator's core move is the **visible pane launch** — it automates exactly what you'd type by hand (`cd` into the directory → checkout/worktree the branch → launch the CLI) in a **real, visible terminal pane**. It's launching CLIs, not spawning hidden subagents. Claude = conversational orchestrator + launch-to-pane (ctrl/shift-click a task → opens as a new agent pane); Codex + Antigravity tolerate more automation. Headless orchestrator brain defaults to API key.

---

## 0.0.1 — "The Terminal" *(build now)*

Goal: **you daily-drive Morz instead of Herdr.** Manual + Assisted; one Claude lane. Orchestrated dial position visible but disabled ("0.0.3").

| # | Slice | Ships | Done when / limit test |
|---|-------|-------|------------------------|
| 1 | **PTY-host + real terminals** | node-pty/ConPTY in an Electron `utilityProcess`, MessagePorts to renderer, flow control (XON/XOFF + ack watermark), OSC-133 command blocks (nonce-guarded, opt-in profile hook), framed-TUI mode w/ Slate ITheme, **real-PATH resolution** (login-shell capture), orphan reaping (`MORZ_SESSION` GUID sweep), Job Objects | pwsh/cmd/WSL + vim render right; resize storm ok; 50 panes; kill PTY-host → dead-pane UI; **pipx/npm CLI resolves same as Windows Terminal (Playwright-asserted)** |
| 2 | **Session restore + PTY survival** | layout/cwd/scrollback → SQLite (`addon-serialize`, debounced), write-ahead journal; **tray-resident PTY host** — closing the window keeps agents/PTYs alive, reopening reattaches *(owner decision #10: in 0.0.1)* | hard-kill app → full restore; close window → `claude` keeps running → reopen reattaches to live session |
| 3 | **Ctrl-click → IDE pane** | 3-tier link pipeline (`morz://` OSC-8 → stat-verified paths w/ `file:line:col` → URLs); **editable CodeMirror 6** Slate pane (lazy languages, find/replace, dirty/conflict banners, agent-rewrites-silently-reload rule); open-in **VS Code / Cursor** handoff; `morz://` protocol registration | click a tsc error → opens at line:col; agent rewrites open file → silent reload w/ scroll kept; `vscode://` opens correctly |
| 4 | **Spaces + git** | space = project root **+ per-agent branch/worktree display** (owner: builders live on branches, merge to main — sidebar shows each agent's real branch, not "main"); `git status --porcelain=v2` + chokidar, debounced | branch/dirty/ahead-behind live; worktree per agent listed; huge repo stays smooth |
| 5 | **Claude Code adapter** | spawn user's `claude` `--input-format stream-json --output-format stream-json --include-partial-messages --verbose --permission-prompt-tool stdio` (+`--resume`); native React agent-blocks; permissions → Morz dialogs; cost/tokens from `result` events feed the meters (local-first; oauth/usage endpoint = best-effort w/ backoff); capability detection from `system/init` | live lane renders; interrupt works; kill-mid-stream recovers; malformed-JSONL fuzz survives |
| 6 | **Mode gating** | Manual = adapter layer **not loaded** (provably inert — permanent CI network-trace gate); Assisted = agent lanes + every permission through