# Context Hub Implementation Plan

**Goal:** Add an opt-in Context module that scans known context files per space, proposes template/shared-block/memory updates through diff-first approvals, and never scans while disabled.

**Architecture:** A main-process `ContextHubService` validates every supplied space root, scans a fixed allowlist of relative paths, and delegates arbitrary Markdown file proposals to the existing config-writer's stable-read/atomic-apply machinery. A preload bridge exposes the service to a renderer Zustand store; the `ContextHubPanel` renders a spaces-by-files matrix and opens actual files through the existing `open-file` event. The local `modules.ts` copy adds `context` with `defaultOn: false` and is intentionally limited to the shared Agent 1 contract so the integrator can reconcile it cleanly.

**Tech Stack:** Electron 32, TypeScript 5.5, React 18, Zustand, Tailwind CSS, Playwright, Node `child_process.execFile`

**Estimated Tasks:** 5

## Global Constraints

- Scan only root, `.claude/`, and `docs/` candidates for the nine named context file kinds.
- A file is stale only when its mtime predates the oldest of the latest 20 commits touching `src/`.
- Scan on Context surface open and manual refresh only; register no watcher.
- Treat renderer roots, relative paths, block names, and template selections as untrusted.
- Every write is an individual proposal and requires explicit approval before config-writer apply.
- Managed shared and memory blocks replace an existing matching block and append otherwise.
- `context` is `defaultOn: false`; disabled means no context scan IPC.

---

### Task 1: Lock the context contract and scanner behavior

**Files:**
- Create: `src/shared/context-hub.ts`
- Create: `src/shared/modules.ts`
- Create: `src/main/services/context-hub.test.ts`
- Create: `src/main/services/context-hub.ts`

**Interfaces:**
- Produces: `ContextHubBridge`, `ContextMatrix`, `ContextFileState`, `ContextProposal`, and `registerContextHubIpc`.

- [ ] **Step 1: Write failing scanner tests**

Create temp Node and Python project roots and assert:

```ts
const matrix = await service.scan([{ id: 'node', name: 'Node', root }])
assert.equal(matrix.spaces[0].files.find((file) => file.kind === 'claude')?.state, 'missing')
assert.equal(matrix.spaces[0].projectType, 'node')
```

Also assert a file older than the 20th `src/` commit is `stale`, an in-root candidate is `present`, and a path outside the supplied root is rejected.

- [ ] **Step 2: Verify failure**

Run: `npx.cmd tsx --test src/main/services/context-hub.test.ts`

Expected: FAIL because `ContextHubService` does not exist.

- [ ] **Step 3: Implement the fixed-path scanner**

Use literal candidate arrays, `realpath`/`relative` prefix validation, `stat`, and:

```ts
execFile('git', ['log', '-20', '--format=%ct', '--', 'src'], {
  cwd: root,
  windowsHide: true
})
```

Choose the oldest returned timestamp as the stale cutoff. Do not recurse and do not watch.

- [ ] **Step 4: Verify pass**

Run: `npx.cmd tsx --test src/main/services/context-hub.test.ts`

Expected: all scanner tests PASS.

### Task 2: Generalize config-writer proposals and add templates

**Files:**
- Modify: `src/main/services/config-writer.ts`
- Modify: `src/shared/ipc.ts`
- Create: `resources/context-templates/node/CLAUDE.md`
- Create: `resources/context-templates/node/AGENTS.md`
- Create: `resources/context-templates/node/STATUS.md`
- Create: `resources/context-templates/python/CLAUDE.md`
- Create: `resources/context-templates/python/AGENTS.md`
- Create: `resources/context-templates/python/STATUS.md`
- Create: `resources/context-templates/generic/CLAUDE.md`
- Create: `resources/context-templates/generic/AGENTS.md`
- Create: `resources/context-templates/generic/STATUS.md`
- Test: `src/main/services/context-hub.test.ts`
- Test: `e2e/config-writer.spec.ts`

**Interfaces:**
- Consumes: existing config-writer stable-read and atomic apply.
- Produces: `proposeFile(path, newContent, label)` returning a proposal with a unified diff and applying with the existing optimistic-concurrency/backup checks.

- [ ] **Step 1: Write failing proposal tests**

Assert missing-file proposals diff from `/dev/null`, two proposals have distinct IDs, an unchanged re-proposal has an empty/no-op result, and applying a stale proposal fails closed with `CONFIG_CHANGED`.

- [ ] **Step 2: Verify failure**

Run: `npx.cmd tsx --test src/main/services/context-hub.test.ts`

Expected: FAIL because generic file proposals are unavailable.

- [ ] **Step 3: Implement generic file proposals**

Extend the stored proposal union without weakening the existing MCP config types. Missing targets use empty old content and create parent directories only during apply. Existing files retain timestamped backups; new files use exclusive creation so a race cannot overwrite user content.

- [ ] **Step 4: Add project-aware templates**

Add bounded starter content for Node, Python, and generic projects. Template selection is based only on the presence of `package.json`, `pyproject.toml`, `requirements.txt`, or `setup.py`.

