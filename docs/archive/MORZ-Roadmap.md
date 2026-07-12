# Morz — Version Roadmap (locked 2026-07-12)

*Supersedes MORZ-Backend-Plan.md §9. Decisions locked with the user. Repo: github.com/orlrami/morz (private). Built with Fable 5.*

**Product identity:** Windows-first personal AI terminal + IDE + opt-in multi-agent CLI orchestration. Wedge = **Windows-first + a real multi-file IDE + no-code agent-to-agent handoff + the control dial** (Manual / Assisted / Orchestrated). Not for market yet — for the user. Open-source & SaaS are possible futures behind seams we leave, not build.

**Auth model (locked):** Morz holds no model credentials. It **automates launching the CLIs the user already owns** — cd to the worktree, checkout the branch, launch `claude`/`codex`/`agy` visibly. The orchestrator brain is a conversation on the user's Claude; work fans out by launching CLIs in other panes (manual `ctrl+shift+click` a link → launch in a new agent window). BYO API keys (safeStorage/DPAPI) are the parallel path. `agy`/Antigravity = the math/design CLI, PTY-driven.

**Global engineering rules (every version):** own the PTY (node-pty/ConPTY in a utilityProcess PTY-host); renderer sandboxed; structured-over-scraped; Manual mode provably inert (CI-gated: zero LLM calls, zero config writes without consent); every child tagged `MORZ_SESSION` GUID + Job Object for clean kill; node-pty ABI-pinned; resolve the real user PATH at startup; Playwright `_electron` torture tests per slice.

---

## 0.0.1 — "A terminal I daily-drive" (Manual + Assisted, one Claude lane)

Makes the Phase-0 mockup real enough to replace Herdr for solo work.

- **Slice 1 — PTY-host + real terminals.** pwsh/cmd/WSL panes, split-tree (dockview), OSC-133 command blocks (consent-gated prompt hook), framed-TUI mode with Slate ITheme mapping, flow control. *Gate:* CLIs that work in Windows Terminal work in Morz (PATH test), no orphaned conhost, kill-PTY-host → dead-pane UI, 50-pane flood.
- **Slice 2 — Session restore + PTY survival.** Layout/cwd/scrollback → SQLite (`addon-serialize`, debounced) + write-ahead journal. **PTY survival (pulled into 0.0.1):** PTYs live in the utilityProcess host so agents survive window close/reload; tray-resident host, reattach on reopen. *Gate:* hard-kill window → agents still alive on reopen.
- **Slice 3 — Ctrl/shift-click → in-app IDE pane.** 3-tier link pipeline → editable **CodeMirror 6** Slate pane (lazy languages, dirty/conflict banner, find/replace, reveal file:line:col, silent-reload when agents rewrite). `morz://` scheme registered. **Open-in-VS-Code/Cursor** handoff. *(the missing UI piece.)*
- **Slice 4 — Spaces + git.** Space = project/worktree; branch/dirty/ahead-behind via `git status --porcelain=v2` + chokidar. Agents shown on their own **branches/worktrees** in the sidebar (his workflow), not all "main".
- **Slice 5 — Claude Code adapter.** `claude --input-format stream-json --output-format stream-json --include-partial-messages --verbose --permission-prompt-tool stdio` on the user's subscription; native block renderer; cost/tokens from `result` events; interrupt; `--resume`.
- **Slice 6 — Manual/Assisted gating.** Manual = adapter layer not loaded (plain terminals + blocks + preview + spaces). Assisted = one Claude lane per space, every permission → Morz approve/deny dialog, routing/handoff **suggestion chips** (no auto-execute). Orchestrated = disabled dial labeled "0.0.3".
- **Meters:** Claude cost/tokens from local stream-json + JSONL (primary); the oauth/usage endpoint best-effort only (429s hard). "No data" is a first-class meter state.
- **Packaging:** electron-builder NSIS per-user + electron-updater (GitHub releases). Unsigned for now (personal). Data dirs: `%APPDATA%\Morz` (config+db), `%LOCALAPPDATA%\Morz` (logs/scrollback).

