## Verdict: FINDINGS

1. **HIGH — expired successor occupants are destructively overwritten.**  
   [apply.ts:273](/C:/Projects/run-20260728051623-26b58c-supersession/src/main/memory/apply.ts:273) rejects only non-expired occupants. An expired occupant is replaced without preserving or rewiring it. If it already points to a live successor, the apply produces two live heads. My repro ended with both `use-bun` and `use-npm` live.

   The audit justification is incorrect: [auditFor](/C:/Projects/run-20260728051623-26b58c-supersession/src/main/memory/apply.ts:301) records the proposal target and new successor, not the overwritten occupant. Legacy or hand-written occupants may have no previous audit, and the audit schema does not preserve their complete revision.

   **Fix:** the suffix/archive-recovery story is needed now. Before claiming the clean successor ID, move any expired occupant to its own full-revision archive ID and atomically rewire both adjacent links, with collision checks. Otherwise fail closed with a recoverable resolution path.

2. **MEDIUM — long restore chains synchronously reparse the entire store per hop.**  
   [assertRestoreAllowed](/C:/Projects/run-20260728051623-26b58c-supersession/src/main/memory/apply.ts:364) calls `getMemory` for every BFS node, while [getMemory](/C:/Projects/run-20260728051623-26b58c-supersession/src/main/memory/store.ts:140) rereads and parses every Markdown document. The audit fallback also runs an unindexed `target_id` query per node at [opset.ts:314](/C:/Projects/run-20260728051623-26b58c-supersession/src/main/memory/opset.ts:314).

   Temp-directory benchmark:

   - 50 revisions: 1.0s
   - 100 revisions: 6.1s
   - 200 revisions: 15.7s

   This blocks the main process. Load entries once into an ID map, build audit adjacency once or index `target_id`, then traverse in memory.

Round-1 fixes 1–5 and the live-occupant portion of fix 6 are confirmed. The real-disk predecessor/archive/successor/prune crash repro converged exactly once at every boundary. No extraction drift was found in `documents.ts`.

Verification: 37/37 focused unit tests, 5/5 memory-opset E2E tests, typecheck, and production build passed. Worktree remained clean.