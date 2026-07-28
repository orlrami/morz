## CLEAN — scoped to `eaa60a9`

- `assertRelocationSafe` now compares the on-disk occupant with the exact post-rewire entry that is subsequently written. Missing or revision-mismatched entries fail closed. [apply.ts](C:/Projects/run-20260728051623-26b58c-supersession/src/main/memory/apply.ts:281)
- Real-Markdown crash recovery converges exactly once at boundaries 1–4. The pre-fix parent reproduces exact collision failures at 1–2 and materialized recovery at 3–4. [apply.test.ts](C:/Projects/run-20260728051623-26b58c-supersession/src/main/memory/apply.test.ts:515)
- An independent probe confirmed a foreign occupant sharing `movedId` but having a different `memoryRevision` aborts before `writeEntries`.
- The check occurs after all rewiring and immediately before the synchronous write path. Moving it later narrows the check/write interval; only the existing external-writer race under the documented single-writer assumption remains.

Verification: targeted suite passed **26/26**, typecheck passed, and the `eaa60a9` worktree remained clean.