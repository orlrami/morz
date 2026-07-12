# Morz — Build Breakdown

*Everything that will be built, by phase → module → feature. Depth for each item lives in `MORZ-Research-and-Vision.md`; sequencing rationale in `MORZ-Build-Plan.md`.*

Phases are ordered by **what unblocks daily use fastest** (personal-first, not market-shippability). Each phase ends usable on its own.

---

## Principles (apply to everything)

- **Assist, don't take over** — Manual mode (a plain great terminal) is first-class; orchestration is an opt-in toggle, scoped to what you point it at, reversible and visible.
- **Own the PTY** — ConPTY on Windows via node-pty, in a dedicated PTY-host process; never depend on tmux.
- **Structured over scraped** — drive CLIs via their real protocols; PTY keystroke injection only as fallback.
- **Agent messages are untrusted** — an agent can never approve a permission for another.
- **Isolation = git worktree per agent** + a `$PORT` from a pool; serialize git writes.
- **Local-first & open** — no login wall, BYO keys, self-hostable; E2E-encrypt anything leaving the machine.
- **Reversible & legible** — every agent action checkpointed and attributable; nothing auto-merges without a green Definition-of-Done.

---

## Phase 0 — Design (Figma)  ·  *in progress*

- **Design system**: tokens (graphite/quartz/bronze, status, per-agent, radius, spacing, type), components (buttons, status pills, badges, tabs, input, command-palette, agent row, card, bus event, plan/DAG row, pane header). Pick a warm humanist UI font.
- **Screens**: desktop shell · spaces sidebar (with the mode dial) · orchestrator panel/blackboard · terminal pane w/ blocks · ctrl-click side preview · pop-in file explorer · LazyGit commit UX · in-app browser + element-pick · phone mission-control · command palette · settings.
- Integrate reference images → lock the UI → export tokens (already mirrored in `src/renderer/src/theme/tokens.css`).

## Phase 1 — Terminal core  ·  *replace Herdr for solo work*

- **Electron multi-process**: main + dedicated **PTY-host** subprocess + renderer; typed preload IPC.
- **PTY layer**: node-pty (ConPTY, flow control, UTF-8), ring-buffer scrollback + ANSI-stripped view, keystroke injection.
- **Terminal UI**: xterm.js + webgl; command **blocks**; copy-on-select / double-click-copy; ctrl-scroll zoom.
- **Layout**: split-tree via dockview + right-click-split; **pop-in/out** file explorer (dockview popout + chokidar).
- **Ctrl/Cmd-click path → side preview** (CodeMirror read-only; verify-on-disk; `file:line:col`; `morz://` OSC-8 links).
- **Spaces sidebar** (manual: project + branch + cwd via PowerShell/CMD/WSL prompt hooks).
- **cmd-K palette** skeleton · **session + cwd restore** (`addon-serialize` + SQLite) · **zero-config onboarding** (import `~/.claude`, `.codex`, `.mcp.json`, `AGENTS.md`).
- **Control gate**: all of the above works with orchestration OFF.

## Phase 2 — Orchestration (opt-in)  ·  *the reason Morz exists*

- **Agent-adapter interface** (`stdin JSON → NDJSON events → permission callbacks → interrupt`) + per-CLI adapters: Claude (stream-json/SDK), Codex (`exec --json` + stdin-close fix), agy (PTY), OpenCode (serve+SDK), Pi (RPC).
- **Isolation**: spawn agents in git worktrees + `$PORT` pool; per-agent sandbox/permission presets.
- **Agent-state sidebar**: per-agent state (working/blocked/idle/done), model-in-use, CLI-in-use, branch/PR.
- **Orchestrator** (side panel + terminal): NL intent → **propose plan → you approve → spawn** (scoped); structured launch prompt per agent; pill-bar + lanes.
- **Message bus**: atomic-rename file mailbox + socket/named-pipe push + shared task board (atomic claim). Replaces the manual markdown handoff. Side panel = the live blackboard.
- **Routing**: rules table (`math → agy/Gemini`, `review → Codex`) + classifier fallback + `consult(brain, question)` primitive.
- **Morz MCP server** (stdio): exposes `post_to_blackboard`, `read_pane`, `open_file_in_preview`, `claim_task`, `consult`, …
- **Notifications**: normalized cross-agent event stream → desktop toast.

