# Morz — Product Research & Vision

*A Windows-first (macOS later) terminal wrapper with a built-in lightweight IDE, a pop-in/pop-out file explorer, and first-class multi-agent CLI orchestration.*

**Date:** 2026-07-10
**Status:** Research complete → ready for planning
**Research basis:** 17 parallel deep-research passes over Warp, Wave Terminal, tmux/zellij, cmux/wmux, Herdr, BridgeMind/BridgeSpace, Pi/oh-my-pi, Claude Code, Codex, Antigravity/Gemini, OpenCode, LazyGit/gitui/Magit, CodeRabbit & AI reviewers, inter-agent comms protocols, agent-team orchestration tools, desktop tech stack, and terminal micro-UX.

---

## 1. What I understood you want

You are building **Morz**: one desktop app that fuses three things that today live in separate tools —

1. **A modern terminal** (many terminals, side by side) purpose-built for running **teams of AI coding CLIs** (Claude Code, Codex, Antigravity/`agy`, OpenCode, and your current tool Herdr).
2. **A lightweight IDE + pop-in/pop-out file explorer + side preview** so you can *see* the code the agents are touching, without leaving the app.
3. **An orchestrator** — usable either as a terminal **or** as a side chat panel — that you talk to in natural language ("run an 8-agent team to finish phase 5"), which launches agents/CLIs, types into them, and lets the CLIs **talk to each other automatically** (replacing your current manual "one CLI writes a Markdown file, another reads it" workflow).

Concrete features you called out, and where each is covered below:

| # | Your ask | Section |
|---|----------|---------|
| 1 | Multiple terminals for multi-agent teams | §4.1 |
| 2 | Main orchestrator (terminal **or** side panel), NL commands, launch/type into CLIs | §4.2, §6 |
| 3 | CLIs talk to each other automatically (kill the manual MD-file handoff) | §4.3, §7 |
| 4 | Sidebar of *spaces*: projects, agents, branch, model-in-use, CLI-in-use | §4.4 |
| 5 | Pop-in/pop-out file explorer (not a fixed side panel like Warp) | §4.5 |
| 6 | Ctrl/Cmd-click a file path in output → open it in a side preview | §4.6 |
| 7 | Double-click text → auto-copy (from Herdr) | §4.7 |
| 8 | Zoom in/out (right-click / scroll), click-to-split panes | §4.7 |
| 9 | Themes (later) | §4.7 |
| 10 | LazyGit-style commit UX ("is this ready to commit?") | §4.8 |
| 11 | CodeRabbit-style AI reviewer | §4.9 |
| 12 | Save/restore directory + session on relaunch (later) | §4.10 |

**Naming note:** you said both "Morz" and "Morse." I've used **Morz** throughout. Flag if you want "Morse."

---

## 2. The big finding: you are onto something real — and you are not early or alone

The single most important research result: **the exact product you're describing is a real, fast-moving category as of mid-2026**, with at least **five near-direct competitors**. That's validation, not discouragement — it means the thesis is proven and the market is still unsettled (tools are churning: Bloop shut down Vibe Kanban, Crystal was deprecated into Nimbalyst). There is a clear opening for a **durable, Windows-first, open/hackable** entry.

The five products closest to Morz:

