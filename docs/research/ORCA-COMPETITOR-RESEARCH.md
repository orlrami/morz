# Orca (onorca.dev) — Deep Competitor Research

**Researched:** 2026-07-28
**Subject:** Orca ADE by Stably AI (`github.com/stablyai/orca`)
**Why it matters to Morz:** Orca is the closest competitor to Morz that exists — an Electron desktop app that orchestrates CLI coding agents in parallel git worktrees, with an xterm.js terminal, cross-platform including Windows. It is **MIT open source**, so unlike every other competitor, its entire implementation is readable.

---

## 1. Verdict / TLDR

1. **Orca is Morz's direct competitor, and it is far ahead.** Same core thesis (run many CLI coding agents in parallel, one per git worktree, in a real terminal, on the desktop). 31,042 GitHub stars, 7,447 commits, ~2,437 open issues, created **2026-03-17** — roughly four months old and shipping multiple releases per week (current `1.4.160-rc.3`).
2. **It is MIT open source and free.** No pricing page. Monetization is an "email us" enterprise motion only (`jinjing@stably.ai`). The parent company monetizes a *separate* product (Stably, AI E2E testing).
3. **Stack is nearly identical to Morz's**: Electron 43 + electron-vite + React 19 + TypeScript + Tailwind 4 + shadcn/radix + zustand + xterm.js (WebGL addon) + node-pty + Monaco. If Morz had a "we chose right" validation, this is it — and it also means Morz has no stack-level differentiation.
4. **They solved agent outcome detection with OSC title sequences**, not output scraping — Claude Code, Codex and others already emit terminal title updates that encode working/idle. This is a small, robust mechanism that Morz should adopt immediately (see §4.1). It is also their documented extension point for custom agents.
5. **They additionally install "managed hooks"** into the agent's own config (`.claude/`, `.codex/`) that call back into a local Orca hook server, with the endpoint persisted to disk (`endpoint.env` / `endpoint.cmd`) so it survives restarts. That is the deeper channel behind status, interactive-question detection, and attribution.
6. **A background daemon owns the PTYs.** Closing the Orca window does not kill Claude Code. On relaunch it warm-reattaches. This is an architectural decision Morz has not made and it underpins their session restore, hibernation, mobile, and remote-server stories.
7. **Their orchestration layer is a real message bus**, not a dispatch loop: tasks, dispatches, `worker_done` messages, escalations, decision gates, heartbeats, and an automatic coordinator (`orca orchestration run --max-concurrent 3`). This is precisely the feature Morz's orchestrator is failing at today.
8. **Windows is supported but visibly their weakest platform** — open issues cover Smart App Control blocking unsigned binaries, agent sessions not restoring after auto-update on Windows, `powershell.exe not found` when driving Linux remotes, and WSL CLI launch failures. **This is Morz's opening.**
9. **Their differentiators beyond the terminal**: Design Mode (click a DOM element in an embedded Chromium, ship HTML+CSS+cropped screenshot to the agent), a mobile companion (iOS App Store + Android APK) with direct desktop pairing and no cloud relay, SSH/remote worktrees, `orca serve` headless mode, and Computer Use (agents drive native desktop apps via accessibility trees).
10. **Strategic read for Morz:** do not try to out-feature Orca. Out-execute them on Windows-native quality (no WSL dependency, signed binaries, PowerShell-first), and on the "assist, don't take over" control philosophy — Orca is built for people running "10 to 100 coding agents at once," which is a different user than Morz's.

---

## 2. Product

### 2.1 Positioning

- Calls itself an **ADE — "Agent Development Environment"** — deliberately not an IDE. Tagline on site: *"Ship 100x With The Agent IDE"*; README: *"The AI Orchestrator for 100x builders."*
- Repo description: *"Orca is the ADE for working with a fleet of parallel agents. Run any coding agent with your own subscription. Available on desktop, mobile and VPS."*
- Explicit non-goals from their docs: not an AI model provider, not a git replacement, not a cloud VPS product.
- Target user (their words, via YC/docs): engineers running **10 to 100 coding agents at once**, who care about diff review and commit hygiene, using **their own subscriptions** (BYO Claude/Codex plan — no double billing).

### 2.2 Core model

- **Worktree is the unit of work.** "Every task gets its own on-disk copy of the repo via `git worktree`." Each repo has a base ref (typically `origin/main`); each worktree branches from a chosen start-from ref and owns its own files, branch, agent terminals, and browser tab.
- Worktree creation is **asynchronous** — the dialog closes immediately, `git fetch` + worktree creation continue in the background with progress in the sidebar, and it is cancellable from an in-tab panel.
- Branch names auto-derive from workspace name or a linked issue (GitHub / Linear / Jira / GitLab). Advanced option for explicit naming.
- Sidebar groups worktrees by project, supports pinning, inline rename (double-click), filtering, and multi-select batch operations.
- These are **real git worktrees** — `git rebase`, `git cherry-pick`, etc. work normally from any shell.
- Lifecycle: create → work → review diff → commit/push/PR → archive or delete.

### 2.3 Agent / session model

- An **agent session** = one CLI agent, in one terminal, in one worktree.
- Four visible states on the terminal tab: **green pulsing** (working / non-idle TUI), **yellow** (waiting for input), **gray** (idle), **no dot** (plain shell, not an agent).
- Documented progression: Launch → Work → Idle → Exit. Notification fires on working→idle ("agent-finished").
- **Agent hibernation**: idle background agents are suspended to reclaim resources ("each one is a live PTY holding a model session in memory"). Conditions — all must hold: last turn finished, not awaiting input, terminal not visible in any worktree, no keystrokes since completion, agent supports resumable sessions (Claude, Codex, Gemini, Antigravity, OpenCode, Droid, Grok), idle past threshold (default 30 min, configurable 1 min–24 h), and no mobile session controlling it. Resume relaunches via e.g. `claude --resume <id>`, restoring conversation, cwd, provider session, original launch command/args/env.
- **Session restore**: open worktrees, per-worktree pane layout including nested splits, focused tab, and full scrollback are persisted. A **background daemon owns the PTYs**, so quitting the window (or an auto-update) doesn't kill the agents — relaunch does a "warm-reattach to the same processes." After a machine reboot or daemon crash, layout and last-persisted scrollback return but agent processes are gone.

### 2.4 Supported agents

30+, and "any CLI agent — if it runs in a terminal, it runs in Orca." Explicit list includes: Claude Code, Codex, Cursor CLI, Grok, Gemini, GitHub Copilot CLI, OpenCode, Amp, OpenClaude, Antigravity, Pi, oh-my-pi, Hermes Agent, Goose, Auggie, Charm, Cline, Codebuff, Command Code, Continue, Devin, Droid, Kilocode, Kimi, Kiro, Mistral Vibe, Qwen Code, Rovo Dev, GLM, MiniMax, Mimo. (Confirmed by per-agent directories in `src/main/` — see §3.3.)

**Custom agents**: Settings → Agents → "Add custom agent" — name, binary path or command, default arguments, and an optional startup hook (shell command run before launch, e.g. `source .envrc`). State detection is opt-in via OSC titles: *"If your agent outputs titles like `working` or `idle`, Orca automatically displays state indicators. Without this, the tab is still a fully functional terminal, just without a live state dot."*

### 2.5 Terminal

- **"The same xterm.js-based terminal VS Code uses, with a few additions tuned for AI-agent workflows."** Marketing calls it "Ghostty-class terminals with WebGL rendering."
- Tabs + splits (side-by-side and stacked, nested). Infinite splits. Scrollback survives restarts.
- Find-in-scrollback (`Cmd-F`) with highlight, case sensitivity, regex, next/prev.
- **"Copy Context"** — extract a bounded transcript from a pane (explicitly framed as an alternative to forking Orca).
- **kitty keyboard protocol** support → real Shift+Enter / Ctrl+Enter to agent TUIs. JIS keyboard / macOS Yen remapping.
- Theming: built-in library plus **import of Ghostty and Warp themes**.
- Windows: shell selection between PowerShell, Command Prompt, and WSL (docs recommend PowerShell).
- Floating terminal panel as a global always-available shell; "Quick Commands" for frequent commands and agent prompts.

### 2.6 Review & ship

- **Diff viewer**: diffs against the worktree's start-from ref by default; comparison scope adjustable to any commit/branch/base ref. Line numbers both sides, optional word wrap (off by default), image diffs with **side-by-side / swipe / onion-skin** modes, and a three-way merge-conflict UI with inline resolution.
- **Staging by hunk or line** — "same as `git add -p` but visual" (`s` key). Commit and push from inside Orca.
- **Annotate AI Diff**: drop markdown comments on diff lines (`c`), batch them, and send back to the agent.
- **Attribution**: Orca records the line ranges an agent writes (via its tooling layer / hooks). Agent-authored lines get a subtle gutter marker in the diff. If a human edits those lines, attribution flips back to human. Attribution is **local only — never written into git commits** — but diff metadata can be exported from the diff toolbar.
- **Hosted integrations**: GitHub (PRs, issues, Actions, Projects), Linear items drawer, Jira items drawer; also GitLab, Gitea, Bitbucket, Azure DevOps modules present in source.

### 2.7 Editing

Monaco editor with autosave, quick-open, drag-drop from OS. Rich markdown editor (TipTap). Mermaid, PDF (pdfjs), and image viewers. File explorer with external drag-drop.

### 2.8 Browser & Design Mode

- Per-worktree embedded Chromium browser.
- **Design Mode**: toolbar toggle turns the cursor into an element picker with hover highlighting. Clicking captures **outer HTML + surrounding DOM context, computed CSS (colors/fonts/spacing), a cropped screenshot of the element, and the source file path + line number when dev-mode source maps exist** — then ships all of it into the active agent terminal as **one attachment**. Agent edits source → hot reload → re-inspect to verify.
- Browser-use profiles (persisted browser identities/sessions).

### 2.9 Remote / deployment modes

Four documented "ways to run":

1. **Local desktop** — UI, agents, terminals, browser all on one machine.
2. **SSH targets** — laptop UI drives an SSH host; "agents and `git worktree` run on the remote; the editor, diff, and UI stay on your laptop." Auto-reconnect and port forwarding.
3. **Remote Orca Servers** — true client/server. One machine runs the desktop app *or* the headless daemon `orca serve`; laptop / web / mobile / automation clients connect via revocable per-client pairing tokens. "The server owns projects, worktrees, terminals, and agent processes; clients are the UI." Agents survive client disconnect.
   - `orca serve --pairing-address 100.64.1.20`
   - `orca serve --port 6768 --pairing-address 100.64.1.20`
   - `orca serve --pairing-address 100.64.1.20 --mobile-pairing`
   - Recommended transport is **Tailscale** (the `100.x.y.z` addresses), or trusted LAN / SSH forwarding / authenticated tunnels. Docs explicitly warn against exposing the port to the public internet.
4. **Per-workspace environments** — each worktree gets an ephemeral sandbox (VM, Docker, or cloud sandbox) via provider scripts declared in `orca.yaml`; connected through Remote Server or SSH mode. (Source confirms: `src/main/ephemeral-vm-recipe-runner.ts`, `ephemeral-vm-runtime-service.ts`, `ephemeral-vm-runtime-ssh.ts`, `src/main/sandbox/`, `src/main/vm/`.)

### 2.10 Mobile companion

