# Wave 17 — 0.0.6 "Memory that Works" (revised core) + 0.0.7 pre-work

*Scope set by the 2026-07-27 three-brain consensus round (AGY + Codex + Fable independent reviews). Record: `three-brain-out/2026-07-27-morz-006-memory/SYNTHESIS.md`. The old six-slice 0.0.6 plan is dead — slices 1–2 shipped in waves 15/16, slices 5–6 cut.*

## Decisions already made (do not relitigate)

- **Launch injection never writes files.** Memory reaches agents in-memory (`learn-port.ts` preamble path). Rendering into CLAUDE.md/AGENTS.md/GEMINI.md happens ONLY through approval-gated context-hub proposals. Regression gate: after launching a lane, `git status --porcelain` in its worktree is EMPTY.
- **One renderer.** `renderInjectionLines` (opset.ts) and `renderMemories` (context-hub.ts) merge into one canonical module consumed by both paths. Empty/all-disabled store renders an empty managed block — never throws.
- **Superseded facts do not enter prompts.** History stays queryable in the UI.
- **Event log emits no proposals in this version.** It is substrate for 0.0.7 procedural learning, nothing more. A test asserts `listMemoryProposals()` unchanged after N logged events.
- **No Obsidian, no pluggable providers, no topic files** this wave.

## Known real bugs this wave fixes

| Where | Bug |
|---|---|
| `src/main/orchestrator/dispatcher.ts:325` | Prompt injection passes `projectRoot`+`agentId` but drops `spaceId` — space-scoped memory never reaches dispatched teams |
| `src/main/memory/index.ts:266` | Apply never revalidates the proposal's target snapshot — two agents can approve conflicting updates (stale-approval race) |
| `src/main/memory/index.ts:291` | UPDATE mints synthetic successor id `${id}-${timestamp}` — live fact gets mangled id, no supersession link either direction |
| `src/main/services/context-hub.ts:346-369` | Memory block renders full bodies, no budget; `renderMemories` throws when nothing enabled |
| `src/main/memory/opset.ts:347` | Superseded facts render into launch injection |
| `src/renderer/src/store/memoryStore.ts:113` + memory IPC | Manual save bypasses reconciliation; memory IPC lacks the sender-frame validation context-hub has |

## Agents (6)

| Agent | Slice | Depends on |
|---|---|---|
| A renderer-core | canonical renderer + budget + superseded-facts cut | — (BLOCKS B, C) |
| B context-blocks | agents/gemini block kinds, read_only, space team block, spaceId fix, clean-tree gate | A (renderer contract) |
| C supersession | links + migration, CAS, restore guard, atomic apply, manual-save routing, IPC validation | A (types only — coordinate on shared/memory.ts) |
| D event-log | typed redacted invocation log, zero-proposal guardrail | — |
| E adapter-seam (0.0.7 pre) | dispatched panes through AgentAdapter seam (or narrow terminal-event bridge) → normalized events | — |
| F planner-models (0.0.7 pre) | SpawnPlan 1.1 per-agent `model` + model catalog in planner prompt + opencode in cli enum | — |

Full prompts: [`WAVE17-AGENTS.md`](WAVE17-AGENTS.md).

## Exit criteria
Full e2e green (new: clean-tree gate, supersession migration, redaction corpus, zero-proposal guardrail) → integrator merges A→B/C then D/E/F → rebuild signed exe → dogfood. Perf smoke: 500 synthetic facts, startup + one search under budget (documents whether a vault-scale store is ever viable).
