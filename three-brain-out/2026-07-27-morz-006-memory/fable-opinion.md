# Fable 5 independent opinion (subagent fable-opinion, 2026-07-27)

## Recommendation
Cut 0.0.6 from six slices to two-and-a-half: slices 1 and 2 already shipped (commit `d374a68`, UI and e2e included), so the real wave is slice 3 (per-CLI rendering) plus a *logging-only* stub of slice 4 — and slice 3 must be an explicit approval-gated sync action, not a launch-time file write.

## Blocking risks (ranked)
1. "Rendered at launch into CLAUDE.md/AGENTS.md/GEMINI.md" contradicts standing rules and re-creates the 0.0.7 kickoff.md leak (git-tracked files; dirties every run diff; the 2026-07-22 HIGH finding class). Launch path already injects in-memory with zero file churn (learn-port.ts:129 → claude.ts:363, dispatcher.ts:327). Rendering into files must be user-triggered sync (proposeMemoryBlock, context-hub.ts:521). Decide before any agent starts or two agents build two truths.
2. Slice 5 (Obsidian) is a data-loss vector as specified: saveMemory deletes any `${id}.md` under the memory root (store.ts:358); parseMemoryFile rejects non-canonical paths (store.ts:199); vault renames → startup warnings; filename collision silently deletes a user note. Cannot share a root with a vault. Cut or one-way read-only mirror.
3. Slice 4 has no substrate, blocked on 0.0.7: nothing logs tool invocations (learner.ts regex-matches user text only; tool_use parsing is renderer display only, claude-events.ts:138). Outcome half doesn't exist for dispatched panes (0.0.7 items 2+4). Scoring only Claude-adapter lanes = biased signal → noisy approval cards discredit the gate. Research doc flags scoring formulas as unconfirmed.
4. Two divergent memory renderers will drift: renderInjectionLines (titles, 2000-char budget, opset.ts:347) vs renderMemories (full bodies, context-hub.ts:346; throws when nothing enabled, :355 — wrong for automation). Slice 3 must unify.
5. Bi-temporal chains unwalkable — no supersession link. UPDATE mints synthetic id `${id}-${Date.now().toString(36)}` (memory/index.ts:291); live entry gets mangled id; only link is audit target_id; injection can only say "used until date", never "now Z" (opset.ts:374). Restore un-expires without checking live successor → two active near-duplicates. Fix before slice 3 depends on validity windows.
6. Read-path cost, multiplied by slice 5: getMemory parses every file per lookup (store.ts:339); searchMemory calls it per row (store.ts:404) → O(files × results); startup rebuilds full FTS index (store.ts:278). Fine at dozens, not vault scale.
7. Slice 6 pluggable providers = speculative abstraction, no second implementation, candidates on the rejected list, no store interface exists (free functions).
8. Wave parallelism doesn't fit: four of six slices touch store.ts / memory/index.ts / shared/memory.ts — one hot core. 8-10 agents = merge conflicts, not throughput.

## Assumptions
- main at 48f7879 baseline; d374a68/86e04fc merged (verified via git log) → REMAINING.md 0.0.6 list is stale, not unmerged work.
- e2e memory specs pass (existence read, not results).
- "Rendered at launch" means launch-time file writes; if it always meant the in-memory preamble, risk 1 collapses and slice 3 shrinks to renderer unification + space shared block.
- 0.0.7 lands after 0.0.6 — nothing here can assume normalized adapter events.

## Confidence
High on "slices 1+2 done", slice-5 data-loss, slice-4 substrate (read from code + git history; OpDiff UI MemorySettings.tsx:26 + restore path confirm end-to-end). Medium on slice-3 recommendation (hinges on "rendered at launch" intent). Low-medium on read-path perf (shape certain, no measured store sizes).

## Tests required
Slice 3: one canonical renderer both outputs; empty store renders empty block not throw; proposeMemoryBlock agents/gemini round-trips replaceManagedBlock idempotently, other morz:block survive; marker-text escaping extended to new kinds (context-hub.test.ts:390); **e2e: launch lane → `git status --porcelain` empty** (regression gate regardless of decision); space-scoped fact appears in every teammate preamble of that space only; read_only rejects proposeMemoryBlock AND saveMemory.
Slice 2 finish: UPDATE → supersededBy/supersedesId both directions; injection renders "used X until date (now Y)"; restore with live successor fails or expires successor; migration from d374a68 store loads clean.
Slice 4 logging-only: crash-safe JSONL tail (learner.ts:174 contract); rotation/size cap; **listMemoryProposals() unchanged after N logged invocations** (guardrail); off under MORZ_E2E; manual mode writes zero records.
Cross-cutting: perf smoke 500 synthetic facts — startup rebuild + one search under fixed budget.

## Build-order verdict
Reorder to 3 → 2-finish → 4-logging-only. Cut 1 (shipped; owed at most an audit browser UI), 5 (one-way export mirror later, own root), 6 (keep only Hermes context-hub injection if genuinely small, folded into slice 3).
Wave width 3-4 agents: renderer unification (blocks rest) · context-hub file kinds + shared blocks · supersession link + migration · event log; git-clean e2e gate owned by first lander. Extra capacity → 0.0.7 adapter-seam unification (independent of memory, and what slice 4 actually waits on).
