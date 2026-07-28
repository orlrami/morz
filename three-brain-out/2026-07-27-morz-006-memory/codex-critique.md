## Recommendation

Do not approve the six-slice scope as written. Ship a narrower memory-v2 core, and move Obsidian, Hermes, and external providers out of 0.0.6.

The central ordering error is that reconciliation is being built before revision/temporal semantics, while procedural learning is scheduled before Morz has trustworthy cross-CLI outcome telemetry.

Recommended order:

1. **Storage and approval invariants**
   - Append-only revisions, compare-and-swap approval, durable idempotency keys, single-writer queue, migration backup/repair.
   - Close direct mutation paths or define them explicitly as user-approved operations.

2. **Temporal model and provenance**
   - Separate world-valid time from Morz transaction time.
   - Record original evidence event, run, agent, CLI/model, task/attempt and repository HEAD.
   - Link predecessor/successor revisions.

3. **Reconciliation**
   - Exact dedup first; strictly scoped neighbor retrieval; classifier only proposes.
   - Reconcile again at approval if the target revision changed.
   - Restrict classifier-generated DELETE to explicit deletion evidence; contradictions should normally supersede.

4. **Runtime delivery**
   - Produce one immutable, versioned snapshot per run/team and render CLI-specific views.
   - Keep automatic launch injection separate from approved Context Hub export. Do not modify repository files silently at launch.

5. **Telemetry shadow mode**
   - Pull the minimum normalized invocation/result seam forward from 0.0.7.
   - Collect typed, redacted events without producing memory cards.

6. **Procedural proposals**
   - Enable only after telemetry precision and attribution tests pass.
   - Begin with corrective procedures, not inferred tool preferences.

The proposed order is partly right—per-CLI delivery must precede procedural learning—but slices 1–2 should be reversed/merged around a proper revision model, slice 4 is blocked by 0.0.7, and slices 5–6 are scope expansion.

### Research claims: wrong or misapplied

