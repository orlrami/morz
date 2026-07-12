# Morz — Build Plan (v0.1 draft)

*Companion to `MORZ-Research-and-Vision.md` (competitive + technical research). This is the sequenced build plan.*

**Date:** 2026-07-10 · **Status:** first draft, for your review

---

## 0. How to read this plan

- **Personal-first.** Success = *you* stop wanting to switch back to Warp or Herdr. Not market-shippability. Drift between concepts is allowed — the only test is "does this serve how I work."
- **Design-first.** Nothing gets coded until the **graphic direction is locked** (Phase 0). You asked for a great visual direction up front; the plan honors that.
- **Sequenced by daily-work-unblock.** Nothing is cut. Features are *ordered* so you're using Morz sooner, then it grows into the full thing.
- **Two north stars:** Warp (blocks, orchestration, polish) + Herdr (agent-state sidebar, mouse-first panes, copy-on-select). Every decision is benchmarked against "better than both, for me."
- **The moat:** Morz owns the PTY for every agent. That's what lets events, memory, routing, locks, checkpoints, and notifications work *uniformly* across Claude Code, Codex, agy/Gemini, OpenCode, and Pi — something single-CLI tools can't do.

---

## 1. North star (one paragraph)

Morz is a Windows-first desktop **command center for teams of AI coding CLIs**: many terminals, a built-in lightweight IDE, a pop-in/pop-out file explorer, a live browser you can pick elements from, and an orchestrator (terminal *or* side chat panel) that spawns agent teams, routes each task to the right brain (math → Gemini/agy, code → Claude/Codex), sends every agent a structured launch prompt, lets the CLIs talk to each other automatically, gates their output with a cross-model reviewer and a LazyGit-style commit UX, and lets you watch and steer the whole fleet from your phone.

---

## 2. Guiding principles (the rules every phase follows)

1. **Own the PTY.** ConPTY on Windows via `node-pty`, in a dedicated PTY-host process. Never depend on tmux.
2. **Structured over scraped.** Drive CLIs via their real protocols (Claude stream-json/SDK, Codex `exec --json`, OpenCode server/SDK, Pi RPC) and fall back to PTY keystroke injection only when a CLI has no machine interface (agy).
3. **One agent-adapter interface.** *stdin JSON in → NDJSON events out → permission callbacks → interrupt.* Every CLI conforms to it; the UI never special-cases a vendor.
4. **Agent messages are untrusted.** An agent can never approve a permission or claim "the user said yes" for another. Enforced in the message router.
5. **Isolation = git worktree per agent** (+ a `$PORT` from a pool). Serialize all git writes through one queue.
6. **Local-first & open.** No login wall, BYO keys, self-hostable everything (relay included). E2E-encrypt anything that leaves the machine.
7. **Reversible & legible.** Every agent action is checkpointed and attributable; nothing auto-merges without a green Definition-of-Done.

---

## 3. Phase 0 — Design & Graphic Direction  *(FIRST — before any code)*

Goal: a **locked visual language** and high-fidelity mockups of every core surface, so coding has a clear target.

**3.1 Design language**
- Palette, typography, spacing scale, iconography, density, dark/light. Terminal-native but calmer than Herdr's TUI; as polished as Warp.
- **Theming system spec** from day one: map base16 / iTerm / VS Code / Ghostty theme files into one Morz theme token set (terminal + app chrome share the palette). Import existing themes.
- Motion/interaction language: pane split/close, pop-in/out explorer, notification "rings" on blocked agents, pill-bar transitions.

**3.2 Surfaces to mock (high-fidelity)**
Shell layout · spaces sidebar (project / agent / state / model / CLI / branch) · agent pill-bar + lanes · orchestrator side-panel = live blackboard · terminal pane with command **blocks** · pop-in/out file explorer · ctrl-click → side preview · **in-app browser + element-pick** · LazyGit-style commit UX · reviewer panel (inline gutter + findings list) · dependency **DAG / wave** view · **remote mobile mission-control** feed · command palette (cmd-K) · plugin/"additions" marketplace.