## 0.0.2 — Bus + auto-handoff + marketplace + notes

- **Message bus v0.** SQLite task board (CAS claim + leases + sweeper) + named-pipe push first; file mailbox (Obsidian-flavored markdown) when a visible/git-diffable handoff is wanted. **Morz MCP server** (thin stdio shim → named pipe → main; trust in main): `post_to_blackboard, read_blackboard, claim_task, complete_task, open_file_in_preview`. Auto-handoff replaces the manual MD-file pattern; in Assisted it's a propose-then-approve chip.
- **Workshop marketplace (kept — wanted).** Live data: Official MCP Registry API + GitHub stars + benchmark feed (OpenRouter). One-click **Add** writes each CLI's config (parse+merge+backup). Includes the **Organizer MCP** as a flagship first-party entry.
- **Organizer MCP.** `audit / propose / explain / apply` (only apply mutates, gated). Wraps dependency-cruiser + syncpack; native rules for repo/monorepo layout, Diátaxis docs, MADR ADRs, naming, required files. Proposes reorgs in a throwaway worktree — never auto-moves. Company-standard hygiene so vibe-coded projects don't sprawl.
- **Obsidian notes (optional).** Use the user's **Obsidian** (via its Local REST API / an Obsidian MCP) — **no Morz-owned vault service.** Agents read/write the user's vault as optional context; capture ADRs/decisions back. Ships alongside the marketplace.

## 0.0.3 — Orchestrated v0 + quality gates

- **Orchestrator.** NL intent → **spawn plan → per-plan approval → dispatch** (hashed plan; every resource run-tagged; Job-Object kill). Max ~2–3 Claude/Codex agents in git worktrees + `$PORT` pool. Run-state machine (SQLite). Global stop.
- **Assistant / bring-your-own-agent.** Let the user connect **Hermes / OpenClaw / Perplexity Comet** as an assistant-style orchestrator (hosted = login/webview, local = spawn) that *proposes* — distinct from the auto fleet.
- **Cross-model reviewer + DAG waves + Definition-of-Done** wired to real data. Handoff pulses on edges.
- **Cost/token kill-switch.** Hard per-run cap that pauses the team (revisit exact UX with the user here).
- **Daily Pulse (Morz-native MCP).** Scheduled agent reviews repo/board → morning brief + in-app alarm; users can swap in Hermes/OpenClaw/Comet.

## 0.0.4 — Learning memory + browser + routing + voice

- **Cross-agent LEARNING memory (big).** Global memory every agent reads: coding standards, project conventions, "how the user likes things done" — **constantly learning** (Hermes model: corrections + workflow lessons → compact memory entries / procedural skills, staged behind **write-approval** so it never changes silently). Scoped global/project/space/agent; local-first; markdown+frontmatter + a local FTS/embedding index (fastembed-js). Morz surfaces "I learned you prefer X — apply it?" prompts.
- **Browser + element-pick (kept — wanted).** Embedded browser (webContents CDP), pick element → context, route image+styles → Antigravity, source+HTML → the code agent.
- **Routing.** Rules table (math → Antigravity, review → Codex, build → Claude) + `consult(brain)`; local models (Ollama/LM Studio native Anthropic `/v1`) for private/cheap jobs; classifier only if logs show rules missing >10%.
- **Voice (minor).** Default stays the CLI; optional local Whisper dictation into the orchestrator box; premium BYO Realtime "talk-back" later. Low priority.

## Later / future (parked)

- **Remote mobile app** — the iPhone/Android "Morz remote" companion (mission-control, approve from phone). Real future work, not near-term.
- SaaS tier, open-source release, deeper LSP in the IDE.

---

## Open confirmations
- **Name spelling:** keeping **Morz** (M-O-R-Z) everywhere; confirm if you meant a different spelling.
- **0.0.3 cost-cap UX** — revisit when we get there.

## Next action
Start building **Slice 1 (PTY-host + real terminals)** on a `slice-1-pty` branch off `main`.
