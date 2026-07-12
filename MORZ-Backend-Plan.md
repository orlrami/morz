# Morz — Backend Plan & Pre-Alpha 0.0.1 Scope

*Companion to `MORZ-Backend-Research.md` (full 8-topic research, 560k tokens) and the Phase-0 coded mockup. This is the architecture + roadmap for making the mockup real.*

**Date:** 2026-07-12 · **Status:** for your sign-off before backend coding · **Theme locked:** Slate.

---

## 0. The one idea that reshapes everything

**The orchestrator is not a Morz-owned AI client. It *is* a CLI session you already own.**

Every account/hosting question you raised collapses once you see this. Morz never holds your model credentials, never offers "Sign in with Claude", never proxies a token. It **spawns the official CLIs you're already logged into** (`claude`, `codex`, `opencode`) and, for the orchestrator brain, runs one of them headless in structured mode (`claude --input-format stream-json --output-format stream-json`) with **Morz's own MCP server attached**. The planner *is* Claude Code (or Codex) talking to Morz's tools.

Why this is forced, not chosen (verified this pass):
- **Anthropic** (policy updated Feb 2026): consumer OAuth tokens may only be used in Claude Code / claude.ai; third-party apps "should use API key authentication." Server-side binary-identity checks since Jan/Apr 2026 killed the token-replay apps (OpenCode/OpenClaw). **But** Anthropic staff confirmed spawning the real `claude` binary as a subprocess is permitted — that's the Herdr/cmux/Zed model, and it's our path.
- **OpenAI** is permissive — Codex CLI is open-source, headless-documented ("use your ChatGPT subscription wherever you like").
- **Google/Antigravity** is hostile — ToS bars third-party use, accounts get banned for OAuth plugins, no API-key auth. So **`agy` stays a PTY pane driven by your own login, never a Morz-managed account.**

**Consequence:** Morz needs zero credentials of its own for pre-alpha. Auth = "which of your installed CLIs are logged in" (detected by *stat*-ing credential files, never reading them). BYO API keys (`ANTHROPIC_API_KEY` etc., encrypted via Electron safeStorage/DPAPI) are the parallel ToS-clean path for people without subscriptions. A future Morz SaaS tier stays possible behind an `AuthSource = LocalCliLogin | ApiKey | (future) MorzCloud` seam we define now but don't build.

---

## 1. Backend architecture (the whole system)

```
┌────────────────────────────────────────────────────────────────┐
│ Renderer (React, sandboxed: contextIsolation, no nodeIntegration)│
│  the Phase-0 UI — terminals, sidebar, orchestrator, editor, …    │
└───────▲──────────────────────────────▲──────────────────────────┘
        │ MessagePort (hot PTY data)    │ typed IPC (control plane)
┌───────┴───────────────┐   ┌───────────┴──────────────────────────┐
│ PTY-HOST              │   │ MAIN / ORCHESTRATOR PROCESS           │
│ (Electron             │   │  • Adapter layer (per-CLI)            │
│  utilityProcess)      │   │  • Orchestrator planner driver        │
│  • node-pty (ConPTY)  │◄─►│  • Router (rules → classifier)        │
│  • flow control       │   │  • MorzBus (mailbox+pipe+taskboard)   │
│  • scrollback + ANSI  │   │  • Morz MCP server host               │
│    stripped ring buf  │   │  • FileService (read/watch/save)      │
│  • keystroke inject   │   │  • UsageService (per-CLI meters)      │
│  • block markers      │   │  • SQLite (better-sqlite3, safeStorage)│
└───────────────────────┘   └───────▲───────────────────────────────┘
                                     │ spawns (user's own auth)
        ┌────────────────────────────┴───────────────────────────┐
        │ Agent CLIs — each in its own git worktree + $PORT        │
        │  claude (stream-json) · codex (exec --json) · agy (PTY)  │
        │  · opencode (serve+SSE) · local: Ollama/LM Studio        │
        │  each gets a morz-mcp stdio shim → named pipe → Main     │
        └──────────────────────────────────────────────────────────┘
```