| Source | Assessment |
|---|---|
| **mem0** | The four-way operation pattern is valid, but mem0 calls the no-change event `NONE`, not `NOOP`. “Top-10 per fact” describes a particular implementation/version, not a stable architectural law; current mem0 has additional additive extraction and hybrid retrieval paths. More importantly, Morz currently retrieves ten neighbors globally and only then filters scope, so it is not actually doing top-k within the same scope ([index.ts:386](/C:/Projects/morz/src/main/memory/index.ts:386)). See [mem0 prompts](https://github.com/mem0ai/mem0/blob/main/mem0/configs/prompts.py). |
| **Zep/Graphiti** | The four temporal fields and soft invalidation are real. Morz misapplies them: expiry defaults `invalidAt` to approval time, overwrites the old fact’s `sourceRunId` with the invalidating run, and restore erases `invalidAt` ([opset.ts:318](/C:/Projects/morz/src/main/memory/opset.ts:318)). That is not reliable bi-temporal history. Graphiti also preserves episode lineage and relation structure; a lone `sourceRunId` is not equivalent. Its current retrieval is semantic + keyword + graph traversal with configurable reranking—not universally “cosine+BM25+RRF.” See [Graphiti edges](https://github.com/getzep/graphiti/blob/main/graphiti_core/edges.py) and [README](https://github.com/getzep/graphiti). |
| **Letta** | Shared, ID-addressed and read-only blocks are accurately described. Rendering copies into three repository files is not the same pattern: it creates stale snapshots, not one live shared object. “Read-only” is also unenforceable markdown unless Morz prevents agents from writing the file. Letta’s docs explicitly warn concurrent block replacements are last-write-wins. See [Letta memory blocks](https://docs.letta.com/v1-sdk/memory/memory-blocks). |
| **Honcho** | `(observer, observed)` internal collections and asynchronous reasoning are current and accurate. “Postgres+Redis+two daemons” is overstated: Postgres/pgvector and an API plus worker are core; Redis is configuration-dependent, not a universal requirement. “One cheap call per batch” is also not a safe invariant. See [Honcho README](https://github.com/plastic-labs/honcho). |
| **Procedural literature** | There is no consensus `frequency × recency × success` formula. Generative Agents uses a weighted retrieval score involving recency, importance and relevance; Voyager depends on environment feedback and self-verification; ReasoningBank explicitly learns from successful **and failed** experiences; Memp studies build/retrieve/update with correction and deprecation. The proposed formula is a Morz heuristic and needs evaluation. See [Voyager](https://arxiv.org/abs/2305.16291), [ReasoningBank](https://arxiv.org/abs/2509.25140), and [Memp](https://arxiv.org/abs/2508.06433). |
| **Claude Code** | The 200-line/25KB index applies to auto-memory `MEMORY.md`, not a universal cross-CLI budget. `CLAUDE.md` loads fully, although shorter instructions adhere better. Claude also treats these files as context, not enforcement. See [Claude Code memory](https://code.claude.com/docs/en/memory). |

The most dangerous misapplication is “never promote failing patterns.” Never promote a failed action as a successful procedure, certainly—but failures are essential negative evidence for warnings, preconditions and corrected procedures. ReasoningBank reports an advantage specifically from learning contrastively from successes and failures.

### Cut or defer

- **Defer Obsidian backing.** It introduces a second writable source, sync loops, rename conflicts and unclear canonical authority. Start later with one-way approved export.
- **Defer Hermes/OpenClaw/Comet slots and remote providers.** They add data-residency, credential, availability and approval-boundary questions before the local contract is stable.
- **Cut superseded facts from launch prompts.** Keep history queryable in the UI; injecting stale facts beside current instructions increases ambiguity ([opset.ts:347](/C:/Projects/morz/src/main/memory/opset.ts:347)).
- **Cut raw “log every invocation” storage.** Store typed, redacted event summaries with retention limits.
- **Cut “prefers Codex for refactors” inference from success counts.** Routing policy and task difficulty confound the result; it does not establish user preference.
- **Defer topic-file generation** until each CLI’s import/on-demand behavior and budget accounting are tested.
- **Avoid classifier-generated DELETE initially.** Use explicit user deletion or temporal supersession.

## Blocking risks

Ranked:

1. **CRITICAL — Procedural learning has no trustworthy outcome source.**  
   Dispatched panes bypass the common adapter seam, permission states are incomplete, and auto-done is deferred to 0.0.7. “Success rate” would therefore score partial, blocked, interrupted and merely exited runs incorrectly.

2. **HIGH — Approval applies stale operations without revalidation.**  
   A proposal captures an old snapshot, but approval never checks that the target still matches it ([index.ts:266](/C:/Projects/morz/src/main/memory/index.ts:266)). Two agents can approve conflicting updates against the same revision.

3. **HIGH — Apply is not exactly-once or atomic.**  
   Markdown mutation, expiry, successor creation, audit insertion and `applied: true` are separate operations. Recovery may duplicate audit entries and, when IDs collide, create additional timestamped successor facts.

4. **HIGH — Scope delivery is already wrong.**  
   Dispatched prompt injection passes `projectRoot` and `agentId` but omits `spaceId`, so space memory is not delivered ([dispatcher.ts:325](/C:/Projects/morz/src/main/orchestrator/dispatcher.ts:325)). Standalone Claude uses its worktree `cwd`, which may not match base-root project scope. This breaks the proposed “one team block.”

5. **HIGH — “Shared/read-only” files are neither shared nor locked.**  
   Context Hub currently exports memory only to `CLAUDE.md` ([context-hub.ts:521](/C:/Projects/morz/src/main/services/context-hub.ts:521)). Copies across CLAUDE/AGENTS/GEMINI and worktrees can diverge, and agents can edit them.

6. **HIGH — Telemetry creates a secret and prompt-injection sink.**  
   Command arguments, tool inputs, prompts and output commonly contain tokens, environment values and source content. Persisting these and later rendering derived rules turns untrusted tool output into durable privileged instructions.

7. **HIGH — Approval fatigue during a wave.**  
   Bootstrap permits 1,000 candidates and reconciles them sequentially ([index.ts:475](/C:/Projects/morz/src/main/memory/index.ts:475)). Ten busy agents could generate a classifier/candidate storm with near-duplicate approval cards.

8. **MEDIUM — Mutation paths contradict the “every candidate reconciles” claim.**  
   Manual rule creation calls `memory.save` directly rather than reconciliation ([memoryStore.ts:113](/C:/Projects/morz/src/renderer/src/store/memoryStore.ts:113)). IPC also exposes save/remove directly ([index.ts:587](/C:/Projects/morz/src/main/memory/index.ts:587)). A manual Save can count as approval, but it still bypasses dedup and contradiction detection.

9. **MEDIUM — Audit data is insufficient for full recovery.**  
   Audit rows retain title/body but omit scope, kind, temporal metadata, complete provenance and revision linkage.

10. **MEDIUM — Memory IPC has a weaker trust boundary than Context Hub.**  
    Context Hub validates sender frame/origin; memory handlers do not. A compromised renderer could invoke direct save/remove operations.

## Assumptions

- “Rendered at launch into files” means an automatic file mutation, not merely an approved Context Hub diff. If every change still receives a file diff approval, that particular risk decreases—but launches may block or use stale exports.
- Eight to ten agents share one Electron main process and canonical store while operating in separate worktrees.
- Current `w15/memory-opset` code is partial 0.0.6 pre-work even though the request calls the directory “v1.”
- Memory candidates can originate from repository documents, CLI output and tool events, all treated as untrusted until approved.
- BridgeMemory tools were unavailable in this session, so no prior Morz decisions outside the supplied documents and repository were consulted.

## Confidence

- **Build-order and code risks: High (0.93).** Based on direct inspection of the current implementation.
- **mem0/Zep/Letta/Claude claims: High (0.88).** Checked against current primary documentation/source.
- **Honcho deployment characterization: Medium-high (0.78).** Its architecture has changed across versions.
- **Exact procedural scoring literature: Medium-high (0.82).** The papers clearly contradict “one consensus formula,” but an appropriate Morz formula still requires empirical evaluation.

Verification performed:

- `npm run typecheck` — passed.
- `npx playwright test e2e/memory-opset.spec.ts --reporter=line` — 3/3 passed.

Those tests validate the intended current behavior, but they encode two questionable choices: injecting superseded facts and applying operations without concurrent/stale-approval scenarios.

## Tests required

Before approving 0.0.6:

1. **Ten-agent reconciliation race:** identical and contradictory candidates concurrently; exactly one active successor and one applied idempotency key.
2. **Stale approval:** stage A and B against one target, approve A, then ensure B is reclassified or blocked.
3. **Crash matrix:** terminate after every expiry/write/index/audit/applied-flag boundary; restart must yield one result and one logical audit event.
4. **Scope matrix:** global/project/space/agent across base repo, ten worktrees and every CLI; prove zero missed scope and zero cross-space leakage.
5. **Snapshot consistency:** all agents in a dispatched team receive the same snapshot hash; define what happens when memory changes mid-run.
6. **Clean-tree guarantee:** launch ten agents and prove no tracked instruction file changes without a reviewed diff.
7. **Telemetry conformance:** Claude/Codex/agy success, failure, blocked approval, interruption, retry, partial completion and review rejection.
8. **Secret-redaction corpus:** API keys, JWTs, `.env` values, private keys and prompt-injection payloads never enter event logs, evidence cards or rendered memory.
9. **Temporal semantics:** backdated validity, late observation, correction, deletion and restoration without erasing historical truth.
10. **Load/backpressure:** 10,000 events plus 1,000 bootstrap candidates without UI stalls, unbounded classifier calls or proposal floods.