**3.3 How to run the design phase (uses your workflow)**
- Build a clickable prototype (Figma **or** a coded static mock — decide in §7).
- Use your three-brain habit: AGY/Gemini design brief → Codex design critique → iterate. Optionally the `claude-design` tooling for coded previews.

**3.4 Exit criteria**
Locked design language + approved hi-fi mockups of at least: shell + spaces sidebar + orchestrator panel + terminal-with-blocks + commit UX. Only then does Phase 1 coding start.

---

## 4. Architecture baseline (decided during Phase 0, built after)

**Stack (v1):** Electron (Main + dedicated PTY-host) · React (kept portable) · xterm.js + WebGL/serialize/fit/web-links · node-pty (ConPTY, flow control) · CodeMirror 6 · dockview (splits/tabs/**popout windows**) · chokidar v4 · SQLite. *Electron chosen for the process-orchestration story; Tauri 2 is a possible v2 rewrite (see §7).* 

**Core services:**
- **PTY-host** — one PTY per pane, scrollback ring buffer + ANSI-stripped view, keystroke injection, flow control.
- **Orchestrator / message-router** — spawn plans, run-state machine, trust boundary, routing.
- **Message bus** — file mailbox (atomic-rename delivery) + local socket/named-pipe push + shared task board (atomic claim). Human-readable JSON+Markdown so you can still eyeball it.
- **Morz MCP server (stdio)** — exposes Morz actions to any MCP-capable CLI (`post_to_blackboard`, `read_pane`, `open_file_in_preview`, `claim_task`, `consult`, `pick_element`, …).
- **SQLite store** — spaces, sessions, agent state, task board, checkpoints, cost/tokens.
- **Shadow-git checkpoints** — per-agent worktree snapshots.

---

## 5. Build phases (after design)

Each phase ends with a concrete "you can now…" so you're using Morz continuously.

### Phase 1 — Terminal core *(replace Herdr for solo work)*
- PTY-host + xterm.js panes; **split-tree** layout, tabs, right-click-to-split.
- Command **blocks** (per-command capture: cmd/output/exit/cwd/time) — the primitive behind copy, linking, agent context.
- **Copy-on-select / double-click-copy**, **ctrl-scroll zoom**, session + working-dir **restore** on relaunch.
- **Ctrl/Cmd-click a path → side preview** (CodeMirror, verify-on-disk, `file:line:col` grammar, `morz://` OSC-8 links).
- **Pop-in/out file explorer** (dockview popout + chokidar).
- **Spaces sidebar** skeleton (project + branch + cwd via PowerShell/CMD/WSL prompt hooks).
- **cmd-K palette** skeleton + **themes** + **zero-config onboarding** (auto-import `~/.claude`, `.codex`, `.mcp.json`, `AGENTS.md`, installed CLIs).
- ▶ *You can now use Morz as your daily terminal + mini-IDE.*

### Phase 2 — Multi-agent orchestration *(the reason Morz exists)*
- **Agent-adapter interface** + per-CLI adapters (Claude stream-json/SDK; Codex `exec --json` **with stdin-close fix + `--skip-git-repo-check`**; agy via PTY; OpenCode `serve`+SDK; Pi RPC).
- **Spawn agents in git worktrees** + `$PORT` pool; per-agent sandbox/permission presets.
- **Spaces sidebar full:** per-agent **state** (working/blocked/idle/done), **model-in-use**, **CLI-in-use**, PR/ports.
- **Orchestrator** (side panel *and* terminal): NL intent → **spawn plan → you approve → dispatch**; **structured launch prompt** per agent (role / objective / output-contract / effort-budget / boundaries / report-back-to-bus); **pill-bar + lanes**.
- **Message bus live** — automatic CLI-to-CLI handoff replaces the manual Markdown file. Shared blackboard = the orchestrator side-panel.
- **Routing:** rules table (`math → agy/Gemini`, `review → Codex`, `build → Claude`) + classifier fallback (vLLM Semantic Router / semantic-router) + **`consult(brain, question)`** primitive on the MCP server.
- **Notifications:** normalized cross-agent event stream → desktop toast (blocked / done / error).
- ▶ *You can now run your daily agent teams with auto-handoff + routing.*

### Phase 3 — Quality & git *(trust the output)*
- **Cross-model adversarial review by default** — non-author brain refutes every diff (same-family self-review is measurably blind).
- **Dependency DAG + wave execution** (visual, editable); **Definition-of-Done** as executable checks (bus marks done only when green); **review → fix → test loop** bounded (~3) then escalate to you.
- **LazyGit-style commit UX** — unstaged/staged split, click-to-stage hunks, drag-select lines, commit variants (commit / in-editor / `--no-verify` / amend), gitui-fast async; **AI commit messages** on the staged diff (conventional/plain/gitmoji, local-Ollama option); diff-first review.
- **Your-own reviewer** — local working-tree review (embed OSS **Qodo PR-Agent** or BYO model; not CodeRabbit CLI — no Windows build), inline gutter comments + **apply-fix / send-to-agent**, verification gate, caller/callee context.
- **Checkpoints & observability** — shadow-git per agent worktree + **/rewind**; **cross-agent cost/token dashboard + budget caps** (ccusage-style local log parsing + OTel); replayable event log; per-agent metrics.
- ▶ *You can now let teams run and trust what merges.*

### Phase 4 — Design workflow: in-app browser + element-pick
- Embedded browser (BrowserView + `webContents.debugger` CDP); **localhost auto-detect + HMR**.
- **Pick element → ElementContext** (a11y ref + selector + curated computed styles + cropped screenshot + console/network tail + optional `data-morz-loc` source location via a Morz Vite/Babel plugin).
- **Shared browser surface** — loopback CDP proxy so the **assigned agent drives the same visible page you're watching** (the cmux/wmux move).
- Split routing: element image+styles → **Gemini/agy for design critique**; source-loc+HTML → Claude/Codex for the edit. Two-way editor↔preview highlight.
- ▶ *You can now design a site by clicking elements and handing them to the right agent.*

### Phase 5 — Remote access *(untether)*
- **`morzd`** headless daemon; **outbound-only** relay (works behind NAT/firewall, no port-forwarding); **E2E encryption** (sshx-style, relay can't read your code).
- **PWA + mobile:** multi-agent **mission-control** feed (all CLIs, color-coded status), streaming tool calls, diffs, **Approve/Deny/Interrupt from the lock screen** (with batching), push on blocked/done.
- **Tailscale Serve** default (valid HTTPS/secure-context), Cloudflare Tunnel + Access for internet exposure, SSH/`sshx`-attach fallback. Cloud-execution handoff later.
- ▶ *You can now watch and steer the whole fleet from your phone.*

### Phase 6 — Productivity layer
- Full **cmd-K** (typed filters `agent:` `skill:` `mcp:` `env:` `spawn:`); **skill/prompt/command Library** (per-agent target); **dynamic secrets** manager (store the retrieval command, never the secret; scoped per agent); **MCP manager GUI**; unified **AGENTS.md rules editor** (generates thin per-CLI files); **scheduled/background team routines** + morning digest; **hook/automation builder**; **local Whisper push-to-talk**; **squad presets** (save your planner=Claude / impl=Codex / math=agy / reviewer=Codex lineup, respawn in one command).

---

## 6. Future phases — "the additions" *(after the core app; captured now, per your ask)*

### 6.1 Cross-agent memory system
One shared memory every agent reads/writes so the whole team understands the current workflow — your "everyone reads that shared memory" idea.
- **Reference:** **Honcho** (Plastic Labs, open-source) — ships an **MCP endpoint** (`mcp.honcho.dev`) every CLI adds in one command, plus official Claude Code / OpenCode plugins. Alternatives: mem0, Letta/MemGPT, Zep.
- **Morz design:** a Morz memory service + an MCP memory server every spawned CLI connects to (so any CLI can "read this memory"), + a thin per-CLI plugin. Scoped **global / project / space / agent**. Maps onto the file-based markdown-frontmatter memory format Morz already uses (index + one-fact-per-file).
- **Decision:** build on Honcho vs mem0/Letta vs roll our own (see §7).

### 6.2 Plugin / add-on marketplace ("additions, not a shop")
A curated in-app catalog: browse plugins / skills / MCP servers / starter projects (sortable by GitHub stars, **owner-curated recommendations**), one-click **add**, and Morz writes it into your CLIs' configs so you never hand-edit and break things.
- **Thin curation + installer layer over existing infra** (don't build a new registry): ingest the **Official MCP Registry** + augment with PulseMCP/mcpmarket stars + **Agent Skills (SKILL.md)** registries + Claude Code plugin marketplaces. Model the "add" flow on **Smithery**'s CLI but in-app and multi-target.
- **Per-CLI installer adapters** (parse+merge, never overwrite; backup + config diff + rollback): Claude `.mcp.json`/`.claude` + `claude plugin install`; Codex `~/.codex/config.toml [mcp_servers.*]`; Gemini `gemini extensions install`; OpenCode `opencode.json` + `skills/`. Portable skills install everywhere by folder-copy.
- **Safety first:** every add is a **trust event** — show source/stars/provenance, config diff, sandbox untrusted servers, isolate secrets to local scope, pin versions (mitigates the known RCE/OAuth-theft/prompt-injection attacks).
- **Ship these in the store:** **Caveman** (your persona skill), **Ponytail** (lazy-senior-dev skill, `DietrichGebert/ponytail`), **Code Time** (coding stats, codetime.dev), an academic-research tool (candidates to confirm: gpt-researcher / STORM / an arxiv MCP).

### 6.3 Morz app plugin system
Let plugins extend **Morz itself** (panes/views/commands/themes), not just the CLIs. Build after the core is stable.

---

## 7. Open decisions (need your call)

| # | Decision | Recommendation |
|---|----------|----------------|
| 1 | **Design tool** for Phase 0 | Coded hi-fi prototype (reuses the real stack, becomes the front-end shell) — or Figma if you prefer pure visual iteration first |
| 2 | **Electron vs Tauri 2** | Electron for v1 (process/PTY story); keep portable for a possible Tauri v2 |
| 3 | **Reviewer engine** | Embed OSS Qodo PR-Agent, or BYO-model from scratch |
| 4 | **Memory engine** | Build on Honcho (fastest, MCP + CLI plugins exist) vs mem0/Letta vs own |
| 5 | **Name** | Morz or Morse |
| 6 | **Open-source vs closed** | Affects AGPL hygiene (Herdr) + positioning vs BridgeSpace |
| 7 | **First surfaces to design** | Shell + spaces sidebar + orchestrator panel + terminal-with-blocks + commit UX |

---

## 8. Risks

- **Crowded, churning category** (Warp, Wave, cmux/wmux, Herdr, BridgeSpace; Bloop/Crystal already died). Wedge = durable + Windows-first + open + real IDE.
- **Scope is large** — mitigated by strict phase sequencing; each phase is independently useful.
- **Native-module pain** (`node-pty`, CDP) on Windows/Electron — pin to VS Code's Electron/Node ABI.
- **Security/trust** — untrusted agents + untrusted plugins both run code; the trust boundary and the marketplace trust-gate are non-negotiable.
- **Windows ecosystem gaps** (CodeRabbit CLI, cmux native, tmux tools are macOS/POSIX) — your opening, but means building more of the Windows path yourself.

---

## 9. Immediate next steps

1. Answer the §7 decisions (especially #1 design tool, #2 stack, #7 first surfaces).
2. Kick off **Phase 0 design**: mock the shell + spaces sidebar + orchestrator panel + terminal-with-blocks + commit UX.
3. Optionally start with a three-brain design pass (AGY/Gemini design brief → Codex critique → iterate).
4. In parallel, lock the architecture baseline (§4) so it's ready when design exits.

---

*Feature-level competitive/technical detail for every item above lives in `MORZ-Research-and-Vision.md`. This plan will version as decisions land.*