**Process model = VS Code's, exactly.** PTY-host in an Electron `utilityProcess` (Node APIs + MessagePorts straight to the renderer, bypassing main for hot data). Renderer fully sandboxed from day one. Every spawned child tagged `MORZ_SESSION=<guid>` so a startup sweep reaps orphans.

---

## 2. The three modes — exact mechanics (assist, don't take over)

Modes are **additive service layers on one engine**, provably distinct:

| Mode | What runs | What it will NOT do |
|------|-----------|---------------------|
| **Manual** | PTY-host + terminal UI + SQLite only. **Zero** LLM calls, zero watchers, zero hooks. `claude` typed here is just `claude` in a pane. | Nothing background. Provably inert. The default. |
| **Assisted** | + event-tap on CLIs you launched (state detection), Morz MCP server + bus, routing **suggestions** as one-click "handoff chips". | Never launches or types into a CLI without your click. |
| **Orchestrated** | + planner session, spawn plans, git-worktree isolation, task board, scoped watchdog, bounded review loops. | Never spawns anything outside a **hashed, user-approved plan**. |

**Dialing down mid-run is non-destructive** (all state in SQLite): Orchestrated→Assisted stops the dispatcher, converts pending auto-handoffs to suggestion chips, agents keep running; →Manual detaches services, leaves plain terminals.

**The approval gate is the enforcement point, not a UI nicety:** the dispatcher only spawns from a stored plan hash; every spawned resource is tagged with the run id for one-click reversibility. Permission requests use the CLI's native callback (`--permission-prompt-tool stdio` → `control_request/can_use_tool`) surfaced as a Morz dialog — that single wiring *is* the "propose-then-approve" philosophy made concrete.

---

## 3. Keeping the Morz personality over real CLIs (your explicit ask)

