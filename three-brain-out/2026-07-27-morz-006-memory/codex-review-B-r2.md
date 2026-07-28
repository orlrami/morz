## Verdict: FINDINGS

- **MEDIUM — stale publisher can retake the registry after renderer reload.**  
  [space-registry.ts](C:/Projects/morz-blocks/src/main/services/space-registry.ts:105) rejects old generations only when `sender === publisherId`. After publisher `r2` replaces `r1`, a delayed `r1` message is considered a new publisher and overwrites `r2`. Repro: `r1:g2 → r2:g1 → r1:g3` produced `FINAL=old`. This can restore removed Spaces or inject memory from the wrong Space. Permanently fence retired publisher IDs, or bind publisher epochs to the renderer/webContents lifecycle so an old epoch cannot reclaim ownership.

Confirmed otherwise:

- Combined unlock+mutation is rejected.
- Team memory is snapshotted before launch; mid-dispatch changes remain consistent and intentionally apply next run.
- Canonical roots and duplicate-root rejection work.
- Ready registries allow legitimate unregistered-root dispatch; unavailable registries fail closed.
- Dispatcher and Claude-lane clean-tree gates pass.
- Multi-file and read-only context-block behavior passes.

Verification: 13/13 targeted Playwright tests, 32 unit tests passed with one platform skip, and typecheck passed. Worktree remains clean. The known duplicated `render.ts` commit was excluded.