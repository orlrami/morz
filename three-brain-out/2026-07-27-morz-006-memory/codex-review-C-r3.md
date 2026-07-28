## FINDINGS

- **HIGH — `targetFix` crash recovery is not idempotent.** In [apply.ts](C:/Projects/run-20260728051623-26b58c-supersession/src/main/memory/apply.ts:257), collision checking expects the relocated occupant to match the initial “verbatim” `moved` entry. But [withRewiredPredecessor](C:/Projects/run-20260728051623-26b58c-supersession/src/main/memory/apply.ts:218) subsequently changes that same entry’s `supersededBy`. If the process crashes after this first durable write, retry reconstructs the unmodified version and aborts at line 260 with:

  `Another memory already occupies the archived revision id`

  I reproduced this against `writeEntryDocuments`: crash after the relocated occupant write, then retry with `isRetry: true` consistently fails. The existing `targetFix` test uses the atomic Map harness, so it cannot expose this boundary.

  **Fix:** collision-check against the final rewired relocation entry, or accept both deterministic pre/post-rewire forms during recovery. Add a real-disk crash matrix for every `targetFix` write boundary.

Confirmed otherwise:

- The ordinary `use-bun` occupant → `use-npm` live-head repro is fixed.
- A completed `targetFix` chain is walkable, and restoring the archived target preserves its rewired `supersedesId`.
- Production restore builds one Markdown snapshot plus one `SELECT DISTINCT` audit map.
- 200-revision benchmark passed at 255 ms, below 500 ms.
- 38 memory unit tests, 5 memory E2E tests, and typecheck passed.