- iOS (App Store id6766130217 + TestFlight) and Android (APK via GitHub releases, currently `mobile-android-v0.0.32`). Built with Expo (per changelog).
- **Desktop is the source of truth; phone is a "read-mostly" remote control.** Code, shells, and agents all stay on the desktop.
- **Pairing is a one-time alphanumeric code** (not QR), exchanged **directly between desktop and phone — no cloud relay.** Produces a device token for that phone. Closing the desktop app ends the connection; reopening auto-reconnects.
- From the phone: watch worktree/agent status, browse the full file tree and open any file, read terminal scrollback and reply (text, photo, or dictation), review and stage/commit changes, switch agent accounts, check usage limits, create workspaces, view responsive browser layouts.
- Push notifications when an agent finishes, mirroring desktop.

### 2.11 Notifications & Inbox

Fires on **working → idle** transition (framed as real completion, not a pause). Channels: OS notification, custom sound, worktree chips, and a persistent header bell with unread counts across all worktrees (macOS Dock badge too). Clicking a notification jumps to the exact worktree and pane. Right-click to mark unread for later triage. Custom sounds per category (system / sound / chip-only) in MP3, WAV, OGG, M4A, AAC, FLAC with independent volume.

### 2.12 CLI, orchestration, automations

The `orca` CLI scripts a *running* Orca editor from any shell — worktrees, agent terminals, files/diffs, the built-in browser, scheduled automations, and Orca-native tools. It is explicitly designed to be called **by agents**, not just humans.

**Orchestration primitives** — "a shared inbox, task records, dispatch state, worker completion messages, and decision gates so a coordinator can fan work out and know what finished":

- **Messages** typed `status`, `dispatch`, `worker_done`, `escalation`, `decision_gate`, `heartbeat`.
- **Tasks** with statuses `pending`, `ready`, `dispatched`, `completed`, `failed`, `blocked`.
- **Dispatch** — assignment of a task to a terminal, retryable with fresh context.
- **Decision gates** — coordinator-owned blocking questions.

Verbatim examples from their docs:

```bash
orca status --json
orca terminal list --json
orca orchestration task-list --json

orca orchestration send --to @all  --subject "Update" --body "Message"
orca orchestration send --to @idle --subject "Available?"
orca orchestration send --to @codex --subject "Codex agents only"

orca orchestration task-create \
  --task-title "Audit billing mobile" \
  --spec "Audit the billing settings page for mobile layout bugs..."

orca worktree create --name audit-worker --agent codex
orca terminal wait --terminal <handle> --for tui-idle --timeout-ms 60000

orca orchestration dispatch --task <taskId> --to <workerHandle> --inject

orca orchestration check \
  --wait \
  --types worker_done,escalation,decision_gate \
  --timeout-ms 900000

orca orchestration send \
  --to <coordinator> \
  --type worker_done \
  --subject "Completed audit" \
  --body "Fixed footer overlap in src/app/settings/Billing.tsx" \
  --task-id <taskId> \
  --dispatch-id <dispatchId>

orca orchestration run \
  --spec "Split checkout QA across agents, collect results, summarize blockers" \
  --max-concurrent 3 \
  --worktree active
orca orchestration run-stop

orca orchestration gate-create \
  --task <taskId> \
  --question "Merge the shared button change?" \
  --options '["yes","no"]'
orca orchestration gate-resolve --id <gateId> --resolution "yes"
```

Guidance they give agents on which to use: `orca terminal send` for lightweight prompts; `orca orchestration dispatch --inject` when the worker must be tracked and must report completion; `orca orchestration run` when Orca itself should own the coordinator loop.

**"Worktree checkpoints" are not what the name suggests** — they are a free-text **comment field** on each worktree, a status snapshot agents update themselves:

```bash
orca worktree set --worktree active --comment "message" --json
```

No git stash/commit/ref involved, no rollback, no retention policy. It's a human-readable status channel, not version control. (Real rollback in Orca is just… git.)

**Computer Use** (beta) — agents drive native desktop apps via accessibility trees + screenshots:
`orca computer list-apps`, `get-app-state`, `click`, `set-value`, `type-text`, `press-key`, `hotkey`, `paste-text`, `scroll`, `drag`. Requires OS Accessibility permission (plus Screen Recording on macOS) granted to a separate "Orca Computer Use" helper; validated via `orca computer permissions --json`. Docs push semantic actions over raw keystrokes, and secrets via `--value-stdin` / `--text-stdin` to keep them out of shell history.

**Skills registry + MCP**: skills are "versioned packages an agent can install into its own skill directory," installed with e.g. `npx skills add https://github.com/stablyai/orca --skill orca-cli`. Default set is `orca-cli`, `computer-use`, `orchestration`; optional `orca-linear`, `orca-emulator` (iOS Simulator control). Separately, MCP servers are registered in Settings → Integrations → MCP and their tools appear inside agents that support MCP.

### 2.13 Platforms, install, licensing

| Platform | Distribution |
|---|---|
| macOS ARM64 + Intel | DMG; `brew install --cask stablyai/orca/orca`; signed **and notarized** |
| Windows | `.exe` installer (electron-builder NSIS; `electron-builder-squirrel-windows` also present); code-signed via **SignPath.io** |
| Linux | AppImage + `.deb`; AUR `yay -S stably-orca-bin` |
| iOS | App Store + TestFlight |
| Android | APK from GitHub releases |

Auto-update on a stable channel by default; RC builds ship near-daily and require Shift-click on "check for updates" or a manual download. Downgrades don't destroy worktree data. **MIT licensed, free, no pricing page.**

---

## 3. Tech stack — evidence

All of this is **verified from `package.json` and the repo tree**, not inferred.

### 3.1 Runtime dependencies (verbatim)

```
@electron-toolkit/preload ^3.0.2      @electron-toolkit/utils ^4.0.0
@floating-ui/dom 1.7.6                @linear/sdk ^82.1.0
@parcel/watcher ^2.5.6                @xterm/addon-serialize 0.15.0-beta.287
@xterm/headless 6.1.0-beta.287        agent-browser ~0.27.0
electron-updater ^6.8.9               i18next ^26.3.1
jsonc-parser ^3.3.1                   node-pty ^1.1.0
posthog-node ^5.33.3                  qrcode ^1.5.4
react-i18next ^17.0.8                 serve-sim ^0.1.40
sherpa-onnx 1.12.37                   ssh2 ^1.17.0
tweetnacl ^1.0.3                      ws ^8.21.0
yaml ^2.8.4                           zod ~4.4.3
```