Three-tier presentation (never raw black PowerShell):
1. **Shells** (pwsh/bash) → real **command blocks** via OSC 133 shell-integration marks (auto-injected prompt hook, per-session nonce so agents can't spoof block boundaries), rendered as xterm.js marker-anchored decorations over one continuous buffer.
2. **Interactive AI TUIs** (Claude Code, Codex TUI, agy) → **framed full-TUI mode**: the raw xterm grid inside Morz pane chrome with the **Slate palette mapped into xterm's 16-color ITheme** — cheap, high-impact, makes Claude look Morz-branded with zero protocol work. (Claude Code doesn't emit OSC 133, so we don't fake blocks for it.)
3. **Orchestrated agent lanes** → **no terminal at all**: drive `claude … stream-json` / `codex exec --json`, render the JSONL events as **native React agent-blocks** (diffs, tool calls, tokens) — the cleanest personality of all.

Mode detection: a **known-TUI process registry** (Morz spawns it, so it always knows) is the load-bearing detector — alt-screen detection alone misclassifies Ink CLIs like Claude Code. Agent-state (working/blocked/idle/done): Claude Code **hooks** (Notification/Stop → a Morz named pipe) where available; JSONL events for Codex; OpenCode SSE; output-quiescence + regex watchdog as the universal fallback for agy.

---

## 4. In-app IDE + external handoff (the missing piece you flagged)

- **Editable CodeMirror 6 pane**, "Beside" the terminal, opened by ctrl/shift-click on a path. Scope = Warp's editor, deliberately **not** an IDE: syntax highlighting (lazy per-language via `@codemirror/language-data`), find/replace, dirty tracking, a **Slate theme driven from the same tokens.css variables** so editor + terminal + chrome share one palette.
- **FileService** in main over typed IPC: read/atomic-save/watch (chokidar), mtime conflict banner. Critical rule: since **agents rewrite open files constantly**, a not-dirty file silently reloads preserving scroll; a dirty file shows a reload/overwrite banner. Echo-suppress Morz's own saves.
- **Reveal file:line:col** helper shared by the ctrl-click pipeline and `morz://open?path=..&line=..` deep links (Electron registers the `morz://` scheme so links work even from outside the app).
- **Open in your own editor**: `vscode://file/{path}:line:col` (documented), `cursor://` (VS Code fork, verify at runtime), CLI fallback `code|cursor -g file:line:col`; registry-probe installed editors on Windows and grey out missing ones. JetBrains/Windsurf deferred.
- **LSP is OUT of pre-alpha** (Warp shipped without it); when added, use the official `@codemirror/lsp-client`.

---

## 5. Routing + local models

- **Router = two stages, dial-gated.** (1) declarative first-match **rules table** (`math → Antigravity/Gemini`, `review → Codex`, `build → Claude`); (2) local **embedding classifier** fallback — *not* vLLM Semantic Router (it's an Envoy/K8s service); reimplement Aurelio's pattern in ~200 lines TS with **fastembed-js** (ONNX, CPU, no Python). Output is a suggestion in Manual, a card in Assisted, auto-applied-but-visible in Orchestrated.
- **`consult(brain, question)`** — a Morz MCP tool that fans a one-shot question to a *non-author* brain (your three-brain habit, productized) with cost logging + untrusted-response labeling.
- **Local models**: auto-detect Ollama (:11434) + LM Studio (:1234). Big finding — both now expose **native Anthropic `/v1/messages`**, so Claude Code runs fully local with just `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN` env vars — **no LiteLLM proxy needed** (also dodges the recent LiteLLM supply-chain incident). Because Morz owns every spawn environment, routing-to-local is a pure **env-var injection at spawn** — no per-CLI plugin. Route-to-local policy: always-local for cheap deterministic jobs (commit messages, summaries, the embeddings themselves), fallback when rate-limit meters show exhaustion, forced when a space is flagged private. (Watch Ollama's silent 4k `num_ctx` default — set `OLLAMA_CONTEXT_LENGTH`.)

---

## 6. Message bus + Morz MCP server (replaces your manual MD-file handoff)

Three layers behind one `MorzBus` interface (in main for pre-alpha; extract to `morzd` at Phase 5):
1. **File mailbox** — Maildir `tmp/→fsync→atomic-rename→new/` under project-local `.morz/bus/`, human-readable JSON-frontmatter + Markdown (you can still eyeball it), mirrored to SQLite for querying.
2. **Named-pipe push** — `\\.\pipe\morz-bus-<nonce>`, NDJSON wake-notifications only (payloads stay in files), token handshake for identity. The nonce + token defeat Windows pipe-squatting.
3. **SQLite task board** — atomic `UPDATE…RETURNING` compare-and-swap claim, DAG deps via `NOT EXISTS`, **claim leases + sweeper** so a dead agent doesn't wedge the graph forever.

**Morz MCP server** = a thin **stdio shim** (`morz-mcp`, single bundled JS, no native modules) each CLI spawns; it proxies every tool call over the named pipe to main, where **all trust decisions live** (MCP annotations are hints, never relied on). Eight v0 tools: `post_to_blackboard, read_blackboard, claim_task, complete_task, consult, read_pane, open_file_in_preview, pick_element`. Morz **writes each CLI's config itself** at spawn (parse+merge+backup, never clobber) — `.mcp.json` / `config.toml [mcp_servers]` / `opencode.json` — which is also the prototype for the future marketplace installer. **Trust boundary is a real mechanism**: agent reports reach the planner as MCP tool results / bus docs, **never as `user`-role messages** — role-tagging is what stops an agent impersonating your approval.

---

## 7. Real data for the windows (honest tiers)

| CLI | Meter source | Reliability |
|-----|-------------|-------------|
| **Claude** | `GET api.anthropic.com/api/oauth/usage` (the endpoint Claude's own HUD uses; needs `User-Agent: claude-code/<v>` + `anthropic-beta` header) → `five_hour / seven_day / seven_day_sonnet`, each with utilization + reset. JSONL parse for per-project cost. | **Reliable** (undocumented — needs a fallback) |
| **Codex** | Tail `~/.codex/sessions/**/rollout-*.jsonl` `rate_limits` (5h + weekly); `codex app-server` for on-demand refresh | **Reliable** |
| **Antigravity** | No quota API — session-token totals only | **Estimated** (show a confidence badge, never fake precision) |
| **OpenCode** | `opencode serve` REST + SSE — a spend meter, not a limit meter (also the best status channel) | **Cost only** |

Note: the Claude response has **three windows** — the mockup's single `used%` needs multi-ring/stacked bars, and a "no data" state must be first-class. **Workshop catalog** = real: Official MCP Registry API (`registry.modelcontextprotocol.io/v0.1/servers`, incremental `?updated_since`, install-spec included) + GitHub stars API. **Benchmarks** = OpenRouter's free `/api/v1/benchmarks` (Artificial Analysis) + `/api/v1/models` — no scraping.

---

## 8. Gaps you were missing (the audit — I'm proposing boldly)

1. **Windows code signing sequencing** — decide **before** any build leaves your machine. Azure Trusted/Artifact Signing (~$10/mo, open to US individuals, kills SmartScreen). An unsigned→signed switch later **breaks the electron-updater trust chain**. Set it up once, now, or accept manual reinstalls forever.
2. **ConPTY orphan reaping** — PTYs leak `conhost.exe` if Morz dies; tag children with `MORZ_SESSION` GUID, sweep-kill at startup. No competitor does this cleanly.
3. **Shell-env fidelity** — Electron launched from Start Menu inherits a minimal PATH; must resolve your real PATH (spawn a login shell once, like VS Code) or npm/pipx-installed CLIs "work in Terminal but not Morz" — a first-impression killer.
4. **Crash recovery as a designed state machine** — renderer crash → reload + journal; PTY-host crash → watchdog respawn + dead-pane UI; app crash → write-ahead session journal + orphan sweep.
5. **AV false positives** — an app that spawns PTYs + injects keystrokes + writes many small files matches malware heuristics; signing helps most, submit false-positive reports early.
6. **Windows Job Objects** — put every spawned agent in a Job Object per run so Cancel reliably kills the whole tree (no zombie dev servers holding ports).
7. **Secrets** via Electron `safeStorage` (DPAPI) as encrypted blobs in SQLite — never plaintext, never keytar (archived).
8. **Clean-room policy** — Herdr is AGPL; study behavior, never read its source (keeps open-vs-closed open).
9. **E2E torture harness** — Playwright `_electron.launch` from Slice 1 so "limit-test it" is a repeatable `npm` script (flood, 50-pane, kill-mid-stream, malformed-JSONL fuzz).
10. **Data-dir contract** — `%APPDATA%\Morz` (config + db), `%LOCALAPPDATA%\Morz` (logs, scrollback, later worktrees). Documented day one.

---

## 9. Pre-Alpha 0.0.1 roadmap (the bold cut)

**0.0.1 ends at "a terminal you daily-drive + one Claude lane, Manual + Assisted." Bus and Orchestrated are explicitly deferred** — shipping the bus half-baked would poison the trust story that is Morz's whole point. Each slice ends in something you use the same day, with a limit-test.

| Slice | Ships | Limit test |
|-------|-------|-----------|
| **1. PTY-host + real terminals** | pwsh/cmd/WSL panes, splits, blocks (OSC 133), flow control, framed-TUI, orphan reaping | resize storm; 50 panes; kill PTY-host → dead-pane UI not white screen |
| **2. Session restore** | layout + cwd + scrollback to SQLite (`addon-serialize`, debounced), write-ahead journal | hard-kill mid-session → restores |
| **3. Ctrl-click → preview** | 3-tier link pipeline → editable CodeMirror Slate pane; `morz://` reveal; open-in-VSCode/Cursor | malformed paths, WSL paths, agent rewriting open file |
| **4. Spaces + git** | space = project/worktree; branch/dirty/ahead-behind via `git status --porcelain=v2` + chokidar | huge repo; detached HEAD; rapid branch switches |
| **5. Claude Code adapter** | `claude … stream-json --permission-prompt-tool stdio`, native block renderer, cost/token from `result`, interrupt | flood tokens; kill mid-stream; malformed JSONL fuzz |
| **6. Manual/Assisted gating** | Manual = adapter layer not loaded; Assisted = every permission → Morz dialog, one agent/space; Orchestrated = disabled dial labeled "0.0.3" | verify Manual makes zero LLM calls (network trace) |

**Deferred, pre-specified now** (so slices build against a frozen schema in `docs/protocol.md`):
- **0.0.2** — Bus v0 (file mailbox + named-pipe + task board + 4-tool MCP server).
- **0.0.3** — Orchestrated v0 (NL → spawn plan → approve → max 2 Claude agents in worktrees, run-state machine, global stop).
- **0.0.4+** — reviewer, commit UX wiring, browser+element-pick, remote/morzd, routing classifier, workshop live data, marketplace installer, cross-agent memory.

**Stack additions for 0.0.1:** `node-pty` (ABI-pinned to Electron 32, `useConptyDll`, asarUnpack), `@xterm/addon-serialize`, `better-sqlite3`, `chokidar`, `electron-builder` + `electron-updater`, Playwright (E2E).

---

## 10. Decisions I need from you (the real forks)

**Scope & process**
1. **Cut line** — agree 0.0.1 stops at Manual + Assisted (bus → 0.0.2, orchestrated → 0.0.3)? Or do you need a 2-agent orchestration demo in 0.0.1 for motivation?
2. **Signing** — do the Azure Artifact Signing setup now (US individual, ~$10/mo), or 0.0.1 is strictly your-machine unsigned?
3. **Approval granularity** — approve the whole plan once (Warp-style) or each agent spawn (more literal to your philosophy, more clicks for 8 agents)?

**Auth & engine**
4. **Claude orchestrator billing** — default to spawning your `claude` CLI on your subscription (rides the Agent SDK credit pool; simplest) **or** require `ANTHROPIC_API_KEY` for the orchestrator brain? (I recommend CLI-subscription default + a one-time compliance note.)
5. **agy/Gemini in Orchestrated** — PTY-type into your own agy pane (ToS-safest, matches how you work) or require `GEMINI_API_KEY` for headless math? (I recommend PTY default.)
6. **Hooks/config touching** — Assisted-mode state detection + OSC-133 blocks want to write a hook/prompt into your `~/.claude/settings.json` / PowerShell profile (guarded, reversible). Auto-install with consent, or opt-in only?

**Product**
7. **SaaS someday?** — do you ever want a Morz-hosted inference tier (needs a backend + resale deals), or is BYO-forever the identity? (Decides if the `AuthSource` seam gets a cloud impl later — not built now either way.)
8. **PTY survival** — 0.0.1: PTYs die with the app (simple), or tray-resident so agents survive window close (Herdr model, more plumbing — I'd defer to 0.0.4)?
9. **Telemetry** — local minidumps only, or opt-in Sentry from 0.0.1?

---

## 11. Bottom line

The architecture is clean and the hardest questions have decisive answers: **Morz owns no credentials — it drives the CLIs you already pay for, and the orchestrator is just one of them wearing Morz's MCP tools.** That single decision makes auth, hosting, routing, and the control dial all fall out consistently. Pre-alpha 0.0.1 is six well-bounded slices ending in a terminal you'll actually daily-drive, with the bus and orchestrator deferred just far enough to ship them right. Answer §10 and I'll turn this into the executable build plan (slice-by-slice, with the Playwright torture tests) and we start wiring Slice 1.
