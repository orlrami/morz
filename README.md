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

All docs live under [`docs/`](docs/):
- [`docs/roadmap/`](docs/roadmap/) — **source of truth**: one file per version (0.0.1 → 0.0.4), each with deliverables + architecture.
- [`docs/in-progress/STATUS.md`](docs/in-progress/STATUS.md) — live build status.
- [`docs/MORZ-Backend-Plan.md`](docs/MORZ-Backend-Plan.md) — backend architecture.
- [`docs/MORZ-Design-Direction.md`](docs/MORZ-Design-Direction.md) — locked visual + control direction (Slate).
- [`docs/BUILD-BREAKDOWN.md`](docs/BUILD-BREAKDOWN.md) — full feature catalog.
- [`docs/research/`](docs/research/) — competitive + technical research (rounds 1–4).
- [`docs/archive/`](docs/archive/) — superseded plans (history only).

## Build process

Built by a coordinated **multi-model agent network** (Claude Opus 4.8, Fable 5, GPT-5.6 / 5.6T, and others) working in parallel, each in its own git worktree per module/phase so they don't collide. UI is designed in **Figma** + a UI builder; core/backend in this repo.

## License

UNLICENSED (open-source vs commercial decision pending).
