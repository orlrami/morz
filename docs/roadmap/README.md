# Morz — Roadmap Index

*Decisions locked 2026-07-12 (owner). One file per version — each is the deliverable contract for that release. Architecture reference: [`../MORZ-Backend-Plan.md`](../MORZ-Backend-Plan.md). Full feature catalog: [`../BUILD-BREAKDOWN.md`](../BUILD-BREAKDOWN.md). Research: [`../research/`](../research/).*

**Identity:** Windows-first · real multi-file IDE · no-code agent-to-agent handoff · the control dial (Manual / Assisted / Orchestrated). Personal-first; SaaS/open-source are possible futures behind seams, not builds. Name: **Morz**. Theme: **Slate**.

**Orchestration pattern (owner-defined):** the orchestrator's core move is the **visible pane launch** — automate exactly what you'd type by hand (`cd` dir → checkout/worktree branch → launch the CLI) in a real, visible terminal pane. Launching CLIs, not spawning hidden subagents. Claude = conversational orchestrator + launch-to-pane; Codex/Antigravity tolerate more automation.

| Version | Theme | File |
|---------|-------|------|
| **0.0.1** | "The Terminal" — daily-drive it instead of Herdr. PTY-host, session restore + PTY survival, ctrl-click → IDE pane, spaces/git, one Claude lane, Manual/Assisted | [0.0.1.md](0.0.1.md) |
| **0.0.2** | Bus + auto-handoff, Workshop marketplace live, Organizer MCP, optional Obsidian notes | [0.0.2.md](0.0.2.md) |
| **0.0.3** | Orchestrated v0, bring-your-own-assistant, reviewer + DAG + DoD, cost kill-switch, Daily Pulse | [0.0.3.md](0.0.3.md) |
| **0.0.4** | Cross-agent learning memory, browser element-pick, routing, minor voice | [0.0.4.md](0.0.4.md) |
| **0.0.5** | "Your Morz" — module registry + gated shell, first-run wizard, integration slots, fast planner default | [0.0.5.md](0.0.5.md) |
| Future | Remote mobile app ("Morz remote"), SaaS tier, open-source release, deep LSP | parked — see notes in each file |

## Distribution — ship as a real installable app (Windows + macOS)

Morz is a real desktop **program**, not a dev-only build. It must install and run like any native app on both platforms:
- **Windows** (primary): electron-builder NSIS one-click installer + auto-update (electron-updater / GitHub releases); **Azure Trusted / Artifact Signing** so SmartScreen + Defender don't flag it. (Signing is unsigned-personal for pre-alpha; set it up before wider distribution — an unsigned→signed switch breaks the updater chain.)
- **macOS** (after the Windows line is solid): electron-builder `.dmg` (+ optionally the App Store target); **Apple Developer ID signing + notarization** (`electron/notarize`) so Gatekeeper allows it; universal binary (arm64 + x64). Keep the PTY layer portable (node-pty already cross-platform; ConPTY → real PTY on macOS).
- **Cross-platform hygiene now:** keep the renderer/UI OS-agnostic; isolate Windows-specifics (ConPTY, DPAPI safeStorage, Job Objects, registry editor-probes, `%APPDATA%` paths) behind small platform modules so the macOS port is additive, not a rewrite. Native modules (node-pty via @lydell prebuilts, better-sqlite3) already ship macOS prebuilds.
- Installers/updates land alongside each version; real signed builds gate the first non-personal release.

**Global engineering rules (every version):**
- Own the PTY: node-pty/ConPTY inside an Electron `utilityProcess` PTY-host; renderer sandboxed (`contextIsolation`, no `nodeIntegration`).
- Structured over scraped; PTY injection only as fallback (agy).
- **Manual mode provably inert** — permanent CI gate: zero LLM calls, zero config writes without consent.
- Every spawned child tagged `MORZ_SESSION` GUID + Windows Job Object per run → clean kill, orphan sweep at startup.
- node-pty ABI-pinned to Electron's Node; real user PATH resolved at startup (login-shell capture).
- Playwright `_electron` torture tests land with each slice, not after.
- Progress tracking lives in [`../in-progress/`](../in-progress/).