- [ ] **Step 5: Verify pass and regression safety**

Run: `npx.cmd tsx --test src/main/services/context-hub.test.ts`

Run: `npx.cmd playwright test e2e/config-writer.spec.ts`

Expected: both PASS.

### Task 3: Add managed shared blocks and memory export

**Files:**
- Modify: `src/main/services/context-hub.ts`
- Modify: `src/main/services/context-hub.test.ts`

**Interfaces:**
- Produces: `proposeTemplate`, `proposeSharedBlock`, `proposeMemoryBlock`, and `applyProposal`.

- [ ] **Step 1: Write failing managed-block tests**

Assert:

```ts
assert.equal(
  proposals.length,
  2,
  'two selected spaces must receive two individually approvable diffs'
)
assert.match(memoryProposal.unifiedDiff, /<!-- morz:memory -->/)
assert.equal(secondMemoryProposal.unifiedDiff, firstMemoryProposal.unifiedDiff)
```

Also assert invalid block names, non-Markdown targets, disabled memories, and roots outside the selected spaces are rejected.

- [ ] **Step 2: Verify failure**

Run: `npx.cmd tsx --test src/main/services/context-hub.test.ts`

Expected: FAIL because managed block proposal methods do not exist.

- [ ] **Step 3: Implement deterministic block replacement**

Use exact markers:

```ts
const open = `<!-- morz:block:${name} -->`
const close = '<!-- /morz:block -->'
```

Replace one existing bounded block, reject malformed/duplicate markers, and append with normalized blank lines when absent. Render enabled global/project/space memories in stable kind/update/id order inside exactly one `<!-- morz:memory -->` block.

- [ ] **Step 4: Verify pass**

Run: `npx.cmd tsx --test src/main/services/context-hub.test.ts`

Expected: all managed-block and memory idempotency tests PASS.

### Task 4: Wire preload/store and build the matrix surface

**Files:**
- Modify: `src/main/index.ts`
- Modify: `src/preload/index.ts`
- Modify: `src/renderer/src/env.d.ts`
- Modify: `src/renderer/src/components/Shell.tsx`
- Create: `src/renderer/src/store/contextStore.ts`
- Create: `src/renderer/src/components/ContextHubPanel.tsx`

**Interfaces:**
- Consumes: `window.morzContext`, `useSpaceStore`, and `emit('open-file', { path })`.
- Produces: a Context rail/view entry only when the module contract reports `context: true`.

- [ ] **Step 1: Add the bridge and store**

Expose only typed invoke methods. The store receives the current spaces as explicit `{id,name,root}` values and calls `scan` only from `open(roots)` or `refresh(roots)`.

- [ ] **Step 2: Build the accessible matrix**

Render one row per space and one column per logical context-file kind. Use text plus icons for present/missing/stale, a named “Create from template” action for supported missing Markdown files, a refresh button, and file buttons that emit the actual resolved path to the IDE slide-over.

- [ ] **Step 3: Add proposal review**

Render each proposal as its own selectable diff, default all selected, apply sequentially, refresh after apply, and preserve an exact error boundary when one proposal fails.

- [ ] **Step 4: Verify renderer types**

Run: `npm.cmd run typecheck`

Expected: PASS.

### Task 5: Prove the end-to-end contract

**Files:**
- Create: `e2e/context-hub.spec.ts`

**Interfaces:**
- Exercises the built Electron application through the real preload/main boundaries.

- [ ] **Step 1: Write the failing E2E spec before renderer implementation is considered complete**

Cover:

```ts
test('missing CLAUDE.md creates a template only after diff approval', ...)
test('a shared block across two spaces yields two individual diffs', ...)
test('memory refresh re-proposes one idempotent managed block', ...)
test('disabled Context module sends zero scan IPC', ...)
```

Use isolated temp project roots and `MORZ_E2E_PICK_FOLDER`; do not touch the repository root fixtures.

- [ ] **Step 2: Run and verify RED**

Run: `npx.cmd playwright test e2e/context-hub.spec.ts`

Expected: FAIL on missing Context surface/bridge behavior.

- [ ] **Step 3: Complete only the minimum integration needed for GREEN**

Fix production behavior rather than loosening assertions. Keep the E2E-only module enable seam synchronous and isolated so Agent 1's module bridge can replace it at integration.

- [ ] **Step 4: Run target verification**

Run: `npm.cmd run typecheck`

Run: `npm.cmd run build`

Run: `npx.cmd playwright test e2e/context-hub.spec.ts`

Expected: all three commands PASS.

- [ ] **Step 5: Security and mutation review**

Confirm no renderer-controlled path reaches filesystem/git without root containment, no shell is used for git, proposals fail closed on concurrent edits, managed blocks cannot consume the remainder of a file, and disabling the module prevents the first scan call.

---

**Plan saved to `docs/plans/2026-07-24-context-hub.md`**

Execution mode: inline in this session, following the user's direct build request.