1. **Warp** — the blueprint *and* the main competitor. Now an "Agentic Development Environment": blocks model, universal support for external CLIs, a real parent/child agent orchestration layer with a message bus. **Weakness:** no built-in file tree/editor/preview; credit-metered pricing; Windows support has lagged.
2. **Wave Terminal** (open source) — "everything is a block," an injected control-plane CLI (`wsh`) that lets any process drive the GUI, inline file preview/editing. **Weakness:** no real multi-agent *orchestration* layer, no reviewer, no commit UX.
3. **cmux** (macOS, native) + **wmux** (its Windows Electron port) + **cmuxlayer** (its MCP orchestration add-on) — collectively ~70% of your terminal-wrapper feature list already: per-agent sidebar with branch/PR/ports, notification rings, split panes, session restore, JSON-RPC control, per-agent inbox-file messaging. **`wmux` is essentially a Windows-first prototype of large parts of Morz.**
4. **Herdr** (herdr.dev) — **almost certainly the tool you currently use** (~95% match to your description: runs multiple AI CLIs, spaces/agents sidebar, mouse-first panes, double-click copy, *no* ctrl-click-to-open-file). Its agent-state sidebar (working/blocked/idle/done) and socket API for agent handoff are the bar to beat.
5. **BridgeSpace** (by BridgeMind.ai — your "Bridgemind") — a **near-1:1 competitor already shipping**: Tauri 2 + Rust, wraps terminals + editor + file explorer + orchestration in one window, runs up to 16 agent terminals, and its **BridgeSwarm** orchestrator spawns a role-based team that coordinates through a **file-based "mailbox"** — literally the automated version of your manual Markdown workflow. **Weakness:** closed-source/commercial, fixed agent roles.

**Where Morz can win (the whitespace all five leave open):**
- A **real integrated IDE + file tree + side preview** (Warp, cmux, Herdr, Pi are terminals — they open files in an *external* editor or not at all).
- **First-class, no-code agent-to-agent communication** (only Tmux-Orchestrator's send-keys hack and Vibe Kanban's MCP board do this today; Herdr requires shell scripting; BridgeSpace is closed).
- **Genuinely Windows-first** (cmux is macOS-only; Herdr has no Windows remote mode; Conductor/Crystal are macOS-only; CodeRabbit CLI has no Windows build).
- **Ctrl/Cmd-click a file *path* → open in a side preview** (Herdr lacks it; cmux only does URLs).
- **Native LazyGit-style commit UX + CodeRabbit-style reviewer** built in, not bolted on.
- **Open / local-first / BYO-key pricing** (Warp meters credits; BridgeSpace is closed).

> **Positioning in one line:** *"Warp's blocks and orchestration + cmux's agent sidebar + a real IDE and reviewer, Windows-first, open, and with agent-to-agent messaging that just works."*

---

## 3. Competitive landscape & feature matrix

Legend: ✅ strong · 🟡 partial/bolted-on · ❌ absent · — n/a

| Capability | Warp | Wave | cmux/wmux | Herdr | BridgeSpace | **Morz target** |
|---|---|---|---|---|---|---|
| Many terminals / split panes | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Command "blocks" model | ✅ | ✅ (all content) | 🟡 | ❌ | ✅ | ✅ |
| Multi-agent orchestration | ✅ (bus) | ❌ | 🟡 (cmuxlayer) | 🟡 (scripting) | ✅ (BridgeSwarm) | ✅ **core** |
| **Agent-to-agent messaging (auto)** | ✅ | 🟡 (`wsh`) | 🟡 (inbox files) | 🟡 (socket+script) | ✅ (mailbox) | ✅ **differentiator** |
| NL orchestrator ("run 8-agent team") | ✅ (/orchestrate) | ❌ | 🟡 (plugin) | ❌ | ✅ | ✅ |
| Orchestrator as **side chat panel** | 🟡 | 🟡 | ❌ | ❌ | ✅ | ✅ |
| Spaces sidebar (branch/PR/ports) | ✅ | 🟡 | ✅ | ✅ | ✅ | ✅ |
| Sidebar shows **model + CLI in use** | 🟡 | ❌ | ❌ | 🟡 | ✅ | ✅ **gap to fill** |
| Built-in **file explorer** | ❌ | 🟡 (dir block) | ❌ | ❌ | ✅ | ✅ **pop-in/out** |
| Built-in **editor / IDE** | ❌ | ✅ (Monaco) | ❌ | ❌ | ✅ | ✅ |
| **Ctrl-click path → side preview** | 🟡 (external editor) | ✅ (`wsh view`) | 🟡 (URLs only) | ❌ | 🟡 | ✅ **differentiator** |
| Double-click / copy-on-select | ✅ | ✅ | ✅ | ✅ | ? | ✅ |
| Ctrl-scroll zoom, click-split | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Themes | ✅ | ✅ | ✅ (450+) | ✅ | ✅ (25+) | ✅ (later) |
| **LazyGit-style commit UX** | 🟡 | ❌ | ❌ | ❌ | ✅ | ✅ |
| **CodeRabbit-style reviewer** | 🟡 (review loop) | ❌ | 🟡 (plugin) | ❌ | ✅ (reviewer role) | ✅ |
| Session/dir restore on relaunch | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ (later) |
| Windows-first | ❌ (lagged) | 🟡 | 🟡 (wmux only) | 🟡 (no remote) | ✅ | ✅ **core** |
| Open / local-first | 🟡 (partial) | ✅ | ✅ (wmux) | ✅ (AGPL) | ❌ | ✅ (goal) |

