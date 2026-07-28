# AGY Brief — Morz 0.0.6 "Memory that Works" design critique          <!-- type: design -->

## Context
Morz is a Windows-first Electron AI terminal/IDE that orchestrates CLI coding agents (Claude Code, Codex, Antigravity, OpenCode) in parallel git worktrees. Shipped through 0.1.5: terminal, event bus, orchestrator with planner (plan → approve → dispatch), markdown-per-fact memory store with FTS5 + approval-gated writes, context-hub (CLAUDE.md/AGENTS.md/STATUS.md manager with templates). Local-first, no cloud, everything approval-gated and diff-first.

## Goal
Adversarial design critique of the 0.0.6 scope (memory v2), before we commit a 8-10 agent build wave to it. Is the build order right, what is missing, what should be cut or deferred, and are the claimed patterns correctly borrowed?

## Inputs
Read these files (absolute paths):
- C:\Projects\morz\docs\roadmap\REMAINING.md  (section "0.0.6 — Memory that Works" = the scope under review; also skim 0.0.7 for what is deliberately deferred)
- C:\Projects\morz\docs\research\MEMORY-SYSTEMS-RESEARCH.md  (the research the design rests on: Honcho, mem0, Letta, Zep, Claude Code memory study)
- C:\Projects\morz\src\main\memory\  (current memory v1 implementation: store, bootstrap, opset)
- C:\Projects\morz\src\main\services\context-hub.ts  (context-file manager the per-CLI rendering must merge with)

The six slices under review: 1) op-set reconciliation (ADD/UPDATE/DELETE/NOOP as the approval card), 2) bi-temporal facts (valid_at/invalid_at, soft-expiry), 3) per-CLI rendering into CLAUDE.md/AGENTS.md/GEMINI.md as managed morz:memory blocks + shared team blocks, 4) procedural learning (tool-invocation logging → scored → proposed preference cards, never auto-persisted), 5) optional Obsidian vault backing, 6) Hermes assistant deepening / pluggable providers.

## Known / already tried
- Rejected already (do not re-propose): graph DBs, Postgres/Redis, background daemons, LLM on the launch path, unapproved writes.
- Memory v1 ships: markdown-per-fact + FTS5, bootstrap scan of existing .md files, approval-gated op-set application.
- Constraint: injection budget ~200 lines into context files; agents are external CLIs we do not control.

## Deliverable
Write your COMPLETE answer as markdown to: C:\Projects\morz\three-brain-out\2026-07-27-morz-006-memory\AGY_RESULTS.md
1. Recommendation (one line)
2. Proposed design — where you would deviate from the six slices: components, data flow, contracts
3. Ranked critique of the scope as written (concrete: slice → change)
4. Tradeoffs vs alternatives
5. Blocking risks
6. Confidence low/med/high
7. What to validate before committing the wave
After writing the file, print exactly: DONE
