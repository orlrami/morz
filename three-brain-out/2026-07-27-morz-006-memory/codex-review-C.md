## Verdict: FINDINGS

1. **HIGH — stale CAS accepts a second identical proposal.**  
   [apply.ts:119](/C:/Projects/run-20260728051623-26b58c-supersession/src/main/memory/apply.ts:119) treats any matching materialized result as an idempotent retry, without verifying the proposal ID. Two distinct proposals with the same target revision and replacement both approve; my reproduction returned `accepted`.  
   **Fix:** keep strict approval CAS separate from crash recovery. Only a persisted approved/unapplied proposal with the same idempotency key may use `isMaterialized`; new approvals must revalidate the target revision.

2. **HIGH — restore can produce two live facts.**  
   [apply.ts:218](/C:/Projects/run-20260728051623-26b58c-supersession/src/main/memory/apply.ts:218) archives a successor without rewiring its predecessor’s `supersededBy`. After `alpha → beta → gamma`, `alpha` still points to removed `beta`; [apply.ts:296](/C:/Projects/run-20260728051623-26b58c-supersession/src/main/memory/apply.ts:296) therefore allows restoring `alpha` while `gamma` is live. Link-less legacy expired rows are also always allowed through this guard.  
   **Fix:** atomically rewire the predecessor when archiving a successor, and make restore traverse the full chain with cycle detection. Use audit history or a migration index to guard legacy link-less rows.

3. **HIGH — derived revision-ID collision silently overwrites memory.**  
   [apply.ts:69](/C:/Projects/run-20260728051623-26b58c-supersession/src/main/memory/apply.ts:69) uses only 12 hash characters. [store.ts:366](/C:/Projects/run-20260728051623-26b58c-supersession/src/main/memory/store.ts:366) then replaces any existing file at that ID without checking ownership. I seeded an unrelated entry at the derived ID; applying the update changed its title from `UNRELATED` to the archived target.  
   **Fix:** fail closed when the derived ID already contains anything other than the expected retry materialization. Use a longer deterministic ID and explicit overwrite preconditions.

4. **MEDIUM — legacy proposal CAS ignores mutable fields.**  
   [apply.ts:131](/C:/Projects/run-20260728051623-26b58c-supersession/src/main/memory/apply.ts:131) compares only title and body when `targetRevision` is absent. A legacy proposal staged while enabled can still apply after the user disables the fact; my reproduction was accepted.  
   **Fix:** reject legacy UPDATE/DELETE proposals without a revision and require re-proposal, or migrate a complete revision snapshot.

5. **LOW — the crash matrix does not test real crash boundaries.**  
   [apply.test.ts:61](/C:/Projects/run-20260728051623-26b58c-supersession/src/main/memory/apply.test.ts:61) uses atomic in-memory Maps, and [apply.test.ts:170](/C:/Projects/run-20260728051623-26b58c-supersession/src/main/memory/apply.test.ts:170) retries the same harness. Failpoints occur only after the entire multi-file Markdown phase, never between archive write, successor write, and pruning.  
   **Fix:** add store-level failpoints after each rename/removal and restart against real temporary Markdown/SQLite state.

Confirmed passing: 27 memory unit tests, typecheck, production build, 5 memory-opset E2E tests, and 2 memory/bootstrap E2E tests. Manual save/remove reconciliation and sender-frame validation are wired correctly, but the findings above block CLEAN.

The apparent Orca research deletion in the supplied two-tree diff is branch-lag noise, not part of Agent C’s three commits; integrate the commits rather than applying that raw deletion hunk.