**Supporting tools studied (not competitors, but sources of specific mechanisms):**
- **tmux / zellij** — the multiplexing concepts (sessions→windows→panes, `send-keys` injection, control-mode). Morz must **not depend on them** (POSIX-only); it should own its PTY layer and replicate the concepts natively on Windows ConPTY.
- **Pi / oh-my-pi** — RPC/JSONL agent control, `irc` inter-agent messaging primitive, schema-validated subagent results, per-agent worktree isolation, role-based model routing.
- **Claude Code / Codex / Antigravity / OpenCode** — the CLIs Morz must drive (integration details in §8).
- **LazyGit / gitui / Magit / aicommits** — the commit-UX blueprint (§4.8).
- **CodeRabbit / Greptile / Qodo PR-Agent** — the reviewer blueprint (§4.9).

---

## 4. Feature-by-feature blueprint

### 4.1 Multiple terminals for multi-agent teams
- Own the **PTY layer** directly: `node-pty` (Microsoft's ConPTY-based lib, the exact one VS Code uses) on Windows, portable to macOS/Linux PTYs later.
- Model state as a stable ID hierarchy **workspace → tab → pane** (mirroring tmux's `$`/`@`/`%`) so the orchestrator can target any pane unambiguously.
- Run PTYs in a **dedicated PTY-host process** (VS Code's architecture) so a flooding/crashing CLI can't take down the UI. Enable **node-pty flow control (XON/XOFF)** so a token-streaming agent can be throttled while Morz reads its output.
- Each pane = one `xterm.js` instance + WebGL renderer. Keep a **scrollback ring buffer + ANSI-stripped text view** per pane (this is what the orchestrator and reviewer read).

### 4.2 The orchestrator (terminal *and* side chat panel)
Two surfaces, one engine:
- **Side chat panel** (your Bridgemind-style ask): a conversational orchestrator you tell "spawn an 8-agent team to finish phase 5." It maps intent → a **spawn plan** (which CLIs, which roles, which worktrees) and launches them.
- **Terminal mode:** the same orchestrator runnable as a normal pane.
- Model it on **Antigravity's Manager view / Warp's `/orchestrate`**: propose a task breakdown, let you **approve before spawning** (safety gate), then dispatch.
- Render the running team as a **pill bar / lane view** (Warp's pattern): parent on the left, one pill per child agent, live status badges, click-to-switch.
- Reference for NL→agents: **Claude Code's Task/Agent tool** (description-matched roles, single-message parallel fan-out, isolated context) — but Morz wraps **multiple CLIs**, not just Claude.

### 4.3 CLIs talk to each other automatically (the headline)
This replaces your manual "CLI A writes `handoff.md`, CLI B reads it." Full architecture in **§7**. In short: a **durable file-backed mailbox/blackboard** (human-readable, so you can still eyeball it) + a **local socket event bus** for instant push + a **shared task board with atomic claim** so parallel agents never collide — driven by the orchestrator, exposed to smart CLIs via a **Morz MCP server**, and to "dumb" CLIs via **PTY keystroke injection**. The orchestrator's side panel *is* the live view of this blackboard.

### 4.4 Spaces sidebar (projects / agents / branch / model / CLI)
- Copy cmux/wmux + Herdr layout: a left sidebar of **spaces** (each = a project/worktree), and under each, its **agents** with live **semantic status** (Herdr's working / blocked / idle / done) — not just raw scrollback.
- Fill the gap all competitors leave: show **model-in-use** and **CLI-in-use** per agent. Sources: parse `claude`/`codex` `--json` streams for model/token/cost; for CLIs without JSON, screen-scrape the agent's own TUI header (cmux does this).
- On Windows, source branch/CWD/dirty/interrupt state via **shell prompt hooks** (wmux's recipe: PowerShell `prompt` override + PSReadLine preexec reporting over a named pipe; CMD via OSC 9; WSL via `PROMPT_COMMAND`/`precmd`).
- Back it with **SQLite** (like OpenCode/Warp) for durable spaces/sessions/agent state.

### 4.5 Pop-in/pop-out file explorer
- Use **dockview** (zero-dep docking layout with native **popout-window** support) so the explorer genuinely pops in/out rather than being a fixed rail.
- Treat the explorer as **just another "block"/pane view** (Wave's everything-is-a-block registry) so it composes with splits and previews.
- Live updates via **chokidar v4** (watch project roots narrowly; ignore `node_modules`/`.git` to avoid CPU spikes).

### 4.6 Ctrl/Cmd-click a path → side preview (a real differentiator)
This is entirely app-side code around `xterm.js`; the research gives literal implementation notes:
- **Two link channels:** (a) **OSC 8 hyperlinks** — have Morz tooling and agents emit `morz://open?path=..&line=..` links so clicks are unambiguous; (b) **regex link providers** for *unmarked* paths in arbitrary CLI output (compiler errors, stack traces).
- Copy **VS Code's prioritized link pipeline**: custom `morz://` links → **file paths verified to exist on disk** (stat before linking — the #1 quality differentiator vs naive regex) with `file:line:col` grammar → plain URLs (steal WebLinksAddon's battle-tested `strictUrlRegex`) → word-search fallback.
- **Gate on the platform modifier** (Cmd on macOS, Ctrl on Windows); plain click stays selection. Hover shows the resolved absolute path.
- `activate` → open a **read-only CodeMirror/Monaco preview "Beside"** at the parsed line. This one wiring delivers the whole feature — and beats Warp (which shells out to an external editor).

### 4.7 The "small features you love"
Each is a few dozen lines on top of xterm.js — cheap, high-delight, build early:
- **Double-click / copy-on-select:** double-click already word-selects in xterm.js; wire `onSelectionChange → clipboard.writeText(getSelection())`. Make it a toggle.
- **Ctrl-scroll zoom:** trap `ctrl+wheel`, adjust `term.options.fontSize`, call `fitAddon.fit()` + `pty.resize()`. Add Ctrl+= / Ctrl+- / Ctrl+0; clamp 6–40px; persist per pane.
- **Click-to-split panes:** a binary **split-tree** layout (each leaf = xterm + PTY); on every geometry change call `fit()` + `pty.resize()`. Right-click-to-split like Herdr/Warp. (This is the one non-trivial item in this group.) Consider zellij's tiled↔floating↔**pinned** pane model for the pop-out preview.
- **Themes (later):** map **base16 / iTerm / VS Code** theme files into xterm's `ITheme` (a field-rename transform) for an instant large theme library; reuse the palette for Morz's own chrome. cmux/wmux also show Ghostty theme-file compatibility = 450+ free themes.

### 4.8 LazyGit-style commit UX ("is this ready to commit?")
- **Staging surface:** one panel, **unstaged-above / staged-below**, per-file status glyphs (M/A/D/untracked) — that split *is* the "is this ready?" answer.
- **Hunk + line staging** with the GUI advantage: **click-to-toggle a hunk, drag-select lines** (beats LazyGit's modal `v`-mode). Adopt Magit's uniform model: everything is a "section," every action is an apply-variant (stage/unstage/discard/reverse) at file/hunk/line granularity.
- **Explicit commit variants as visible buttons:** commit · commit-in-editor · commit `--no-verify` · **amend**.
- **Performance:** follow **gitui** — never block the UI on git; compute status/diff off-thread, render incrementally (target gitui's 24s/0.17GB on the 900k-commit Linux repo, not LazyGit's 57s/2.6GB).
- **AI commit messages:** a native "Generate message" button running on the **staged diff** (aicommits/opencommit-style, ~1s), offering conventional/plain/gitmoji, editable before commit, with a **local-Ollama** option for private code.
- **Diff-first review** (Conductor's model): review changed hunks, not a file tree; **archive-vs-merge** workspace lifecycle with preserved chat history.

### 4.9 CodeRabbit-style AI reviewer (local-first, not a PR bot)
- A **`review` action** that runs on the working tree (staged/unstaged/last-commit) — like CodeRabbit's `cr` CLI — with a **plain human view** *and* a **structured-JSON/agent mode**.
- Surface findings as **inline gutter comments** in the IDE pane + clickable items in the side panel, each with **"apply fix"** (deterministic) or **"send to agent"** (context-rich prompt routed into an agent terminal — reusing the §7 CLI-to-CLI plumbing).
- **Verification gate** before surfacing a finding (CodeRabbit's noise-control edge) + a project-level review-instructions file.
- **Depth:** feed the reviewer caller/callee context (Greptile-style), not just the diff — diff-only reviewers catch ~44% of bugs vs ~82% with repo-graph context.
- **Build option:** embed OSS **Qodo PR-Agent** (Apache-2.0, self-hostable) or a BYO-model engine, rather than shelling to CodeRabbit CLI (which has **no Windows build** — conflicts with Windows-first).

### 4.10 Session / directory restore (later)
- Snapshot each terminal buffer with **`@xterm/addon-serialize`**; persist layout + CWD + open agents to SQLite; restore on relaunch.
- Consider a **persistent PTY-host / background daemon** (Herdr/OpenCode model) so long-running agents survive closing the window.

---

## 5. Two things every competitor proves you must get right

1. **Isolation = git worktrees.** Every serious tool (cmux, Conductor, Vibe Kanban, uzi, Claude Squad, oh-my-pi) gives each parallel agent its **own git worktree** (same repo, separate dir + branch). This is settled consensus — anything else corrupts shared files. Your "spaces" sidebar maps 1:1 to worktree+branch. Add **per-agent `$PORT`** allocation from a range (uzi/Vibe Kanban) so N dev servers don't collide.
2. **Agent messages are untrusted.** Claude Code's agent-teams feature enforces that a message from another agent is *not* the user — an agent can never approve a permission or claim "the user said yes" on another's behalf. Morz's message router **must enforce this trust boundary** so agents can't socially-engineer each other into destructive actions.

---

## 6. Orchestrator design (deeper)

**Mental model:** Antigravity's *Manager view* + Warp's *pill bar* + Claude Code's *Task tool*, generalized across CLIs.

- **Intent → plan → approve → dispatch.** NL request → proposed breakdown (roles, CLIs, worktrees, models) → **you approve** → spawn. Never auto-spawn a team without the gate.
- **Roles as a default template, user-definable.** BridgeSwarm's Coordinator / Builder / Scout / Reviewer is a sane default; let users define their own roles/pipelines (BridgeSpace's fixed 4 is a limitation to beat).
- **Artifacts, not raw scrollback.** Steal Antigravity's *Artifacts*: agents emit reviewable **Task Lists / Implementation Plans / Walkthroughs / diffs / screenshots** as cards you **comment on inline without stopping the agent**. This is the trust/monitoring surface and pairs with the reviewer.
- **Observable run-state machine** (Warp): each agent is INPROGRESS / SUCCEEDED / FAILED / **BLOCKED** / ERROR / CANCELLED; the orchestrator reacts (wait / follow-up / spawn replacement / finish). Toasts when any agent goes **blocked** (needs you) or **done**.
- **Watchdog auto-responder** (amux/uzi): detect known prompts (rate-limit, low-context, y/n) from a pane's output and auto-answer, keeping a fleet unblocked — but scoped per-agent (**never** a global `--dangerously-skip-permissions`, the thing Tmux-Orchestrator is criticized for).
- **The side panel IS the blackboard** (§7): a live, editable view of the shared task/message store, so you watch and steer agent-to-agent conversation instead of grepping MD files.

---

## 7. Inter-agent communication architecture (the core problem)

**Do not conflate two problems:** (a) *tool/context sharing* — solved by **MCP**; (b) *agent-to-agent handoff* — needs a mailbox/bus/PTY layer. MCP alone does **not** let CLI A hand work to CLI B.

**Recommended hybrid (single desktop app that owns all PTYs):**

1. **Durable file-backed mailbox / blackboard.** Adopt AMQ's **atomic-rename delivery**: write to `tmp/` → fsync → atomically rename into `inbox/new/` (the OS guarantees all-or-nothing, so no reader ever sees a half-written message). This is the single highest-leverage correctness trick and it directly hardens your current MD-file pattern. Keep messages as **JSON frontmatter + Markdown body** so they stay human-readable and git-diffable.
2. **Local socket / named-pipe event bus** on top, so a waiting agent is **woken instantly** (push) instead of polling the directory. On Windows: named pipes or AF_UNIX sockets.
3. **Shared task board with atomic claim** (file-lock or SQLite compare-and-swap, exactly as Claude Code teams + amux do) so N parallel agents never grab the same task; with automatic **dependency unblocking**.
4. **Two adapters, one blackboard:**
   - **Smart CLIs** (Claude Code, Codex, OpenCode) coordinate **programmatically** via a small **Morz MCP server (stdio)** exposing tools like `post_to_blackboard`, `read_pane`, `open_file_in_preview`, `claim_task`, `list_spaces`.
   - **"Dumb" CLIs** (e.g. `agy`, or any interactive-only tool) are driven by **PTY keystroke injection** — write literal bytes, then a **separate** CR (`\r`), and use **bracketed-paste** (`ESC[200~ … ESC[201~`) for multi-line prompts so newlines don't submit early. Read their state by **ANSI-stripped scrollback parsing**.
5. **Swappable transport.** Put files+socket behind one internal message API now; you can graduate the bus to **Redis Streams / NATS** later (many-consumer fan-out, cross-machine) without touching agent logic.
6. **Do not hard-require A2A** (Agent2Agent protocol) — adoption in coding CLIs is thin in 2026 — but **adopt its object model** (Task → Message → Part → Artifact with a lifecycle), and consider an optional A2A gateway later.

**Reference implementations that prove each piece:** Claude Code agent teams (`SendMessage` + Mailbox + file-locked task list under `~/.claude/teams` & `~/.claude/tasks`), AMQ (Maildir file bus), amux (tmux send-keys + SQLite kanban + REST), oh-my-pi `irc`, Wave `wsh`, cmuxlayer inbox files, BridgeSwarm mailbox watchers.

---

## 8. CLI integration matrix (how to actually drive each agent)

Design **one internal agent-adapter interface** — *stdin JSON in, NDJSON events out, permission callbacks, interrupt* — and make every CLI conform to it. Because Morz owns a **real PTY** per pane, it sidesteps the headless bugs that break these CLIs in plain subprocesses.

| CLI | Best control channel | Structured output | Key gotcha |
|---|---|---|---|
| **Claude Code** | `--input-format stream-json --output-format stream-json` (live, steerable) **or** the Agent SDK `query()`+`interrupt()`+`canUseTool`; `-p --bare --json-schema` for one-shots | ✅ stream-json events + `--json-schema` | Raw stdin protocol semi-documented — prefer the SDK or pin a version + feature-detect via the `capabilities` array. 3rd-party apps can't use claude.ai OAuth (needs `ANTHROPIC_API_KEY`). |
| **Codex** | `codex exec --json` inside a PTY; `codex mcp-server` (Codex *as* an MCP tool) for delegation | ✅ JSONL event stream + `--output-schema` | **Must close/ignore/redirect child stdin** or `codex exec` hangs forever; pass `--skip-git-repo-check` outside repos. (Matches your existing CLAUDE.md rule.) |
| **Antigravity `agy`** | **Real PTY only** (Morz already provides one) | ❌ plain text, no JSON/stream | **Non-TTY stdout drops the final response (exit 0)** — the "empty output" bug you know. Gemini 3 Pro OAuth needs a TTY; use API-key env vars. Scope with `--add-dir` (cwd doesn't scope). |
| **OpenCode** | `opencode serve` (HTTP server) + JS SDK; `tui.appendPrompt`/`submitPrompt`; `session.prompt(noReply:true)` for context injection | ✅ OpenAPI + SSE + `json_schema` | Per-session LSP/MCP duplication balloons memory — share instances across sessions. |
| **Pi / oh-my-pi** | RPC mode (LF-delimited JSONL over stdio) or the TS SDK | ✅ RPC JSONL / schema-validated `task` results | Base Pi omits subagents/permissions by design; oh-my-pi adds them. |
| **Herdr** (if you keep it) | its JSON socket + `herdr` CLI | 🟡 | AGPL-3.0 — study, don't copy code. |

**Takeaways:** (1) prefer **structured stdin/stdout protocols** over screen-scraping wherever a CLI offers one; fall back to PTY typing only for those that don't (`agy`). (2) Expose **Morz itself as an MCP server** so every MCP-capable CLI gets Morz-native tools and can message peers — the cleanest, vendor-neutral inter-agent channel. (3) Surface each CLI's **permission/approval prompts as native Morz dialogs** (via `canUseTool` / Codex elicitation) instead of raw terminal y/n.

---

## 9. Recommended tech stack

**Recommendation: Electron for v1** (with a clean path to a possible Tauri v2 rewrite). Rationale below — and note this is the one **architecture decision I want your sign-off on** (§11).

| Layer | Choice | Why |
|---|---|---|
| **Shell** | **Electron** (Main + dedicated **PTY-host** process, mirroring VS Code) | Morz's whole value = spawning and wiring **many shells/CLIs**. Electron ships Node, so `node-pty` (ConPTY) drops in — the lowest-friction path to process orchestration. Tauri has no bundled Node → PTY via Rust `portable-pty` or a Node sidecar = real rework for a process-heavy app. |
| **UI framework** | React (kept framework-agnostic) | Portability for a later Tauri port. |
| **Terminal** | `xterm.js` + `@xterm/addon-webgl` + `-fit`, `-search`, `-web-links`, `-serialize` | GPU-fast enough that the PTY, not the renderer, is the bottleneck. `-serialize` powers session restore; `-web-links` is the base for ctrl-click. |
| **PTY** | `microsoft/node-pty` (ConPTY, `handleFlowControl:true`) | Same lib VS Code uses; flow control throttles chatty agents. |
| **Editor** | **CodeMirror 6** for v1 (lean, <100ms init) | Fits "lightweight IDE"; switch to **Monaco** only if you want turnkey TS IntelliSense/LSP. |
| **File watch** | `chokidar v4` | 1 dep, native FS events; watch narrowly. |
| **Layout** | `dockview` | Zero-dep splits/tabs/grids + **native popout windows** (your pop-in/out explorer & pop-out terminal). |
| **Persistence** | SQLite | Spaces/sessions/agent-state/task-board; matches Warp/OpenCode. |
| **Comms** | file mailbox (atomic rename) + local socket/named-pipe + Morz MCP server (stdio) | §7. |

**The Electron ↔ Tauri tension is real and worth naming:** research strongly favors **Electron** for a process-orchestration app; but **BridgeSpace — your closest competitor — chose Tauri 2 + Rust** for fast startup and a ~5–10MB binary (vs Electron's 80–150MB installer, 150–300MB idle RAM). Electron's footprint is the accepted v1 cost; keep the frontend portable and PTY/orchestration behind an IPC boundary so a Tauri v2 rewrite stays viable once the product is validated.

---

## 10. Proposed architecture (v1)

```
┌───────────────────────────────────────────────────────────────┐
│ Renderer (React + xterm.js panes, CodeMirror preview, sidebar,│
│           orchestrator side-panel/blackboard, git & review UI)│
└───────────────▲───────────────────────────────▲───────────────┘
                │ IPC                            │ IPC
┌───────────────┴───────────┐      ┌─────────────┴─────────────────┐
│ Main / Orchestrator proc  │      │ PTY-host process              │
│  • spawn plan + approval  │      │  • node-pty per pane (ConPTY) │
│  • run-state machine      │      │  • scrollback + ANSI-strip    │
│  • message router (trust) │◄────►│  • keystroke injection        │
│  • Morz MCP server (stdio)│      │  • flow control (XON/XOFF)    │
│  • SQLite (spaces/tasks)  │      └───────────────────────────────┘
│  • file mailbox + socket  │
└───────▲───────────────────┘
        │  drives / reads
        ▼
┌───────────────────────────────────────────────────────────────┐
│ Agent CLIs, each in its own git worktree + $PORT               │
│  Claude Code (stream-json/SDK) · Codex (exec --json / mcp)     │
│  OpenCode (serve+SDK) · agy (PTY only) · Pi (RPC) · …          │
│  ↕ coordinate via Morz MCP tools (smart) or PTY inject (dumb)  │
│  ↕ post/read the shared blackboard + task board               │
└───────────────────────────────────────────────────────────────┘
```

---

## 11. Key decisions I need from you (before we plan)

1. **Tech stack:** Electron v1 (my recommendation) vs Tauri 2 (what BridgeSpace chose). Do you want the fast-to-build, process-friendly path, or the lean-binary path from day one?
2. **v1 scope:** what is the *minimum* Morz that's better than Herdr for *you*? My proposed v1 = terminals + PTY + spaces sidebar with agent-state + ctrl-click preview + copy-on-select + split/zoom + the message-bus handoff. Orchestrator-NL, reviewer, and LazyGit UX come in v2. Agree, or is the orchestrator the must-have-first?
3. **Build vs integrate the reviewer:** embed OSS Qodo PR-Agent, wrap an existing CLI, or BYO-model from scratch?
4. **Relationship to Herdr:** since it's very likely your current tool (and AGPL) — study-and-replace, or wrap/interoperate with it during transition?
5. **Naming:** Morz or Morse?
6. **Open-source or commercial/closed?** (affects AGPL-code hygiene and positioning vs BridgeSpace).

---

## 12. Risks & watch-items

- **You're entering a crowded, churning category** (Bloop/Vibe Kanban shut down; Crystal→Nimbalyst). Durability + Windows-first + open is the wedge, but move deliberately.
- **Screen-scraping agent state is brittle** — it breaks when a CLI changes its output. Prefer structured protocols; treat scraping as fallback only.
- **`node-pty` is a native module** — ABI/`electron-rebuild` pain on Windows; pin to Electron's Node ABI (mirror VS Code's versions).
- **Electron footprint** (RAM/size) will never match Tauri — mitigate with lazy-loaded editor and a PTY-host split; accept as v1 cost.
- **Trust boundary** between agents is a security must, not a nice-to-have (§5).
- **Windows gaps in the ecosystem** (CodeRabbit CLI, cmux native, Herdr remote, tmux tools) are *your opening* — but also mean fewer copy-paste solutions; expect to build more of the Windows path yourself (ConPTY, prompt hooks).

---

## 13. Bottom line

Your instinct is right and the timing is good: this is a **real, validated category** with **no dominant, open, Windows-first, IDE-complete player**. The hard part — multi-agent orchestration and CLI-to-CLI messaging — has **proven reference designs** you can borrow wholesale (file mailbox + atomic rename, shared task board with atomic claim, Morz-as-MCP-server, PTY injection for the stragglers). The differentiators that make Morz more than "another agent terminal" are the ones you already care about: a **real integrated IDE + pop-in explorer + ctrl-click preview**, a **native LazyGit-style commit UX and CodeRabbit-style reviewer**, and **no-code agent-to-agent handoff** — all Windows-first and open.

Next step: pick the answers in §11 and we turn this into a phased build plan.
