FINDINGS

1. HIGH — Read-only facts can be rewritten during “unlock”

Location: [memory.ts](C:/Projects/morz-blocks/src/shared/memory.ts:66), enforced from [store.ts](C:/Projects/morz-blocks/src/main/memory/store.ts:347)

`memoryWriteRejection()` accepts any candidate containing `readOnly: false`. The same request can simultaneously change `title`, `body`, scope, or enabled state:

```ts
save({ ...locked, readOnly: false, body: 'replacement' })
```

I reproduced this; the rejection result is `null`. This violates “clearing the flag is the one permitted write” and gives raw IPC, bootstrap/op-set code, or a compromised renderer a one-call bypass.

Fix: add a dedicated `unlockMemory(id)` operation, or permit `readOnly:false` only when every other persisted field exactly matches the stored entry. Test combined unlock+mutation and require rejection.

2. HIGH — Team memory is rendered separately for every agent and can drift

Location: [dispatcher.ts](C:/Projects/morz-blocks/src/main/orchestrator/dispatcher.ts:332), [dispatcher.ts](C:/Projects/morz-blocks/src/main/orchestrator/dispatcher.ts:415)

`prependRenderedMemory()` calls `memoryPort.render()` inside `launchAgent()`. Agents launch sequentially with asynchronous git/worktree/pane operations between them. A memory change during dispatch therefore gives later agents a different “shared” space block.

The E2E only proves identical output while the store remains unchanged: [memory-team.spec.ts](C:/Projects/morz-blocks/e2e/memory-team.spec.ts:162).

Fix: resolve the space and snapshot/render global+project+space memory once before the launch loop. Reuse that exact byte string for every agent, adding agent-scoped memory separately if required. Add a test that mutates memory between agent launches and verifies the shared portion remains identical.

3. MEDIUM — Registry validation permits ambiguous root poisoning

Location: [space-registry.ts](C:/Projects/morz-blocks/src/main/services/space-registry.ts:53), [space-registry.ts](C:/Projects/morz-blocks/src/main/services/space-registry.ts:94)

The main process enforces unique IDs but not unique canonical roots. I reproduced publication of:

```ts
[
  { id: 'poisoned', root: 'C:\\Projects\\morz' },
  { id: 'real', root: 'C:\\Projects\\morz' }
]
```

With `activeSpaceId: 'real'`, exact resolution returns `poisoned` because `find()` selects the first entry. Path aliases such as `C:\Projects\morz` and `C:\Projects\.\morz` have the same problem. This lets malformed or poisoned renderer state inject another space’s memory.

Fix: reject duplicate `comparableRoot(root)` values, canonicalize with `realpath`, validate existence/directory status, and test duplicate/path-alias roots. Longer term, main should own or independently verify the ID↔root mapping rather than treating renderer-local storage as authoritative.

4. MEDIUM — Registry readiness is not part of dispatch, so cold/stale state silently drops memory

Location: [spaceStore.ts](C:/Projects/morz-blocks/src/renderer/src/store/spaceStore.ts:292), [space-registry.ts](C:/Projects/morz-blocks/src/main/services/space-registry.ts:31), [dispatcher.ts](C:/Projects/morz-blocks/src/main/orchestrator/dispatcher.ts:336)

Publication is fire-and-forget. A failed publish only resets `lastPublished`; no retry occurs until some later store change. Main starts with an empty registry, and dispatch proceeds when `resolveSpaceId()` returns `undefined`. Consequently a cold-start race silently omits space memory. The global registry also lacks publisher ownership/versioning, so stale state survives renderer reloads until another publish lands.

Fix: publish explicitly after hydration, retry until acknowledged, track a generation/publisher, and make dispatch await a ready registry or fail closed with “space registry unavailable.” Do not silently convert an expected registered space into `spaceId: undefined`.

5. MEDIUM — The required clean-tree lane gate tests the wrong launch path

Location: [clean-tree.spec.ts](C:/Projects/morz-blocks/e2e/clean-tree.spec.ts:55), particularly [lines 104–110](C:/Projects/morz-blocks/e2e/clean-tree.spec.ts:104)

The spec requires launching a standalone lane into a git worktree. This test dispatches a team under `MORZ_DISPATCH_STUB`, exercising dispatcher kickoff generation—not `src/main/adapters/claude.ts`. A future launch-time write in the actual Claude lane path would not fail this gate.

Fix: create a linked worktree, place a fake `claude` executable on `PATH`, call `morz.claude.start({cwd: worktree})`, submit the first prompt if necessary, then assert both trees remain clean and no context files were created or changed. Keep the dispatcher test as an additional gate.

Verification performed:

- Relevant unit suites: 26 passed, 1 platform skip.
- Targeted Playwright suites: 12/12 passed.
- `npm run typecheck`: passed.
- Worktree remained clean.

The multi-kind proposal flow, apply-time file CAS, ordinary op-set/bootstrap routing through `saveMemory`, marker rejection, and preload-to-main shape validation otherwise looked sound.