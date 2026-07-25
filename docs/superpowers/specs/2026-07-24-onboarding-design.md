# First-Run Onboarding Design

## Goal

Morz opens a single first-run configure screen for a fresh user-data directory, persists the user's CLI, module, integration-slot, and autonomy choices in SQLite, and can reopen the same screen from Settings.

## Architecture

`src/shared/onboarding.ts` is the boundary contract for main, preload, renderer, and E2E. It defines the nine detectable tools, model choices, integration slots, persisted snapshot, minimal defaults, and IPC channel names. `src/main/services/onboarding.ts` owns PATH detection and a single-row SQLite settings table. The renderer accesses it only through the sandboxed preload bridge.

`App` hydrates the onboarding store before mounting the shell. An incomplete profile mounts `OnboardingScreen`; a completed profile mounts `Shell`. Settings re-entry is renderer-local and does not clear the completed flag until the user explicitly saves or skips.

## Screen

The configure screen is split into a scrollable left form and sticky right preview.

1. **Your CLIs & default models** lists Claude Code, Codex, Antigravity, OpenCode, lazygit, gitui, VS Code, Cursor, and Ollama. Each row shows detected/missing state, a sanitized version, a fixed install link when missing, and a select whose first value is `Inherit CLI default`.
2. **Modules & your tools** shows the five locked core surfaces, opt-in module toggles, and git/review/editor provider choices. Unavailable local providers remain visible and disabled.
3. **Autonomy** offers Manual, Assisted, and Orchestrated cards. Orchestrated is disabled unless the orchestration module is enabled.

The live preview derives only from current form state. It renders a compact rail/tab shell, launch commands for the four agent CLIs, and a direct autonomy note. Every input update is immediately reflected without persistence.

## Persistence

The `onboarding_settings` table stores:

- `completed`
- enabled module map
- `models` map for all nine detection targets
- `slots` map for `git`, `review`, and `editor`
- autonomy mode
- `updated_at`

The save path validates every enum, model string length, module key, and slot provider in the main process before a transaction. Invalid payloads fail closed. “Skip — start minimal” saves the canonical minimal snapshot: Sessions on, optional modules off, terminal/off/Morz slots, inherited models, Manual autonomy.

## Shell Integration

Until the Wave 15 module branch is integrated, `Shell` reads the persisted onboarding module map to hide optional tabs and prevent their panels from mounting. The Orchestrator control and panel mount only when orchestration is enabled. This is deliberately compatible with the Agent 1 `ModuleId`/`MODULES` contract so integration can replace the temporary source without renaming fields.

## Security

- Detection uses executable paths resolved from PATH and `spawn(file, args)` without a shell.
- Probe output is byte-limited, timeout-limited, control-character stripped, and length-capped.
- Install URLs are compile-time HTTPS constants; no user-controlled URL reaches `shell.openExternal`.
- Renderer values are treated as untrusted and revalidated before SQLite writes.
- Errors return sanitized messages and never expose filesystem paths or raw database failures.

## Test Strategy

`e2e/first-run.spec.ts` uses isolated `MORZ_USER_DATA` directories and covers:

- fresh boot mounts configure instead of the shell;
- Skip persists minimal configuration across relaunch;
- selected modules persist and match the rendered shell tabs;
- preview tabs and launch defaults react before save;
- Settings reopens setup without corrupting the completed flag.