Notable reads:
- **`@xterm/headless`** in *main* process — they run a headless xterm instance server-side to maintain authoritative terminal buffers (needed for scrollback persistence, remote/mobile clients, and `--for tui-idle` detection). Morz does not do this.
- **`sherpa-onnx`** — on-device speech recognition. That's the mobile/desktop **dictation** feature, running locally.
- **`tweetnacl`** — the pairing/device-token crypto for mobile and remote clients.
- **`ssh2`** — SSH worktrees implemented in-process, not by shelling out.
- **`posthog-node`** — product analytics (they have a Privacy & Telemetry doc).
- **`agent-browser`, `serve-sim`, `@stablyai/playwright-test`** — their own packages (npm page 403'd to WebFetch; ownership inferred from the `@stablyai` scope and usage pattern).

### 3.2 Dev/build stack (verbatim highlights)

```
electron ^43.1.0                electron-vite ^5.0.0
electron-builder ^26.15.3       electron-builder-squirrel-windows ^26.15.3
react ^19.2.7 / react-dom       typescript ^7.0.2 (+ typescript-api: npm:typescript@6.0.3)
vite: npm:rolldown-vite@7.3.1   vitest ^4.1.5
@playwright/test ^1.59.1        @stablyai/playwright-test ^2.1.14
tailwindcss ^4.2.4              radix-ui ^1.6.2 / shadcn ^4.13.1
zustand ^5.0.14                 monaco-editor ^0.55.1 / @monaco-editor/react
@tiptap/* ^3.22                 mermaid ^11.15 / katex / pdfjs-dist ^5.7
oxlint ^1.75.0 / oxfmt ^0.52.0  husky + lint-staged
@xterm/xterm 6.1.0-beta.287     @xterm/addon-webgl 0.20.0-beta.286
@xterm/addon-search / -fit / -ligatures / -unicode11 / -web-links
vscode-oniguruma + vscode-textmate   (TextMate syntax highlighting)
@tanstack/react-virtual         @dnd-kit/core + sortable
lucide-react, cmdk, sonner, dompurify, html-to-image, react-grab
```

- **Node 24**, **pnpm 10.24.0**, arch matrix x64 + arm64 across mac/linux/win.
- **Patched dependencies (pnpm patches):** `node-pty@1.1.0`, `@xterm/addon-ligatures`, `@xterm/addon-webgl`, `@xterm/addon-serialize`, `@xterm/xterm`. They are shipping **custom patches to node-pty and to xterm core + WebGL renderer** — i.e. upstream wasn't good enough for their terminal fidelity/perf targets.
- They are on **beta xterm 6.1.0-beta.287**, not stable 5.x.
- **oxlint/oxfmt** (Rust-based) instead of ESLint/Prettier, and **rolldown-vite** instead of stock Vite — aggressive on toolchain speed.
- `electron.vite.config.ts` is 12 KB — a heavily customized multi-entry build.

### 3.3 Repo structure

Top level: `.github`, `.husky`, `Casks` (Homebrew), `build-plugins`, `config`, `docs`, `examples`, `mobile`, `native`, `resources`, `skill-guides`, `skill-stubs`, `skills`, `src`, `tests`, `tools`. Root files include `AGENTS.md`, `CLAUDE.md` (11 bytes — almost certainly just a pointer to AGENTS.md), `orca.yaml`, and two enormous design docs: **`ORCHESTRATION_IMPLEMENTATION_CHECKLIST.md` (107 KB)** and `ORCHESTRATION_STRUCTURED_OUTPUT_DESIGN.md` (25 KB).

`src/` splits into **`cli`, `main`, `preload`, `relay`, `renderer`, `shared`, `types`** — note `relay` as a first-class peer of main/renderer.

**`src/main/` has ~150 subdirectories.** Per-agent modules confirm the integration depth: `claude`, `claude-accounts`, `claude-usage`, `codex`, `codex-accounts`, `codex-cli`, `codex-usage`, `cursor`, `copilot`, `gemini`, `grok`, `grok-accounts`, `opencode`, `opencode-usage`, `amp`, `antigravity`, `devin`, `droid`, `hermes`, `kimi`, `minimax`, `mimo`, `openclaude`, `pi`, `qwen`, `command-code`.

Platform/infra modules of direct interest to Morz:
- `pty`, `terminal`, `terminal-registry`, `shell`, `shell-detection`, `shell-integration`, `xterm-shell-integration`, `ghostty`
- `powershell-osc133-bootstrap.ts`, `pwsh.ts`, `git-bash.ts` (Windows shell handling)
- `pty-descendant-termination.ts` (killing the whole process tree — the exact Windows problem Morz hit)
- `agent-state-file-reader.ts`, `agent-awake-service.ts`, `agent-auth-restart-preservation.ts`, `agent-trust-presets.ts`
- `durable-file-write.ts` (+ a `durable-file-write-syscall-proof.test.ts`), `persistence.ts`
- `local-worktree-removal-recovery.ts`, `local-worktree-filesystem.ts`
- `macos-system-sleep-assertion.ts`, `windows-system-sleep-assertion`, `linux-lid-sleep-assertion.ts` — they explicitly **prevent the machine sleeping while agents work**
- `daemon`, `relay`-adjacent `transports`, `tunnels`, `tunnel-service`, `remote`, `remote-ssh`, `remote-ssh-edit`, `ssh`, `ssl`, `web`, `webview`
- `sandbox`, `vm`, `volume-mounts`, `emulator`, `computer`, `screenshot`, `snapshot`
- `memory`, `usage`, `telemetry`, `observability`, `crash-reporting`, `diagnostics`, `triage`
- `typescript-lsp`, `search`, `secrets`, `ai-vault`, `keybindings`, `themes`, `i18n`, `plugins`, `providers`, `runners`, `runtime`, `runtime-config`, `suggestions`, `suggestion-refinement`, `status-bar`, `welcome`, `user-research`, `zendesk`

`src/pty/` internals show the depth of shell-env work: `shell-startup-env.ts` (7 KB), `windows-environment-path.ts` (9.4 KB!), `wsl-orca-env.ts`, `codex-home-wsl-env.ts`, `appimage-terminal-env.ts`, `posix-pty-process-groups.ts`, `terminal-color-env.ts`, `powerlevel10k-wizard-env.ts` (they special-case p10k's first-run wizard), `omp-shell-wrapper.ts` + `omp-sqlite-overlay.ts` (oh-my-posh handling with a SQLite overlay).

`src/relay/` is ~180 files: `dispatcher`, `protocol`, `pty-handler`, `fs-handler`, `git-handler` (+ `git-status-output-parser`, `git-response-stream`), `agent-exec-handler`, `agent-hook-server`, `preflight-handler`, `port-scan-handler`, `external-automations-handler`, `plugin-overlay`, `fs-stream-registry`, `managed-hook-installer`, `pty-shell-utils`. This is the **server half** that both the local daemon and remote/mobile clients talk to.

### 3.4 Engineering conventions (from `AGENTS.md`)

- UI must follow `docs/STYLEGUIDE.md` and use tokens from `src/renderer/src/assets/main.css`; use shadcn primitives, never invent color/size/shadow values.
- **Never disable the `max-lines` lint rule or raise per-file limits.** No generic filenames (`helpers`, `utils`, `common`) — name modules after the domain concept (`tab-group-state.ts`). Prefer `.ts` type declarations over `.d.ts`.
- Cross-platform is a hard rule: runtime platform checks for `metaKey` vs `ctrlKey`, `⌘`/`⇧` vs `Ctrl+`/`Shift+` in labels, always `path.join`, and a **glibc 2.31 floor (Ubuntu 20.04)** for Linux native modules.
- **Git 2.25 is the compatibility baseline**; they maintain a `GitCapabilityCache` for unsupported subcommands rather than parsing version strings, scoped per host (native / WSL / SSH), and preserve global `-c` options before subcommands.
- Provider-neutral: GitLab and others are first-class; no GitHub-only naming.
- Explicitly support **folder workspaces, not just git worktrees**, and respect `gh` CLI rate limits by batching.
- Worktree safety rule for their own agents: always read/edit from the primary working directory; never follow absolute paths from subagent results back into the main repo.

---

## 4. How they solved the problems Morz cares about

### 4.1 Agent outcome detection (done / waiting / working) — **the highest-value finding**

Two complementary mechanisms:

**(a) OSC terminal title sequences — the primary, agent-agnostic channel.**
Their docs state it directly: *"State is detected from the terminal's OSC title sequence, which Claude Code, Codex, and several other agents emit."* No output parsing, no heuristics, no screen-scraping. This maps to the four-state dot (working / waiting / idle / not-an-agent), drives completion notifications, and is exposed to the CLI as `orca terminal wait --for tui-idle --timeout-ms 60000`. It is also the documented contract for custom agents: emit a title containing `working` or `idle` and you get state indicators for free.

**(b) Managed agent hooks calling back into a local Orca server — the deep channel.**
`src/main/agent-hooks/` contains a **79.9 KB `server.ts`** (with a 238 KB test file) plus `installer-utils.ts` (13.7 KB), `managed-hook-installer`, `managed-hook-install-lock`, `managed-hook-lock-claims`, `managed-hook-owner-identity`, `managed-hook-timeout`, `managed-hook-stdin-lifecycle`, and `hook-stdin-contract.ts`. Orca **installs its own hooks into the agent's own config** (`.claude/`, `.codex/`) and runs a local HTTP server the hooks POST to over stdin contract. Per the docs, the hook endpoint is persisted to disk — **`endpoint.env` on POSIX, `endpoint.cmd` on Windows** — and re-sourced on every hook invocation so agents keep reaching a live Orca server across app restarts.

Two revealing test files: **`server.claude-interactive-question.test.ts`** (they detect when Claude is asking the user a question — that's the yellow "waiting for input" state) and **`server-claude-statusline.test.ts`** (they hook Claude Code's **statusLine** feature as a data channel). `server-grok-discovery.test.ts` shows per-agent discovery paths. `agent-status-pane-index.ts` maps status back to the specific pane.

Also: `agent-state-file-reader.ts` in `src/main/` — reading agent-maintained state files on disk.

They also **respect the user's existing hooks**: Orca reads `.claude/` and `.codex/` hook configs and runs them when agents launch, and explicitly leaves `CLAUDE.md` / `AGENTS.md` alone — *"they belong to the agent."* Separate worktree setup hooks live in Settings → Repository → Hooks (for `npm install`, restoring env vars, etc.).

> **Morz takeaway:** Morz's #1 open bug is "orchestrator dispatches but agent never executes / no pane wakes." Orca's answer is layered: OSC title for cheap universal state, `--for tui-idle` as an explicit CLI wait primitive, and installed hooks for high-fidelity events. Adopting the OSC title reader is small and would immediately give Morz working/waiting/idle without touching the orchestrator.

### 4.2 Cost / usage metering

**They read the agents' own on-disk bookkeeping — no API calls, no extra auth.** Docs: local usage state "under `~/.claude`, `~/.codex`, and the Gemini/OpenCode equivalents." Consequence they call out honestly: metrics only update when the agent writes them, so it is not real-time.

Status bar shows usage for the active account's plan and time-to-reset across **5-hour, daily, weekly, and Claude Fable weekly** windows, with a warning at **80%** of any limit. Tracked for Claude Code, Codex, Gemini, OpenCode, Kimi Code, MiniMax. Other configured accounts show their own usage in the account switcher. Source confirms dedicated `claude-usage`, `codex-usage`, `opencode-usage`, and `usage` modules.

**Multi-account hot-swap** is a headline feature: switch Claude or Codex accounts in one click, with Orca holding the in-progress switch behind a guard "so you don't trigger overlapping auth refreshes." `agent-auth-restart-preservation.ts` preserves auth across restarts.

### 4.3 Multi-agent supervision UI

- Per-tab state dots (green pulsing / yellow / gray) with agent identity.
- Live agent status in the **sidebar** (changelog v1.3.41, May 7 2026: "See every agent's live status, right in the sidebar").
- An **Agents feed** (`/docs/activity`) plus a header-bell **Inbox** aggregating unread across all worktrees, click-to-jump to the exact worktree+pane, mark-unread triage, macOS Dock badge.
- Worktree chips + custom per-category sounds.
- Mobile mirror of all of it with push notifications.
- Free-text **worktree comment** as an agent-updatable status line ("checkpoints").

### 4.4 Memory / context management

Deliberately minimal and hands-off: `CLAUDE.md` and `AGENTS.md` at repo root or nested are **left alone** — Orca surfaces and lets you edit them in the file explorer, but does not manage them. There is a `src/main/memory/` module and an `ai-vault` (credentials), but the product philosophy is that memory belongs to the agent, not the shell. Context transfer between panes is manual and explicit via **"Copy Context"**, and context *into* agents comes from Design Mode attachments and diff annotations rather than an ambient context system.

### 4.5 Checkpoint / rollback

**There isn't one, and that's a deliberate choice.** "Worktree checkpoints" are just a comment field (§2.12). Real rollback = git, and because every task is an isolated worktree on its own branch, throwing away a bad agent run is `git worktree remove`. Their answer to "the agent broke everything" is "it broke *its own* worktree; delete it and keep the one that worked." There is `local-worktree-removal-recovery.ts` for recovering from failed removals, and `durable-file-write.ts` for crash-safe persistence of Orca's own state.

### 4.6 Git integration

- Real `git worktree` throughout, compatible with external git commands.
- In-process git via a relay `git-handler` with streaming responses and a status-output parser (not shelling out to a git library binding).
- **`GitCapabilityCache`** with a Git 2.25 floor, scoped per host (native/WSL/SSH) — a genuinely thoughtful detail Morz should copy if it ever supports remote hosts.
- Visual hunk/line staging, commit, push, PR creation in-app.
- Multi-provider: GitHub, GitLab, Gitea, Bitbucket, Azure DevOps, plus Linear and Jira issue drawers.
- Branch auto-naming from linked issues; `first-work-branch-rename.ts` (13.9 KB) renames the branch after the agent's first unit of work — a nice touch: the branch gets a meaningful name once the agent knows what it's doing.

### 4.7 Windows specifically

They do real Windows work — `powershell-osc133-bootstrap.ts` (injecting OSC 133 shell-integration markers into PowerShell), `windows-environment-path.ts` (9.4 KB of PATH handling), `pty-descendant-termination.ts`, `git-bash.ts`, `windows-system-sleep-assertion`, a full `wsl-hook-relay-*` subsystem (manager, launch, link, recovery, sentinel, fs-adapter, guest plugin install), NSIS + Squirrel builders, and SignPath.io code signing.

**But it is visibly their weakest platform.** Open issues found:
- **#6487** — Windows 11 blocks the app via **Smart App Control** due to missing trusted digital signature.
- **#5626** — after auto-update on Windows, active agent sessions don't restore: floating terminal panes come back as blank shell prompts with tab titles preserved.
- **#8956** — on Windows 1.4.141, driving a Linux remote fails with `command not found: powershell.exe`, "randomly with high recurrence."
- **#9498** — `orca` CLI launched from WSL dies on a **.NET duplicate-key error** (`PATH` vs `Path` env var casing).
- **#8632** — `Project runtime requires repair before terminal spawn: wsl-unavailable`.

The pattern: Windows is a port, WSL is load-bearing, and both leak. **This is the clearest strategic opening for Morz.**

---

## 5. Business

| Fact | Value | Source |
|---|---|---|
| Company | **Stably AI** (also "Stably AI (Orca)") | YC profile |
| YC batch | **Winter 2022**, founded 2022 | YC |
| Team size | **4** on the Orca YC profile (an older Stably AI profile says 8) | YC |
| Location | San Francisco | YC |
| YC partner | Brad Flora | YC |
| CEO | **Jinjing Liang** — ex-Google Chrome senior engineer (built Chrome's testing/release infra), 2x founder, Cornell | YC |
| CTO | **Neil Parker** — ex-Uber Tech Lead (large-scale ML on Uber's Safety team), 2x founder, Cornell | YC |
| Other product | **Stably** — AI E2E testing platform (`stably.ai`); customers cited: OpenArt ($16M ARR), Tofu | YC/stably.ai |
| Orca repo created | **2026-03-17** | GitHub API |
| Stars / forks | **31,042 / 2,198** (2026-07-28) | GitHub API |
| Commits | 7,447 | GitHub |
| Open issues | **2,437** (plus ~1.3k PRs) | GitHub API |
| Watchers | 70 | GitHub API |
| Repo size | ~339 MB | GitHub API |
| Current version | `1.4.160-rc.3` | package.json |
| Changelog span | earliest visible v1.1.14 (2026-04-11) → v1.3.41 (2026-05-07); releases v1.4.147/152/160 in late July | changelog/releases |
| License | MIT | GitHub |
| Pricing | **Free.** No pricing page. Enterprise = email `jinjing@stably.ai` | onorca.dev/enterprise |
| Community | Discord `discord.gg/fzjDKHxv8Q`, X `@orca_build`, **WeChat groups 1–4 full, on group 5** | README |
| Repo topics | includes `yc-backed` | GitHub API |

**Traction read:** 31k stars in ~4.3 months is exceptional — roughly 240 stars/day sustained. Third-party reviews tracked it at ~27.4k stars on 2026-07-24, so it added ~3.6k stars in four days; growth is still accelerating, not plateauing. The WeChat groups being on their fifth overflow suggests very heavy China-market adoption. The 2,437 open issues against 7,447 commits signals they are shipping far faster than they are triaging — consistent with the reviewer's note that daily releases cause "occasional rough edges" usually fixed within 24 hours.

**Landing page social proof** claims users from Linear, Uber, Vercel, Stripe, Airbnb, Perplexity, Coinbase, Y Combinator, Instacart, GitHub, and OpenAI. Treat as unverified marketing.

**Monetization risk for them (and opportunity for Morz):** Orca has no revenue model. It is a free MIT product funded by a YC company whose actual business is a testing SaaS. Either Orca eventually grows a paid tier (and annoys its OSS base), or it stays a top-of-funnel/brand asset with 4 people supporting 2,400 open issues.

**Independent review criticisms** (andrew.ooo hands-on): ~250 MB download, **400–800 MB idle RAM**; running three parallel agents burns 3x your token quota; Linux is AppImage-only in their assessment; Android lags iOS; the mobile app is useless without the desktop running; SSH worktrees require Orca pre-installed on the target.

---

## 6. Unknowns + what a binary teardown would add

### Could not be determined from public sources

1. **Exact OSC title grammar.** Docs say "titles like `working` or `idle`" but never give the precise strings/regex per agent. This is the single most valuable unknown for Morz.
2. **The hook payload contract** — what `hook-stdin-contract.ts` actually sends/expects, and which Claude Code hook events they register (`Stop`? `Notification`? `PostToolUse`?).
3. **Whether they pass `--dangerously-skip-permissions`** or any approval-bypass flags. The Claude Code doc is silent, and there is an `agent-trust-presets.ts` module whose semantics are unclear. **This is the approval-model question and it is unanswered.**
4. **On-disk state format and location** for session/layout persistence (there's `durable-file-write.ts` and an `omp-sqlite-overlay.ts`, so SQLite is likely somewhere, but unconfirmed for the main store).
5. **What the node-pty and xterm patches actually change** — the patch files exist under `patches/` but weren't retrieved.
6. **Session-history parsing** — whether they read Claude Code's JSONL transcripts directly (there's `src/main/claude/` and an "Agent session history" doc page not fetched).
7. **Terminal renderer fallback logic** — WebGL addon is present and patched, but not what happens when WebGL is unavailable.
8. **Real DAU/install numbers, revenue, and any funding beyond the YC W22 round.** Crunchbase was not fetched.
9. **The 107 KB `ORCHESTRATION_IMPLEMENTATION_CHECKLIST.md`** — almost certainly the richest single design document about multi-agent coordination in public, and it was not read. **Highest-ROI follow-up.**
10. **Their `docs/STYLEGUIDE.md`** — their design system, referenced from AGENTS.md, not fetched.

### What a binary teardown would add (and why it's mostly unnecessary)

The user offered to download the installer. **Note that this is largely redundant: the source is MIT and fully public** — reading `github.com/stablyai/orca` gives strictly more than `app.asar` would, because the source has comments, tests, and history that the bundle does not. Only three things a binary adds:

1. **The `native/` compiled helpers** — the Computer Use accessibility helper and any Windows-specific native modules, as actually shipped and signed.
2. **Build-time configuration** — telemetry endpoints, update feed URLs, feature flags baked in at build, and the final electron-builder NSIS config (install size, per-user vs per-machine, shortcut behavior).
3. **Runtime footprint verification** — actual installed size, process count, idle RAM/CPU on Windows, and how many Electron/utility processes they spawn per worktree.

**Recommended instead of a teardown:** `git clone` the repo and read `ORCHESTRATION_IMPLEMENTATION_CHECKLIST.md`, `src/main/agent-hooks/server.ts`, `src/main/pty/`, `patches/`, and `powershell-osc133-bootstrap.ts`. That is where the transferable engineering is. (MIT license permits reading and adapting with attribution — but note Morz should make its own decision about how closely to follow a competitor's implementation.)

---

## 7. Implications for Morz (opinion, clearly labeled)

**Where Morz is behind:** orchestration reliability, agent state detection, session persistence/daemon architecture, usage metering, number of supported agents, mobile, remote/SSH, and raw shipping velocity. Orca has ~150 modules in `src/main` alone.

**Where Morz can win:**

1. **Windows-native, WSL-free.** Orca's Windows story leans on WSL and leaks (5 documented issues). Morz is Windows-first by design. Signed binaries that pass Smart App Control, PowerShell-native PTY, no WSL requirement — that is a real, defensible wedge.
2. **"Assist, don't take over."** Orca targets people running 10–100 agents. Morz's graduated-autonomy dial (manual/assisted/orchestrated) is a different, arguably larger market — developers who want control, not a fleet.
3. **Design quality.** Morz has a locked brand system (graphite/quartz/bronze). Orca is competent shadcn-default. Premium visual identity is a differentiator Orca isn't competing on.
4. **Focus.** Orca is sprawling — emulators, Zendesk, computer use, voice, VMs, mobile, six git providers, 30 agents. 2,437 open issues with 4 people. A tighter product that simply works is a viable counter-position.

**What Morz should copy immediately (cheap, high value):**
- **OSC title state detection** (§4.1a) — small, universal, unblocks the pane-wake bug.
- **Reading `~/.claude` / `~/.codex` on-disk usage state** for the status bar (§4.2) — no API, no auth.
- **`terminal wait --for tui-idle`** as an explicit orchestrator primitive rather than inferring completion.
- **A background daemon owning PTYs** (§2.3) — the architectural prerequisite for session restore, hibernation, and any future remote/mobile story. This is the biggest decision on the list and the most expensive to retrofit later.
- **Sleep assertions while agents run** — trivial, and prevents a whole class of "my agent died overnight" reports.
- **Attribution gutter markers** (§2.6) — cheap to implement via file-watch + range recording, high perceived value, and nobody else ships it.

---

## 8. Sources

**Primary (Orca / Stably)**
- https://www.onorca.dev/ — landing page
- https://www.onorca.dev/docs — What is Orca + full sidebar map
- https://www.onorca.dev/docs/model/worktrees
- https://www.onorca.dev/docs/model/agents-sessions — **OSC title state detection**
- https://www.onorca.dev/docs/model/session-restore — background daemon owns PTYs
- https://www.onorca.dev/docs/terminal — xterm.js, kitty protocol, Ghostty/Warp themes
- https://www.onorca.dev/docs/agents/supported
- https://www.onorca.dev/docs/agents/claude-code
- https://www.onorca.dev/docs/agents/custom-cli — custom agent config + OSC contract
- https://www.onorca.dev/docs/agents/hibernation
- https://www.onorca.dev/docs/agents/usage-tracking — reads `~/.claude`, `~/.codex` on disk
- https://www.onorca.dev/docs/agents/hooks-memory — `endpoint.env` / `endpoint.cmd`
- https://www.onorca.dev/docs/review/diff-viewer
- https://www.onorca.dev/docs/review/attribution
- https://www.onorca.dev/docs/browser/design-mode
- https://www.onorca.dev/docs/cli/overview
- https://www.onorca.dev/docs/cli/orchestration — full command set
- https://www.onorca.dev/docs/cli/worktree-checkpoints — comment field, not git
- https://www.onorca.dev/docs/cli/computer-use
- https://www.onorca.dev/docs/cli/skills — skills registry + MCP
- https://www.onorca.dev/docs/ways-to-run
- https://www.onorca.dev/docs/remote-servers — `orca serve`, Tailscale, pairing tokens
- https://www.onorca.dev/docs/mobile — one-time code pairing, no cloud relay
- https://www.onorca.dev/docs/notifications
- https://www.onorca.dev/docs/install
- https://www.onorca.dev/changelog
- https://www.onorca.dev/enterprise

**Source code**
- https://github.com/stablyai/orca
- https://api.github.com/repos/stablyai/orca — stars, dates, license, topics
- https://raw.githubusercontent.com/stablyai/orca/main/package.json — full dependency list
- https://raw.githubusercontent.com/stablyai/orca/main/README.md
- https://raw.githubusercontent.com/stablyai/orca/main/AGENTS.md — engineering conventions
- https://api.github.com/repos/stablyai/orca/contents/ — top-level tree
- https://api.github.com/repos/stablyai/orca/contents/src — cli/main/preload/relay/renderer/shared/types
- https://api.github.com/repos/stablyai/orca/contents/src/main — ~150 modules
- https://api.github.com/repos/stablyai/orca/contents/src/main/agent-hooks — hook server internals
- https://api.github.com/repos/stablyai/orca/contents/src/main/pty — shell env handling
- https://api.github.com/repos/stablyai/orca/contents/src/relay
- https://api.github.com/repos/stablyai/orca/contents/src/cli

**Windows issues**
- https://github.com/stablyai/orca/issues/6487 — Smart App Control blocks unsigned binary
- https://github.com/stablyai/orca/issues/5626 — Windows sessions not restored after auto-update
- https://github.com/stablyai/orca/issues/8956 — `powershell.exe not found` on remote listing
- https://github.com/stablyai/orca/issues/9498 — WSL CLI .NET PATH/Path duplicate key
- https://github.com/stablyai/orca/issues/8632 — `wsl-unavailable` runtime repair

**Business**
- https://www.ycombinator.com/companies/stably-ai-orca — batch, founders, team size
- https://www.ycombinator.com/companies/stably-ai
- https://www.stably.ai/
- https://github.com/stablyai
- https://x.com/orca_build
- https://apps.apple.com/us/app/orca-ide/id6766130217

**Third-party reviews**
- https://andrew.ooo/posts/orca-stablyai-parallel-coding-agents-ide-review/ — hands-on, RAM/size numbers, criticisms
- https://dev.to/andrew-ooo/orca-review-the-ide-built-for-parallel-coding-agents-15df
- https://www.producthunt.com/products/orca-5
- https://vibecodinghub.org/blog/orca-review
- https://vibecodinghub.org/tools/orca
- https://openllm.wavise.com/blog/orca-ade-parallel-agents
- https://dailyaiworld.com/blogs/orca-parallel-coding-agent-environment-2026

**Failed to retrieve:** https://www.npmjs.com/package/agent-browser (HTTP 403); `src/main/shell-integration` (404 — the module is `xterm-shell-integration` and/or `shell-integration` lives elsewhere in the tree).

---
---

# PART 2 — Source-Level Teardown

**Method:** shallow clone of `github.com/stablyai/orca` at `C:\Projects\_orca-ref` (2026-07-28, v1.4.160-rc.3, 10,822 files). All paths below are relative to that clone. Every claim in Part 2 is read from source, not docs.

> **LICENSE — MIT.** Reimplementation and adaptation of these designs in Morz is permitted with attribution. License text at `LICENSE`. Copying code verbatim requires retaining the copyright notice; reimplementing a mechanism from understanding does not. Recommendation: reimplement, don't copy — our PTY/session model differs enough that a port would fight us.

## P2.0 — Correction to Part 1

**Part 1 said state detection is OSC-title-driven. That is what their public docs say, and it is wrong.** The source is explicit — `src/shared/agent-status-types.ts:1-3`:

```
// ─── Explicit agent status (reported via native agent hooks → IPC) ──────────
// Why: status comes from hooks (Claude, Codex, etc.) — never inferred from terminal titles;
// a narrow interrupt fallback synthesizes a final `done` when an agent misses its cancellation hook.
```

There are **three independent channels**, in descending authority:

| # | Channel | Authority | States |
|---|---|---|---|
| 1 | **Agent hooks → local HTTP server → IPC** | Authoritative | `working` / `blocked` / `waiting` / `done` |
| 2 | **OSC 9999** — Orca's own escape sequence carrying a JSON status payload | Authoritative (same parser as #1) | same 4 |
| 3 | **OSC 0/1/2 title heuristics** | Fallback / identity only | `working` / `permission` / `idle` |

Channel 3 is a *different, coarser* state machine (3 states, not 4) used for agent **identity**, for tab labels, and as the fallback that resolves `tui-idle` waiters when hooks are unavailable. The docs conflate the two. **For Morz's wave-17 adapter seam: build channel 3 first (cheap, universal, no install), then channel 1 (accurate, needs install).**

---

## P2.1 — Agent-state detection: exact mechanics

### P2.1.1 Channel 2 — OSC 9999 (their custom sequence)

`src/shared/agent-status-osc.ts`

- Prefix constant: `const OSC_AGENT_STATUS_PREFIX = '\x1b]9999;'` (line 4).
- Terminator: **BEL (`\x07`, 1 byte) or ST (`\x1b\\`, 2 bytes)** — whichever comes first (`findAgentStatusTerminator`, lines 11-27).
- Full wire form: `ESC ] 9999 ; <JSON> BEL`
- `createAgentStatusOscProcessor()` returns a **stateful** chunk processor. It is stateful because PTY chunks split mid-sequence. Two carry-over cases:
  - **Partial prefix at chunk end** (lines 50-60): walks back up to `prefixLen-1` chars checking `tail.endsWith(PREFIX.slice(0,k))`, holds those bytes in `pending`, emits the rest as clean data.
  - **Complete prefix, no terminator yet** (lines 71-75): buffers the whole candidate in `pending`, but **drops it if it exceeds `MAX_PENDING = 64 * 1024`** — a malformed or hostile sequence cannot grow the buffer unbounded.
- Returns `{ cleanData, payloads }` — the sequence is **stripped from the terminal stream**, so it never renders. That is why they can afford a chatty status channel.
- Why it exists (comment, lines 29-33): *"hidden/model-owned terminal output needs the same agent-status parsing as mounted terminal panes, even when no terminal view is rendered."* — it works for daemon-hosted PTYs with no renderer attached.

### P2.1.2 The status payload schema

`src/shared/agent-status-types.ts`

```ts
export const AGENT_STATUS_STATES = ['working', 'blocked', 'waiting', 'done'] as const
```

`AgentStatusPayload` fields: `state` (required), `prompt`, `agentType`, `model`, `toolName`, `toolInput`, `interactivePrompt`, `lastAssistantMessage`, `interrupted`, `subagents[]`.

Hard limits, all enforced on parse (`normalizeAgentStatusObject`, line 333):

| Constant | Value | Purpose |
|---|---|---|
| `AGENT_TYPE_MAX_LENGTH` | 40 | |
| `AGENT_MODEL_MAX_LENGTH` | 120 | |
| `AGENT_STATUS_TOOL_NAME_MAX_LENGTH` | 60 | |
| `AGENT_STATUS_TOOL_INPUT_MAX_LENGTH` | 160 | preview only |
| `AGENT_STATUS_ASSISTANT_MESSAGE_MAX_LENGTH` | 8000 | "fits a multi-paragraph summary while bounding per-pane cache against a buggy/malicious agent" |
| `AGENT_STATUS_INTERACTIVE_PROMPT_MAX_LENGTH` | 16000 | full AskUserQuestion JSON — deliberately *not* truncated to a preview, "truncating would corrupt it and drop options" |
| `AGENT_STATUS_MAX_SUBAGENTS` | 32 | bounds fan-out "against a runaway spawner" |
| `AGENT_STATE_HISTORY_MAX` | 20 | rolling per-agent state log |
| `AGENT_STATUS_JSON_STRUCTURE_LIMITS` | `{structuralTokens: 4096, nestingDepth: 16}` | JSON-bomb guard, checked *before* `JSON.parse` |
| `AGENT_STATUS_STALE_AFTER_MS` | `30 * 60 * 1000` | after 30 min of silence a `working` row decays to "active" in the sidebar |

Three normalization rules worth stealing:
- `interrupted` is **coerced to `undefined` unless `state === 'done'`** (line 363) — "so it can't leak stale truth across transitions."
- `agentType` is newline-normalized so `"claude\nrogue"` cannot break single-line UI.
- **Two entry points share one normalizer**: `parseAgentStatusPayload(json)` for the OSC/HTTP path, `normalizeAgentStatusPayload(obj)` for already-deserialized IPC — "hook events can fire many times per second during a tool-use run," so they skip a JSON round-trip on the hot path.

### P2.1.3 Channel 3 — OSC title parsing

`src/shared/osc-title-extraction.ts` — a hand-rolled parser, explicitly **not a regex**: *"raw PTY chunks can include large pasted content. Parse OSC titles directly instead of running a global regex over the whole chunk."*

- Accepts OSC commands **0, 1, 2** only: `const OSC_TITLE_COMMANDS = new Set([0x30, 0x31, 0x32])` (line 6) — `ESC ] 0;`, `ESC ] 1;`, `ESC ] 2;`.
- Terminated by BEL or ST.
- `MAX_OSC_TITLE_CHARS = 1024`; over-long titles are **head+tail truncated, not clipped** (`readBoundedOscTitle`, lines 59-72): keeps the first 512 and last 512 chars, because *"trailing status words"* are the signal and a naive prefix clip would lose them.
- `MAX_OSC_TITLES_PER_CHUNK = 4096` with a **ring buffer** (lines 120-133) — a chunk with more titles keeps the most recent 4096, in order.
- Two exports: `extractLastOscTitle` (cheap) and `extractAllOscTitles` (ordered, for transition detection).
- Companion `src/shared/osc-title-scan-tail.ts` holds the cross-chunk tail.

### P2.1.4 Title → status classifier

`src/shared/agent-title-status.ts:137` — `detectAgentStatusFromTitle(title): 'working' | 'permission' | 'idle' | null`

Evaluation order, first match wins:

1. Empty, or `isClaudeManagementTitle` (matches `claude agents` invocations), or the literal `cursor agent` → **`null`** (not an agent state).
2. Gemini glyphs (exact codepoints, `src/shared/agent-title-core.ts:21-24`):
   - `✋` U+270B → `permission`
   - `✦` U+2726 or `⏲` U+23F2 → `working`
   - `◇` U+25C7 → `idle`
3. Pi/OMP synthetic labels.
4. `✳` U+2733 (`CLAUDE_IDLE`) as prefix or whole title → **`idle`**.
5. Pi title without spinner → `idle`.
6. **Any braille codepoint U+2800–U+28FF anywhere in the title → `working`.** The universal spinner heuristic (`containsBrailleSpinner` iterates codepoints rather than using a regex).
7. If the title contains **no** known agent-name token → **`null`** (bail out; this is what prevents cwd titles from being classified).
8. Contains `action required` | `permission` | `waiting` (case-insensitive substring) → `permission`.
9. `STRONG_IDLE_KEYWORDS_RE` = `ready|idle|done` → `idle`.
10. `STRONG_WORKING_KEYWORDS_RE` = `working|thinking|running` → `working`.
11. Title starts with `". "` → `working`; starts with `"* "` → `idle`. *(Claude Code's own conventions.)*
12. Default → `idle`.

The keyword regexes use a **boundary guard that also excludes path separators**, `src/shared/agent-title-core.ts:31-41`:

```js
new RegExp(`(?<![\\w./\\\\-])(ready|idle|done)(?![\\w\\-])`, 'i')
```

with the stated reason: *"plain `\b` matches inside hyphenated tokens and cwd paths such as `~/codex/ready`; the left side also blocks path separators for Windows/Unix."* This is the single most valuable line in the file for us — it is the fix for the false-positive class that makes naive title parsing useless.

### P2.1.5 Transition tracking and debounce

`createAgentStatusTracker(onBecameIdle, onBecameWorking, onAgentExited, initialTitle)` — `src/shared/agent-title-status.ts:51-92`.

**There is no timer-based debounce.** Debounce is structural, three ways:

1. **Edge-triggered on classified state only.** `handleTitle` fires `onBecameIdle` only when `lastStatus === 'working' && newStatus !== null && newStatus !== 'working'`. A `null` classification never overwrites `lastStatus` (line 81) — unclassifiable titles are ignored, not treated as "no agent."
2. **Title normalization collapses animation frames before storage** — `normalizeTerminalTitle()` (line 97). Concrete cases they hit: *"Pi animates every 80ms"* → collapse to `⠋ Pi`; Grok Build interpolates a rotating phrase per frame → collapse to `⠋ Grok`; Gemini → `✦ Gemini CLI` / `◇ Gemini CLI` / `✋ Gemini CLI`. Without this the tab label flickers many times per turn.
3. **Agent-exit detection is asymmetric** (lines 75-80): reverting to `null` counts as "agent exited" **only from idle/permission**, never from `working` — *"while working it can just be a transient internal title."*

`seedTitle()` exists so a tracker restored mid-session adopts a last-known status **without firing callbacks** — otherwise a hidden working agent misses its later idle transition.

### P2.1.6 What `orca terminal wait --for tui-idle` actually does

Schema — `src/main/runtime/rpc/methods/terminal.ts:823-828`:
```ts
const TerminalWait = TerminalHandle.extend({
  for: z.custom<'exit' | 'tui-idle'>(v => v === 'exit' || v === 'tui-idle', {
    message: 'Invalid --for value. Supported: exit, tui-idle'
  }),
  timeoutMs: OptionalFiniteNumber
})
```

**It does not poll.** It registers a waiter resolved by the title-transition path in `src/main/runtime/orca-runtime.ts` (~line 8471):

```js
// Why: resolve tui-idle on any transition TO idle (not just working→idle).
// Claude Code may skip "working" entirely on fast tasks, going null→idle,
// and the coordinator's tui-idle waiter would hang forever waiting for a
// working→idle transition that never comes. Permission→idle is excluded:
// it means the agent was blocked on user approval and the user said no,
// which isn't a task-completion signal.
if (agentStatus === 'idle' && prevStatus !== 'idle') {
  this.resolveTuiIdleWaiters(leaf)
}
```

**Three hard-won bugs encoded there, all of which Morz's orchestrator would hit:**
- Fast tasks go `null → idle` with no `working` in between. Waiting for `working→idle` hangs forever. **This is very likely our "dispatches but never wakes" bug.**
- `permission → idle` must be **excluded** — the user denied approval; that is not completion.
- Per-chunk OSC titles must be fed **in byte order**, not just the chunk's last title, or a coalesced `working→idle` inside one chunk is masked (`orca-runtime.ts:7883-7888`, their issue #1083).

Also at `orca-runtime.ts:8454-8470`: the last OSC title is stored on the leaf so status can be recomputed per call, because *"daemon-hosted terminals (no renderer pushing pane titles) had no way to clear a stale 'working' status after the agent exited and the shell took over the title — the stuck-spinner bug in #1437."* When a new title fails to classify, `lastAgentStatus` is **cleared, not left sticky**.

### P2.1.7 Agent identity resolution

`src/shared/terminal-title-agent-type.ts` — `getAgentLabel(title)` returns a product label, then `TITLE_LABEL_TO_AGENT` maps it to a `TuiAgent` id.

Ordering is deliberate and adversarial: OpenCode's native marker first (it owns the whole title), then Claude's prefix glyphs, then Gemini, Pi, then **explicit name-token matches** (codex, openclaude, copilot, grok, devin, antigravity, opencode, mimo, aider), then Cursor's closed title set, Droid, Hermes, and only then the generic `isClaudeAgent` braille heuristic.

The reason for that order: Claude Code's title text is usually the *task description*, which may name another agent. Agent-specific structural markers must beat name mentions.

`resolveExplicitTerminalTitleAgentType()` (line 263) adds a crucial guard: a bare Claude status prefix (spinner / `✳` / `". "` / `"* "`) is treated as **activity evidence only, not identity proof**. A worktree or task title cannot become "Claude" without the literal name.

`isCursorAgentTitle` is a closed set (`cursor agent`, `cursor ready`, `cursor - action required`, `/^[⠀-⣿] Cursor Agent$/u`) because *"`cursor` is also an ordinary editor noun that other agents type into their own task-summary titles, so a name token is not identity."*

**Identity fallback beyond titles:** `src/shared/agent-process-recognition.ts` and `shell-process-detection.ts` resolve the agent from the **foreground process name**; titles are the fallback for agents whose process is generic (comment at `terminal-title-agent-type.ts:212-214`: *"Claude Code runs as `node`, but its '✳ Claude Code' title resolves here"*).

---

## P2.2 — Managed hooks channel

### P2.2.1 Exactly what they install into `~/.claude/settings.json`

`src/main/claude/hook-settings.ts:30-62` — `CLAUDE_EVENTS`:

| Event | Matcher | Why (their comments) |
|---|---|---|
| `UserPromptSubmit` | — | turn start, captures the user's prompt |
| `Stop` | — | turn end |
| `StopFailure` | — | *"OpenClaude skips normal Stop hooks after API/model errors… without this hook Orca leaves the turn spinning"* |
| `SubagentStart` | — | child rows in sidebar |
| `SubagentStop` | — | keeps pane `working` while children outlive the lead turn |
| `TeammateIdle` | — | *"parks turn-based teammates without trusting their permanently 'running' background_tasks entry"* |
| `PreToolUse` | `*` | *"live readout of the in-flight tool (name + input preview) before it completes"* |
| `PostToolUse` | `*` | |
| `PostToolUseFailure` | `*` | |
| `PermissionRequest` | `*` | → the `waiting`/`blocked` state |

They register **unofficial event names** (`StopFailure`, `SubagentStart`, `TeammateIdle`) on the stated bet that *"older Claude builds ignore unregistered event names (StopFailure precedent)."*

Config target is **`~/.claude/settings.json`** (user-level, `getConfigPath()` line 64), not per-repo. Hook timeout is `MANAGED_HOOK_TIMEOUT_SECONDS = 10` (`installer-utils.ts:44`), a *"host-level backstop timeout, independent of the curl `--max-time`."*

Install/uninstall is **idempotent and non-destructive**: `applyManagedHooks` (line 114) removes only entries matching `createManagedCommandMatcher(scriptFileName)` and appends one fresh managed definition, preserving all user hooks in the same event array.

### P2.2.2 The hook transport

The installed command runs a managed script (`claude-hook.sh` / `.cmd`) that POSTs to a **local HTTP server on 127.0.0.1**. From `installer-utils.ts:164-199`, the Windows form:

```
"%SystemRoot%\System32\curl.exe" -sS -X POST "http://127.0.0.1:%ORCA_AGENT_HOOK_PORT%/hook/<source>"
  --connect-timeout 0.5 --max-time 1.5
  -H "Content-Type: application/x-www-form-urlencoded"
  -H "X-Orca-Agent-Hook-Token: %ORCA_AGENT_HOOK_TOKEN%"
  --data-urlencode "paneKey=%ORCA_PANE_KEY%"
  --data-urlencode "tabId=%ORCA_TAB_ID%"
  --data-urlencode "launchToken=%ORCA_AGENT_LAUNCH_TOKEN%"
  --data-urlencode "worktreeId=%ORCA_WORKTREE_ID%"
  --data-urlencode "env=%ORCA_AGENT_HOOK_ENV%"
  --data-urlencode "version=%ORCA_AGENT_HOOK_VERSION%"
  --data-urlencode "payload@-"    # ← agent's hook JSON piped on stdin
  >nul 2>&1
```

**Windows-specific decisions we should copy verbatim:**
- *"PowerShell per-post costs ~300ms startup and mangles UTF-8 via code-page translation; curl.exe (Win10 1803+) avoids both."* (line 182)
- *"fully-qualify curl so a repo-local `curl.exe` can't hijack hook payloads"* — always `%SystemRoot%\System32\curl.exe`, never bare `curl`.
- `wrapWindowsGitBashHookCommand` (line 156) emits `if [ -f <path> ]; then <path>; else <stdin-drain>; fi` — **if the hook script is missing, stdin must still be drained** or the agent blocks. There is a dedicated `POSIX_HOOK_STDIN_DRAIN_COMMAND` and a whole `hook-stdin-contract.ts` for this.
- `WINDOWS_CMD_SAFE_PATH` / `WINDOWS_GIT_BASH_SAFE_PATH` regex gates exist because *"Codex/Antigravity/Devin spawn the hook as argv[0], not via cmd.exe, so it must be one spawnable token; a cmd `if exist` launcher isn't (#8430)."*

### P2.2.3 Endpoint persistence (surviving restarts)

`src/shared/agent-hook-endpoint-file.ts` — port and token live in a file the hook **re-sources on every invocation**:

- Filenames: `endpoint.env` (POSIX) / `endpoint.cmd` (Windows).
- Four required keys: `ORCA_AGENT_HOOK_PORT`, `ORCA_AGENT_HOOK_TOKEN`, `ORCA_AGENT_HOOK_ENV`, `ORCA_AGENT_HOOK_VERSION`.
- The parser strips a leading `set ` (line 23) so one file format parses as both a shell env file and a cmd script.

This is the whole trick for restart survival: **a PTY started before an Orca restart carries a stale port in its environment, so the hook script re-reads the endpoint file each time** rather than trusting `%ORCA_AGENT_HOOK_PORT%` from the PTY env. The path is passed as `ORCA_AGENT_HOOK_ENDPOINT`.

### P2.2.4 Interactive-question detection (the `waiting` state)

`src/shared/agent-hook-listener.ts` + `src/shared/agent-question-answered-intent.ts`.

Mechanism: a `PreToolUse` hook where the tool is **`AskUserQuestion`** (`isAskUserQuestionTool`). Its **full untruncated JSON input** rides in `interactivePrompt` (16 KB cap) so clients can render the question card with all options.

The critical correctness rule, `agent-hook-listener.ts:539`:
> *"don't inherit `previous.interactivePrompt` — valid only for its one AskUserQuestion event; carrying it forward leaves a stale live card."*

Every other tool field merges forward across events; this one must not. Also `resolvePrompt` (line 486) filters **harness-injected user turns**: *"harness-injected turns fire UserPromptSubmit but aren't the user's ask — keep cached prompt; match only known tags so real `<tags>` still reset the turn."*

Per-agent quirks handled in the same listener: OpenCode sends `MessagePart {role, text}` with no `UserPromptSubmit` at all (line 458); Kimi sends `prompt` as a content-block array, not a string (line 450); Copilot's `Stop` uses generic `message` as final assistant text while Grok/Antigravity use that field for status (line 1251); Antigravity emits `Stop` while still busy (`isAntigravityStopStillBusy`).

### P2.2.5 The statusLine channel (their cleverest trick)

`src/shared/claude-statusline-rate-limits.ts` + `src/main/claude/statusline-script.ts`.

> *"Claude Code (>=2.1.80) pipes `rate_limits` to the statusLine command on every turn — piggybacked on Messages API responses, so reading it costs no usage-endpoint budget (the endpoint 429s under Orca's polling)."*

They install a managed `statusLine` command that **reads the JSON on stdin, forwards it to the hook server, and prints nothing** — so the in-terminal status line is visually unchanged. Payload type:

```ts
type ClaudeStatusLineRateLimits = {
  configDir: string | null
  fiveHour: { used_percentage?, utilization?, resets_at? } | null
  sevenDay: { ... } | null
}
```

POSTs to `/statusline/claude`. Throttling is layered because the statusline ticks **~3x/sec while streaming**:
- `CLAUDE_STATUSLINE_MIN_POST_INTERVAL_SECONDS = 15` — a per-pane client-side floor implemented in **pure cmd builtins** (seconds-of-day arithmetic against a per-pane temp stamp file) to avoid spawning `findstr`+`curl` on every tick.
- A `findstr /c:\"rate_limits\"` guard skips the POST entirely when the field is absent (it only appears for Claude.ai-subscriber sessions after the first API response).
- Server-side `LIVE_CLAUDE_INGEST_DEDUPE_MS = 30s` drops same-value posts.
- The stamp is written **only when a post is certain**, so skipped ticks never push the next allowed post out.

**Ownership policy** (`hook-settings.ts:139-169`) is a three-state slot: `managed` | `user` | `empty`. They **never overwrite a user-owned statusLine**, and an `empty` slot after a prior install (tracked by a `.installed` marker file) reads as **deliberate user opt-out**, not a missing install. Falls back to the OAuth poll.

---

## P2.3 — PTY daemon

`src/main/daemon/` — ~150 files.

- **Separate OS process**, spawned by `DaemonSpawner` (`daemon-spawner.ts`) with a `runtimeDir` holding `socketPath`, `tokenPath`, `pidPath`, and a `launchNonce`.
- **Transport is a Unix domain socket / named pipe** with NDJSON framing (`ndjson.ts`) plus a binary frame path for PTY data (`binary-frame.ts`). Explicit `PROTOCOL_VERSION` with negotiation tests (`daemon-protocol-version.ts`).
- **PID file** carries `{pid, startedAtMs, entryPath, appVersion, launchNonce}` — enough to detect a stale daemon from a previous app version (`daemon-bundle-staleness.test.ts`) and to trigger `daemon-self-retirement-respawn`.
- **Adoption lease** (`releaseAdoptionLease()`) — how a newly launched app claims an orphaned running daemon.
- **Degraded mode**: `degraded-daemon-pty-provider.ts` and handle mode `'degraded-new-pty-fallback'` — if the daemon is unreachable, new PTYs spawn in-process rather than failing. Existing sessions are lost but the app still works.
- **Headless xterm inside the daemon**: `headless-emulator.ts` (with fuzz tests, unicode-width tests, and a snapshot-cost benchmark) maintains the authoritative screen buffer server-side. That is what makes remote/mobile/warm-reattach possible, and what `@xterm/headless` in prod dependencies is for.
- **Scrollback durability**: `terminal-history-log.ts`, `terminal-history-session-writer.ts`, `terminal-history-checkpoint-reader.ts`, `cold-restore-payload-cache.ts`, `terminal-history-incremental-restore.ts`, `terminal-history-recovery-quarantine.ts`. Cold restore replays a checkpoint plus an incremental log; corrupt history is **quarantined, not deleted**.
- **Backpressure**: `daemon-stream-data-batcher.ts`, `daemon-stream-backlog-probe.ts`, `daemon-stream-keep-tail-drop.ts`, `daemon-stream-droppable-membership.ts`, `priority-semaphore.ts`. Under backlog they **drop from the head and keep the tail** — for a terminal, newest output is what matters.
- **Windows**: `windows-conpty-warmup.ts` (pre-warm ConPTY to hide first-spawn latency), `wsl-session-context.ts`, `wsl-cold-restore-cwd.ts`.
- **macOS**: `macos-login-session-death-watch.ts` — detect the login session dying and shut down cleanly.
- `osc7-file-uri.ts` / `terminal-osc-cwd-title-scanner.ts` — cwd tracking via **OSC 7**, kept separate from title tracking.
- `pty-session-id.ts`, `terminal-host-tombstones.ts`, `terminal-host-agent-session-generations.ts` — identity across reattach, with tombstones so a reaped session cannot be resurrected.

### Hibernation → resume wiring

`src/renderer/src/lib/agent-hibernation-planner.ts`

Thresholds (lines 13-15): `DEFAULT = 30 min`, `MIN = 60_000`, `MAX = 24 h`. **Gated behind `settings.experimentalAgentHibernation !== true`** (line 245) — still experimental in shipping builds.

Eligibility, all required (`getEligiblePane`, lines 113-203):
1. `entry.state === 'done'` and **`entry.interrupted !== true`**;
2. not already sleeping;
3. tab/worktree attribution matches;
4. `isResumableTuiAgent(agentType)` **and** `entry.providerSession` exists **and** `getAgentResumeArgv()` returns a command — no resume command, no hibernation;
5. `now - effectiveIdleStart >= idleMs`, where `effectiveIdleStart = max(entry.updatedAt, foregroundTerminalLastSeenAtByTabId[tab.id])` — *"returning to the containing terminal tab should restart sleep even without pane input; sibling tabs keep their age"*;
6. `lastInputBlocksHibernation(entry, inputAt)` is false. The comment is a production post-mortem: *"killing the PTY discards the TUI composer's draft and any queued messages. The old input-after-done compare missed drafts typed while the agent was still working — the class that lost a user's draft in prod."*;
7. the pane's PTY is in the live set and **not in `mobileLockedPtyIds`**;
8. worktree is not the active one, tab is not foreground.

Resume commands — `src/shared/agent-session-resume.ts:236-265`:

```
claude       → ['claude', '--resume', id]
codex        → ['codex', 'resume', id]
gemini       → ['gemini', '--resume', id]
antigravity  → ['agy', '--conversation', id]
opencode     → ['opencode', '--session', id]
mimo-code    → ['mimo', '--session', id]
droid/grok/devin → ['<bin>', '--resume', id]
omp          → ['omp', '--resume', <ompResumeFilePath || id>]
```

The provider session id is captured from hook payloads (`session_id` / `conversation_id`), and `transcriptPath` is kept separately because *"recent Claude Code versions name the transcript file with a UUID that differs from the hook `session_id`, so reconstructing the path from `id` alone fails."* Pi resumes by **file path as identity**, not id.

A `signature` string over `paneKey:ptyId:runtimePtyId:providerSessionId:state:updatedAt:effectiveIdleStart:inputAt` lets the coordinator detect a candidate that went stale between planning and execution.

---

## P2.4 — Orchestration design (`ORCHESTRATION_IMPLEMENTATION_CHECKLIST.md`, 107 KB)

It is an **implementation ledger**, not a design doc — the design lives in `docs/orchestration-primitives.html`. Rules of the file: check an item only after implementation *and* proportionate tests; every meaning change needs a dated decision-log entry; no phase closes while an acceptance test is open.

**Scope invariants (all marked complete) — the interesting part:**

- *Agents choose decomposition, topology, placement, parallelism, and recovery strategy.* Orca provides primitives, not a planner.
- Low-level worktree/terminal/setup/handoff commands stay independently usable.
- *"Every composed mutation with external effects returns explicit effects and an honest outcome; control-plane-only mutations return their exact resource receipt."*
- *"Worker assertions remain labeled as worker reports, not Orca-verified correctness."*
- **"Silence alone never proves worker death or triggers replacement."**
- Multi-server Runs have exactly one authoritative Run home.

**Explicit non-goals (deliberately not built):** no Run dashboard, UI, badges, or coordinator chat; **no scheduler, automatic placement, capacity allocator, fairness, or priority aging**; no automatic retry or replacement based on silence; no commit/branch/merge/target-ref tracking; no filesystem read-only enforcement; no ACL/organization/role system; no replicated Run database, leader election, or automatic Run-home failover; no dead-letter/poison-message workflow.

`--max-concurrent` is therefore **a concurrency cap, not a scheduler** — no queue discipline, no priority, no fairness. That is a much smaller thing than it sounds, and a reasonable target for Morz.

**Phase structure:**
- Phase 0 — vocabulary and command compatibility.
- Phase 1 — lightweight Run, mailbox, **crash-safe inbox consumption**, truthful lifecycle, questions, **narrow pane authority**, **durable mutation ledger**.
- Phase 2 — same-server composed worker lifecycle: command grammar/topology, setup and startup, start receipts, **Dispatch and Task state machine**, show/read/stop/abandon, recovery tests.
- Phase 3 — connected-server federation: placement and identity, remote Dispatch attachment, bidirectional relay, federated control and recovery, **capability negotiation**, a federation scenario matrix.
- Phase 4 — structured worker output (also `ORCHESTRATION_STRUCTURED_OUTPUT_DESIGN.md`, 25 KB).
- Migration — **hard cutover** with a contract/effect fence.

Message types confirmed in code (`src/shared/orchestration-*.ts`, `src/main/runtime/rpc/methods/orchestration*.ts`): `status`, `dispatch`, `worker_done`, `escalation`, `decision_gate`, `heartbeat`.

**Cost signal:** the progress log shows Phases 0-3 plus cross-platform gates landing across ~2026-07-21 → 2026-07-24 — about four days of dated entries, including physical acceptance runs for Mac-home→Windows-worker and Windows-home→Mac-worker federation, restart, and disconnect. A `2026-07-24` entry notes a **post-rebase renderer-adoption process-identity regression** that forced Phase 3 revalidation.

---

## P2.5 — The patches (`config/patches/`, referenced from `package.json` `pnpm.patchedDependencies`)

| Patch | Lines | Area |
|---|---|---|
| `node-pty@1.1.0.patch` | 431 | see below |
| `@xterm__addon-webgl@0.20.0-beta.286.patch` | 308 | glyph renderer + texture atlas |
| `@xterm__xterm@6.1.0-beta.287.patch` | 187 | IME composition + SortedList |
| `@xterm__addon-serialize@0.15.0-beta.287.patch` | 55 | snapshot fidelity |
| `@xterm__addon-ligatures@0.11.0-beta.287.patch` | 21 | packaging only |

### node-pty — the important one

Four distinct fixes:

1. **glibc symbol pinning for old Linux.** They `.symver`-pin `openpty`, `forkpty`, and `pthread_sigmask` to `GLIBC_2.2.5` (x86_64) / `GLIBC_2.17` (aarch64), because glibc 2.32-2.34 relocated those into libc under new symbol versions, so building on a modern glibc produces references absent on Ubuntu 20.04. Paired with a `binding.gyp` linker flag `-Wl,--no-as-needed,-l:libutil.so.1,-l:libpthread.so.0,--as-needed` — *"gcc's default `--as-needed` drops them because the pinned symbols resolve from libc's compat aliases at build time."* (Not our problem on Windows, but it explains their glibc 2.31 floor.)

2. **ConPTY console-list crash — Windows, directly relevant to us.** In `lib/conpty_console_list_agent.js`, `getConsoleProcessList(shellPid)` is wrapped in try/catch falling back to `[shellPid]`, because *"AttachConsole can fail after the shell exits."* Unpatched node-pty throws in a helper subprocess here.

3. **asar path double-replacement bug.** `helperPath.replace('app.asar', 'app.asar.unpacked')` is guarded with `if (!helperPath.includes('app.asar.unpacked'))`; the unguarded version corrupts the path when it already contains `.unpacked`. Same for `node_modules.asar`. **This bites any Electron app shipping node-pty in an asar — Morz will hit it.**

4. **Structured spawn errors.** They add a `pty_spawn_error {step, errnum, detail_name, detail_value}` struct and `pty_format_spawn_error()` producing e.g. `node-pty: <step> failed: ENOENT (errno 2, No such file or directory) - file='...'`, replacing node-pty's opaque failure. Companion `src/main/daemon/node-pty-error-hints.ts` turns these into user-facing hints.

Also: they **remove `SpectreMitigation: 'Spectre'`** from the Windows MSVC config in both `binding.gyp` and `deps/winpty/src/winpty.gyp` (it requires a VS component many build machines lack), and fix winpty's gyp to invoke `.\GetCommitHash.bat` rather than bare `GetCommitHash.bat`.

### xterm core

- `CompositionHelper.ts` — substantial IME work: *"Chromium may copy keypress text anywhere into the candidate, or expose only an…"*. Affects CJK/JIS input.
- `CoreBrowserTerminal.ts` and `SortedList.ts` — small additions (a ~24-line insert into SortedList, likely a lookup/removal fix for marker-heavy buffers).

### xterm WebGL addon

Changes concentrated in `GlyphRenderer.ts`, `TextureAtlas.ts`, `Types.ts` (`ICharAtlasConfig` gains 3 fields), and `WebglRenderer.ts`, plus **inlined shader changes** in the prebuilt `lib/` bundles. Consistent with custom font/ligature/atlas handling — the "Ghostty-class" rendering claim is partly this patch.

### xterm serialize addon

`StringSerializeHandler` — a ~13-line insert whose comment mentions *"bold/dim, garbling Orca's hidden-terminal snapshot restores."* An SGR bold/dim serialization bug that corrupted restored scrollback. Directly load-bearing for their session-restore feature.

---

## P2.6 — Usage metering

**Two entirely separate systems.**

### (a) Rate-limit windows — via statusLine, not file scanning

Covered in P2.2.5. `src/shared/rate-limit-types.ts`:

```ts
type RateLimitWindow = {
  usedPercent: number              // 0–100
  windowMinutes: number            // 300 (5h) or 10080 (7d)
  resetsAt: number | null          // unix ms
  resetDescription: string | null  // "2:30 PM" / "Thu"
}
type ProviderRateLimits = {
  provider: 'claude'|'codex'|'gemini'|'opencode-go'|'kimi'|'minimax'|'grok'|'antigravity'
  session: RateLimitWindow | null   // 5-hour
  weekly:  RateLimitWindow | null   // 7-day
  ...
}
```

`UsageRateLimitSource = 'oauth' | 'cli' | 'web' | 'live-session'` — four acquisition strategies with a preference order, and a 14-value `UsageRateLimitFailureKind` union (`missing-credentials`, `stale-token`, `keychain-unavailable`, `rate-limited`, `deferred-by-live-session`, …) so failures degrade visibly instead of going dark. `retryAtMs` honours HTTP `Retry-After`.

**Correction to Part 1:** the docs' claim that usage comes from reading `~/.claude` is only half true. The **live** numbers come from the statusLine piggyback (`live-session`); OAuth is the fallback.

### (b) Token accounting — JSONL transcript scanning

`src/main/claude-usage/scanner.ts`:

- Scans **`~/.claude/projects/`** and **`~/.claude/transcripts/`** (lines 47-48), reading `.jsonl` line-by-line via `createReadStream` + `readline` (never loading whole files).
- Per-record shape: `{type, sessionId, timestamp, cwd, gitBranch, requestId, uuid, isSidechain, agentId, message: {id, model, usage: {input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens}}}`.
- `FILE_SCAN_BATCH_SIZE = 4` — bounded concurrency.
- Attribution: `cwd` is `realpath`-canonicalized and matched against known worktree paths to attribute tokens to a repo/worktree/branch, falling back to a two-segment label.
- `store.ts`: `SCHEMA_VERSION = 5`, `STALE_MS = 5 * 60_000`, `AUTOMATION_ATTRIBUTION_WINDOW_MS = 5 * 60_000` (a ±5 min window matching automation runs to sessions). Dedupe-key evolution is documented: *"v5 widens Claude ownership keys (message-id / uuid fallbacks). Older caches either lack ownership or used narrower keys and can under/over-count after fork reclaim (#8006)"* — Claude Code's session-fork copies history, and naive counting double-counts.

A parallel `src/main/codex-usage/` mirrors the same scanner/store/types shape.

---

## P2.7 — Revised recommendations for Morz (wave-17 adapter seam)

**Build channel 3 (titles) first — zero installation, covers every agent.** Minimum viable port, in dependency order:

1. `extractAllOscTitles` with the hand-rolled parser (OSC 0/1/2, BEL-or-ST, 1024-char head+tail truncation, cross-chunk tail buffer). Do not use a regex.
2. `detectAgentStatusFromTitle` with the exact glyph constants (`✳` U+2733, `✦` U+2726, `⏲` U+23F2, `◇` U+25C7, `✋` U+270B, braille U+2800–U+28FF) and the **path-separator-aware keyword boundary regex** — that regex is the difference between working and useless.
3. `createAgentStatusTracker` edge-triggering, including `seedTitle` (no callbacks on restore) and the asymmetric exit rule (`null` from working is not an exit).
4. `normalizeTerminalTitle` to collapse animation frames before they reach the UI, or tab labels strobe.
5. Resolve idle waiters on **any transition to idle**, excluding `permission → idle`. Feed titles in byte order per chunk. Clear sticky status when a title stops classifying.

**Then channel 1 (hooks) for fidelity.** Reusable pieces: a local `127.0.0.1` server with a per-session token header; the `endpoint.env` / `endpoint.cmd` re-sourcing trick for restart survival; fully-qualified `%SystemRoot%\System32\curl.exe` instead of PowerShell; the stdin-drain fallback when the script is missing; and a non-destructive install that only ever removes entries matching its own script name.

**Steal outright, cheaply:**
- The statusLine piggyback for Claude rate limits — free, live, no API budget. Plus the never-overwrite-a-user-slot policy with an `.installed` marker distinguishing "never installed" from "user removed it."
- The node-pty asar double-replacement guard and the ConPTY `AttachConsole` try/catch — both are latent Windows bugs in our current stack.
- `AGENT_STATUS_STALE_AFTER_MS = 30 min` decay so a crashed agent's row stops claiming "working" forever.
- Structured spawn errors from node-pty (patch #4) — turns "spawn failed" into an actionable message.

**Deliberately do NOT copy:**
- The orchestration federation (Phases 2-3). Their own non-goals list shows the cheap version is the right one: no scheduler, no fairness, no auto-retry, silence never implies death. A concurrency cap plus explicit `worker_done` messages is ~90% of the value.
- Hibernation. Still `experimental` in their shipping build, eight eligibility conditions, and one of them exists because it lost a user's draft in production.
- Their ~150-module `src/main`. The lesson from 2,437 open issues is that breadth is their liability, not their moat.

## P2.8 — Still unknown after the teardown

- `docs/orchestration-primitives.html` (the actual design doc) — only the ledger was read.
- `docs/STYLEGUIDE.md` — their design system.
- ~~Whether any approval-bypass flag is passed to agents.~~ **RESOLVED — see P2.9. They pass bypass flags to all 24 agents, and it is the default.** (My earlier guess that they only observe was wrong.)
- The renderer side: how the `agent-status` store slice drives the sidebar (`src/renderer/src/store/slices/agent-status.ts`, `components/sidebar/smart-attention.ts`).
- The exact hook-server route table (`src/relay/agent-hook-server.ts`; `src/main/agent-hooks/server.ts` is 79.9 KB).

---

## P2.9 — Approval model: SETTLED

> Answers the open question left in P2.8. (Requested as "P2.7"; that number was already taken by the recommendations section, so this is appended as P2.9.)

### The answer

**Yes — Orca passes approval-bypass flags to every agent it launches, and bypass is the DEFAULT, not an opt-in.**

`src/shared/tui-agent-launch-defaults.ts:10`:

```ts
export const DEFAULT_TUI_AGENT_ARGS: Partial<Record<TuiAgent, string>> = YOLO_TUI_AGENT_ARGS
```

The default launch-args table **is** the yolo table, by direct assignment. A fresh Orca install with untouched settings launches Claude Code as `claude --dangerously-skip-permissions`.

### The bypass table

`src/shared/tui-agent-permissions.ts:6-35` — `YOLO_TUI_AGENT_ARGS`, complete and verbatim:

| Agent | Flag |
|---|---|
| `claude` | `--dangerously-skip-permissions` |
| `claude-agent-teams` | `--dangerously-skip-permissions` |
| `openclaude` | `--dangerously-skip-permissions` |
| `codex` | `--dangerously-bypass-approvals-and-sandbox` |
| `gemini` | `--yolo` |
| `antigravity` | `--dangerously-skip-permissions` |
| `aider` | `--yes-always` |
| `amp` | `--dangerously-allow-all` |
| `kiro` | `--trust-all-tools` |
| `crush` | `--yolo` |
| `autohand` | `--unrestricted` |
| `cline` | `--auto-approve true` |
| `command-code` | `--yolo` |
| `continue` | `--allow "*"` |
| `cursor` | `--yolo` |
| `kimi` | `--yolo` |
| `mistral-vibe` | `--agent auto-approve` |
| `qwen-code` | `--approval-mode yolo` |
| `rovo` | `--yolo` |
| `hermes` | `--yolo` |
| `copilot` | `--yolo` |
| `grok` | `--permission-mode bypassPermissions` |
| `devin` | `--permission-mode bypass` |
| `ante` | `--yolo` |

Plus an environment-variable variant, `YOLO_TUI_AGENT_ENV` (line 33): `goose` → `GOOSE_MODE=auto`.

Note `codex` gets `--dangerously-bypass-approvals-and-sandbox`, which disables **both** the approval prompt and the sandbox.

### The user-facing control

A single global three-state toggle in **Settings → Agents**, not per-agent and not per-worktree.

- Mode type (`tui-agent-permissions.ts:4`): `'yolo' | 'manual' | 'mixed'`.
- `resolveAgentPermissionModeSummary()` derives the current mode by comparing every agent's configured args against its yolo string: exact match → `yolo`, empty → `manual`, anything else → `mixed`.
- `applyAgentPermissionMode()` (line 135) flips all agents at once, and **only rewrites entries that are currently empty or exactly the yolo string** — a user's hand-customized args for one agent survive the global toggle.
- UI copy (`src/renderer/src/i18n/.../en.json:11155-11157`):
  - label: **"Yolo / Dangerously skip permissions"**
  - tooltip: **"Skip permission checks for agents for less interruptions"**
- The toggle renders as a two-option control (`AgentsPane.tsx:210`): `const visibleMode = mode === 'manual' ? 'manual' : 'yolo'` — so a `mixed` configuration **displays as "Yolo"**. A user with one agent bypassed and the rest manual sees the switch in the Yolo position.

There is **no** separate confirmation, warning dialog, or first-run consent gate around this in the code I read — just the labelled toggle sitting in its default (bypass) position.

### Two related-but-different mechanisms, not to be confused

**1. `src/main/agent-trust-presets.ts` is NOT approval bypass.** It pre-writes the *"Do you trust this folder?"* artifacts that Cursor, Copilot, and Codex each write after a user accepts the prompt:
- Cursor → `~/.cursor/projects/<slug>/.workspace-trusted`
- Copilot → `~/.copilot/config.json` → `trustedFolders[]`
- Codex → `~/.codex/config.toml` → `[projects."<realpath>"] trust_level = "trusted"` (written to both the real and Orca-managed `CODEX_HOME`)

The stated reason is a UX collision, not permission policy: Orca injects a URL draft via bracketed paste once the TUI is up, and *"if the trust menu intercepts the keystrokes… the paste either selects an arbitrary option or quits the session."*

Notably, the same file's header comment **explicitly rejects** using the bypass flag for this purpose: *"Codex's `--dangerously-bypass-approvals-and-sandbox` would also change approval/sandbox policy, so it is not equivalent to 'trust this project'."* So they do distinguish the two concepts carefully — they just also ship the bypass on by default elsewhere.

**2. The `PermissionRequest` hook is observation, not control.** Registered in `CLAUDE_EVENTS` (P2.2.1), it drives the `waiting`/`blocked` UI state. It observes approval prompts; it does not grant or deny them. With yolo mode on by default, it rarely fires for Claude.

### One safety detail worth copying

`UNSUPPORTED_TUI_AGENT_ARGS` (`tui-agent-launch-defaults.ts:5-8`) plus `sanitizeTuiAgentLaunchArgs()` **strip** `--dangerously-skip-permissions` from `opencode` and `kilo` launches, because *"a few agents have removed, relocated, or never exposed Claude-style skip-permission flags on the interactive TUI command Orca launches."* Passing an unknown flag would break the launch outright, so they sanitize rather than fail.

### Implication for Morz

This is a **direct, documentable conflict with Morz's "assist, don't take over" philosophy** and the graduated-autonomy dial (manual / assisted / orchestrated). Orca ships the equivalent of permanent "orchestrated" mode with the safety rails off, out of the box, for 24 agents, behind a toggle whose tooltip frames the tradeoff as *"less interruptions"* rather than as a risk.

Recommendation: **Morz should default to manual approval** and make bypass an explicit per-agent, per-worktree opt-in — ideally scoped to a worktree, since worktree isolation is exactly what makes a bypass defensible. If we ever ship a global bypass toggle, the `mixed`-displays-as-`yolo` behaviour is a bug worth not reproducing: the control should always tell the truth about its current state.

This is also a legitimate competitive/marketing differentiator, and it is verifiable by anyone from public source — `tui-agent-launch-defaults.ts:10` is a one-line citation.