## Phase 3 — Quality & git  ·  *trust the output*

- **Cross-model adversarial review** by default (non-author brain refutes the diff).
- **Dependency DAG + wave execution** (visual, editable); **Definition-of-Done** executable checks (done only when green).
- **Review → fix → test loop**, bounded (~3) then escalate to you.
- **LazyGit-style commit UX**: unstaged/staged split, click-to-stage hunks, drag-select lines, commit variants (commit / in-editor / `--no-verify` / amend), gitui-fast async; **AI commit messages** (staged diff, conventional/plain/gitmoji, local-Ollama option); diff-first review.
- **Own reviewer** (embed OSS Qodo PR-Agent or BYO): inline gutter comments + apply-fix / send-to-agent; verification gate; caller/callee context.
- **Checkpoints** (shadow-git per worktree) + `/rewind`; **cross-agent cost/token dashboard** + budget caps; replayable event log; per-agent metrics.

## Phase 4 — Design workflow: in-app browser + element-pick

- Embedded browser (BrowserView + `webContents.debugger` CDP); localhost auto-detect + HMR.
- **Pick element → ElementContext** (a11y ref + selector + curated styles + cropped screenshot + console/network + optional `data-morz-loc` source location via a Morz Vite/Babel plugin).
- **Shared browser surface** (loopback CDP proxy) so the assigned agent drives the page you're watching.
- Split routing: element image+styles → Gemini/agy (design critique); source-loc+HTML → Claude/Codex (edit).

## Phase 5 — Remote access  ·  *untether*

- **`morzd`** headless daemon; outbound-only relay (works behind NAT); **E2E encryption** (sshx-style).
- **PWA + mobile**: multi-agent mission-control feed; streaming tool calls + diffs; **Approve/Deny/Interrupt from the lock screen** (batched); push on blocked/done.
- **Tailscale Serve** default; Cloudflare Tunnel + Access for internet; SSH/`sshx` fallback. Cloud-execution handoff later.

## Phase 6 — Productivity layer

- Full **cmd-K** (typed filters `agent:` `skill:` `mcp:` `env:` `spawn:`); **skill/prompt/command Library** (per-agent target); **dynamic secrets** (store retrieval command, never the secret; scoped per agent); **MCP manager GUI**; unified **AGENTS.md rules editor**; **scheduled/background team routines** + morning digest; **hook/automation builder**; **local Whisper push-to-talk**; **squad presets**.

## Future — "the additions" (after core)

- **Cross-agent memory** — Honcho-style: a memory service + an MCP endpoint every CLI reads/writes + a thin per-CLI plugin ("read this memory"). Scoped global/project/space/agent.
- **Plugin / add-on marketplace** — curated catalog (ingest Official MCP Registry + Smithery + stars), one-click add, per-CLI installer adapters (writes `.mcp.json` / `config.toml` / `gemini extensions` / `opencode.json`), owner-curated recommendations, trust-gated. Ships Caveman / Ponytail / Code Time / academic-research add-ons.
- **Morz app plugin system** — extend Morz itself (panes/views/commands/themes).

---

## Cross-cutting systems

- **Control dial** (`orchestrationStore.mode`): manual | assisted | orchestrated. Sidebar/blocks/agent metadata/bus/blackboard render only above manual. Disabling reverts to a plain terminal, state preserved.
- **Theming**: tokens as CSS variables (`theme/tokens.css`); import base16/iTerm/VS Code/Ghostty themes via a mapper.
- **Security/trust**: untrusted-agent message boundary; per-agent permission presets; secret isolation; sandboxed plugins (marketplace).

## How the agent network divides this

Each phase's modules are independent enough to hand to separate build agents, each in its **own git worktree** (Phase-1 PTY-host, terminal-UI, sidebar, preview, layout can go in parallel; Phase-2 adapters are one-per-CLI). Serialize merges to `main`. Reviewer agent (different model than author) gates each merge.
