# Morz

> **Status: parked.** I stopped working on Morz for now to focus on my main project, OnBase. I plan to come back to it.

Morz is a Windows desktop app I am building for myself. It is a terminal, a small code editor, a file explorer and an optional tool to run several AI coding agents (Claude Code, Codex, Gemini and others) at the same time, each in its own git worktree.

The main idea is "assist, do not take over". Morz has three levels. Manual is just a terminal. Assisted adds routing and handoff between agents. Orchestrated lets you give a goal, see a plan, approve it, and then the agents start. Every automation is opt in and can be undone.

## Where it is now

- Version 0.0.6, about 360 commits between July 11 and July 28, 2026.
- Working terminal with ConPTY, tabs, split panes and a command palette.
- Agent orchestration with a planner, per agent model choice and a review step before anything runs.
- A shared memory system for the agents, with a redacted event log and safe atomic updates.
- An MCP server package (`packages/morz-mcp`).
- 218 end to end tests passing with Playwright at the last release.

As a full end to end demo, Morz's agents built a small Snake game in Python and the web.

## Stack

Electron · TypeScript · React · Zustand · xterm.js (+webgl/serialize/fit/web-links) · node-pty (ConPTY) · CodeMirror 6 · dockview · better-sqlite3 · electron-vite. (= wmux's proven Windows-first stack; Discord's model.) Portable toward a possible Tauri v2 rewrite later.

## Run (dev)

```bash
npm install
npm run dev        # electron-vite dev — opens the Morz window
npm run typecheck  # tsc on main + renderer
npm run build      # production build
```

> Requires Windows 10 build 18309+ (for ConPTY, used from Phase 1). Native `node-pty` arrives in Phase 1 with an `electron-rebuild` step.

## Repo map

```
src/
  main/       Electron main process (window; Phase 1: spawns PTY-host + brokers IPC)
  preload/    contextBridge IPC surface (typed via src/shared/types.ts -> MorzApi)
  renderer/   React UI
    src/theme/     design tokens (graphite/quartz/bronze) — source of truth
    src/components/  UI (from Figma / UI builder) — Phase 0/1
  shared/     domain types shared across processes
db/           SQLite schema (spaces/sessions/agents/tasks/checkpoints)
```

## Docs

All docs live under [`docs/`](docs/):
- [`docs/roadmap/`](docs/roadmap/) — **source of truth**: one file per version (0.0.1 → 0.0.4), each with deliverables + architecture.
- [`docs/in-progress/STATUS.md`](docs/in-progress/STATUS.md) — live build status.
- [`docs/MORZ-Backend-Plan.md`](docs/MORZ-Backend-Plan.md) — backend architecture.
- [`docs/MORZ-Design-Direction.md`](docs/MORZ-Design-Direction.md) — locked visual + control direction (Slate).
- [`docs/BUILD-BREAKDOWN.md`](docs/BUILD-BREAKDOWN.md) — full feature catalog.
- [`docs/research/`](docs/research/) — competitive + technical research (rounds 1–4).
- [`docs/archive/`](docs/archive/) — superseded plans (history only).

## How I built it

I designed Morz and made the product and architecture decisions. I used AI coding agents (Claude and Codex) to help build it, each one working in its own git worktree, and I had every change reviewed by a different model before merging. Morz itself is a tool for working this way.

## License

All rights reserved for now. I have not decided on an open source license yet.
