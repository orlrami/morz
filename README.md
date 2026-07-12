# Morz

Windows-first (macOS later) desktop app: a **terminal wrapper + lightweight IDE + pop-in file explorer + opt-in multi-agent CLI orchestration**. Personal-first — the union of what we love in **Warp** and **Herdr**, minus what each misses.

> **Guiding principle — "assist, don't take over."** Morz is a *dial*, not an autopilot: Manual (just a terminal) → Assisted (routing + auto-handoff) → Orchestrated (delegate a goal, propose → approve → spawn, scoped). Every automation is opt-in, scoped, and reversible.

## Status

**v0.1 — scaffold.** Boots an Electron + React shell with the locked design tokens. UI shell + terminal + orchestration land next (see `BUILD-BREAKDOWN.md`).

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

- `MORZ-Design-Direction.md` — locked visual + control direction
- `MORZ-Build-Plan.md` — phased roadmap
- `MORZ-Research-and-Vision.md` — competitive + technical research
- `BUILD-BREAKDOWN.md` — everything that will be built, by phase/module

## Build process

Built by a coordinated **multi-model agent network** (Claude Opus 4.8, Fable 5, GPT-5.6 / 5.6T, and others) working in parallel, each in its own git worktree per module/phase so they don't collide. UI is designed in **Figma** + a UI builder; core/backend in this repo.

## License

UNLICENSED (open-source vs commercial decision pending).
