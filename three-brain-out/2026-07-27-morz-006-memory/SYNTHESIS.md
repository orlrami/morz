# SYNTHESIS — Morz 0.0.6 "Memory that Works" (2026-07-27)

Three independent reviews: AGY (Gemini 3.1 Pro, design brief), Codex (GPT-5.5 high-reasoning, adversarial), Fable 5 (independent subagent, code-grounded). Full texts: AGY_RESULTS.md, codex-critique.md, and the fable-opinion message (filed below as fable-opinion.md).

## Verdict
**Do not build the six-slice scope as written.** All three brains reject it independently, for overlapping reasons. The wave shrinks to 3–4 memory agents plus 0.0.7 adapter pre-work.

## CONVERGE (all three agree — do these)
1. **Defer procedural-learning proposals.** No trustworthy outcome telemetry exists until 0.0.7's adapter unification; dispatched panes bypass the seam entirely (`{usd:null,tokens:null}`, waiting-looks-like-working). Ship in 0.0.6 only a typed, redacted, size-capped event log with a hard guardrail: **zero proposals emitted from it this wave** (asserted by test). Scoring/promotion later, calibrated on real data.
2. **Cut pluggable memory providers (Honcho/mem0).** Contradicts our own rejected-infrastructure list; no second implementation exists; there isn't even a store interface today, just free functions. Speculative abstraction.
3. **Cut Obsidian vault backing from this wave.** As specced it's a data-loss vector: `saveMemory` deletes any `${id}.md` under the store root (store.ts:358); vault collisions silently kill user notes; renames produce startup warnings. Revisit only as a one-way export mirror with its own root.
4. **No silent repo-file writes at launch.** "Rendered at launch into CLAUDE.md/AGENTS.md/GEMINI.md" as written recreates the kickoff.md leak class (HIGH finding, bit us 2026-07-22) and dirties every run diff. Launch injection stays in-memory (learn-port.ts already does this); file rendering is an approval-gated context-hub sync (`proposeMemoryBlock`). Regression gate: e2e asserting `git status --porcelain` clean after lane launch.
5. **Unify the two renderers + enforce the index budget.** `renderInjectionLines` (titles, 2000-char budget) and `renderMemories` (full bodies, throws when empty — context-hub.ts:346/355) will drift; the context-hub block dumps entire bodies with no budget. One canonical renderer module feeding both the preamble and the managed block.
6. **Slices 1–2 are largely already shipped** (w15/memory-opset merged: op-set, hash dedup, audit table, OpDiff UI, restore). REMAINING.md's 0.0.6 list is stale. Re-planning them burns agents rewriting working code.

## NET-NEW per brain (verified leads worth acting on)
**Codex (code-verified bugs, fix in wave):**
- Stale-approval race: apply never revalidates the target still matches the proposal snapshot (memory/index.ts:266) — two agents can approve conflicting updates. Needs compare-and-swap semantics.
- **Dispatcher drops `spaceId`** in prompt injection (dispatcher.ts:325) — space-scoped memory never reaches dispatched teams. Breaks the "one team block" idea before it starts. Real bug today.
- Apply is not atomic/exactly-once across markdown write + expiry + audit + applied-flag; crash recovery can duplicate.
- Memory IPC lacks the sender-frame validation context-hub has — weaker trust boundary.
- Superseded facts are injected into launch prompts (opset.ts:347) — cut from prompts, keep queryable in UI.
- Secret/prompt-injection sink: raw invocation logging would persist tokens/env values → redaction corpus required.
- Research-doc corrections: mem0 says NONE not NOOP; Zep expiry semantics misapplied (restore erases invalidAt, sourceRunId overwritten); Letta blocks are live shared objects, not rendered copies; 200-line budget is Claude auto-memory MEMORY.md policy, not a universal CLI budget; no consensus procedural-scoring formula exists (ReasoningBank learns from failures too — "never promote failing patterns" is wrong as stated).
**Fable (code-verified):**
- No supersession link: UPDATE mints mangled successor ids (memory/index.ts:291), audit `target_id` is the only chain; injection can never render "used X until Y (now Z)". Restore can leave two active near-duplicates. Fix before rendering depends on validity windows.
- Read path is O(files × results) full-file parses (store.ts:339/404); fine at dozens of facts, not vault scale. Perf smoke: 500 facts under budget.
- Manual save + IPC save/remove bypass reconciliation entirely (memoryStore.ts:113) — "every candidate reconciles" is currently false.
**AGY:**
- Op-set LLM generation must stay async off the launch/UI path, cheap model.
- Out-of-band human deletions (Obsidian or otherwise) need an explicit contract: next scan emits implicit op-set events; human delete may hard-delete, overriding soft-expiry.

## ADJUDICATED (disagreements settled by evidence)
- AGY says defer slice 4 wholesale to 0.0.8; Fable/Codex allow a logging-only stub now. **Adopted: logging-only stub** — the log schema is independent of the adapter seam and having data early helps calibrate; the no-proposals test keeps AGY's concern satisfied.
- AGY proposes topic files now; Codex says defer until each CLI's import behavior is tested. **Adopted: defer topic-file split** behind a validation task (does Codex/agy actually follow `@`-style references?). Budget enforcement doesn't wait, though.
- Wave width: Fable says 3–4 agents; AGY/Codex silent-to-compatible. **Adopted: 3–4 memory agents + remaining capacity to 0.0.7 adapter-seam pre-work** (both Fable and Codex explicitly point spare capacity there).

## Revised 0.0.6 wave (wave 17) — proposed
1. **renderer-core**: one canonical memory renderer (preamble + managed block from same input; empty store renders empty block, never throws); budget enforcement; superseded facts out of prompts. BLOCKS 2,3.
2. **context-blocks**: `proposeMemoryBlock` extended to agents/gemini kinds + read_only + `space` shared team block; fix dispatcher `spaceId` drop; clean-tree e2e gate.
3. **supersession**: `supersedesId`/`supersededBy` fields + migration; CAS stale-approval check; restore guard (never two active successors); atomic apply ordering; route manual save through reconciliation; IPC sender validation.
4. **event-log**: typed redacted tool-invocation log (JSONL, rotation, crash-safe tail); redaction corpus test; asserted zero-proposals guardrail; manual-mode writes nothing.
5.–6. (if capacity) **0.0.7 pre-work**: adapter-seam bridge for dispatched panes; auto-done event plumbing.

Also: REMAINING.md 0.0.6 section must be rewritten to match (it's stale — lists shipped work as future).

## Trail
(3brain: AGY design critique high-conf · Codex adversarial 0.93/0.88 conf + typecheck/e2e run · Fable independent code-grounded high-conf · converged 6 points, adjudicated 3)
