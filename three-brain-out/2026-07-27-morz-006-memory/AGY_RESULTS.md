# AGY 0.0.6 Design Critique: "Memory that Works"

## 1. Recommendation
De-risk the wave by cutting the external-provider and two-way sync scope creep, defer procedural learning until CLI interception is reliable in 0.0.7, and focus purely on a local SQLite-indexed bi-temporal store with an enforced context-hub index budget.

## 2. Proposed design
Deviating from the six slices to ensure the design remains local-first, lean, and buildable:
- **Components**:
  - `MemoryStore`: Retains the v1 markdown-per-fact substrate (as mandated by the research) but adds a synchronized SQLite FTS5/audit index to efficiently query bi-temporal fields (`valid_at`, `expired_at`). 
  - `ReconciliationWorker`: An asynchronous pipeline that takes raw candidate facts, performs top-k retrieval, and runs a fast LLM pass to generate the Op-Set (ADD/UPDATE/DELETE/NOOP) *off* the latency-critical path.
  - `ContextHub` (Upgraded): Modified to write full memory content to auxiliary topic files (e.g., `.claude/topics/*.md`) and only inject a constrained index into `CLAUDE.md`/`AGENTS.md`.
- **Data Flow**: Agent proposes fact → `ReconciliationWorker` retrieves similar facts & generates Op-Set → User approves Op-Set card → Markdown written + SQLite audit updated → `ContextHub` renders topics + updates CLI index.
- **Contracts**: 
  - Pluggable memory providers (Slice 6) are DROPPED. The interface is strictly Morz-native. 
  - Obsidian (Slice 5) is supported passively: if a user edits/deletes markdown, the next `scan()` detects it and emits implicit Op-Set events, overriding the "never delete" rule for out-of-band human actions.

## 3. Ranked critique of the scope as written

1. **[BLOCKING] Slice 4 (Procedural learning) is out of sequence.**
   - *Issue:* Requires logging "every CLI/tool/skill invocation + outcome". However, `REMAINING.md` explicitly defers "Dispatcher ⇄ adapters unification → normalized permission/block/result events" to 0.0.7. We cannot robustly extract tool telemetry from raw PTY streams across varied CLIs in 0.0.6.
   - *Change:* Defer Slice 4 to 0.0.8, after the adapter unification provides the necessary normalized event hooks.

2. **[ARCHITECTURAL CONTRADICTION] Slice 6 (Pluggable providers) violates constraints.**
   - *Issue:* The research document explicitly rejects Honcho and mem0 infrastructure (Postgres, Redis, daemons). Building a pluggable interface to support them behind the store interface violates the local-first, approval-gated mandate.
   - *Change:* Cut pluggable providers. Hardcode Hermes to consume the native Morz store directly. 

3. **[DESIGN GAP] Slice 3 (Per-CLI rendering) is incomplete in context-hub.**
   - *Issue:* The brief calls for a "~200-line index budget + topic files". But `src/main/services/context-hub.ts` (lines 346-369) currently dumps the entire concatenated body of all enabled memories into the `<!-- morz:memory -->` block, which will quickly blow the CLI context window.
   - *Change:* Update `context-hub.ts` to manage the lifecycle of auxiliary topic files and only render titles/summaries in the managed block.

4. **[DATA INTEGRITY] Slice 2 (Bi-temporal facts) vs Slice 5 (Obsidian backing).**
   - *Issue:* Zep's bi-temporal model mandates "contradictions soft-expire, never delete". But if we expose the markdown-per-fact folder to Obsidian, users *will* hard-delete files. 
   - *Change:* Define the synchronization contract clearly: human out-of-band deletions bypass bi-temporal strictness and trigger a hard `DELETE` in the SQLite audit log upon next scan.

5. **[UX LATENCY] Slice 1 (Op-set reconciliation) LLM placement.**
   - *Issue:* mem0 uses an LLM to generate the ADD/UPDATE/DELETE deduplication. If this blocks the event loop while an agent is waiting, the UI will feel sluggish.
   - *Change:* Ensure the LLM Op-Set generation is asynchronous and uses a fast/cheap model (e.g., Haiku/Flash), allowing the orchestrator to continue while the approval card is prepared.

## 4. Tradeoffs vs alternatives
- **Markdown vs SQLite as Source of Truth**: Keeping Markdown as the substrate maintains "hackability" and enables Obsidian natively, but makes bi-temporal querying slower (parsing YAML) and risks out-of-band corruption. Moving entirely to SQLite would perfectly enforce Zep-style bi-temporal rules but sacrifices user transparency. Materializing Markdown from SQLite is an alternative, but introduces complex two-way sync logic.
- **Asynchronous Reconciliation vs Inline**: Generating the Op-Set asynchronously keeps the UI fast but creates a disconnected UX where an approval card might pop up seconds after the agent has already moved on to the next task.

## 5. Blocking risks
- **CLI Context Overload**: If the `context-hub.ts` index budget isn't strictly enforced before 0.0.6 lands, a wave of new memories will cause Claude Code to crash or truncate system prompts.
- **Missing Telemetry**: Procedural learning (Slice 4) will fail silently if the current brittle PTY parsing cannot reliably identify tool successes/failures.
- **State Desync**: Out-of-band Obsidian edits while the Morz orchestrator is actively processing an Op-Set could lead to race conditions overwriting user changes.

## 6. Confidence
**High.** The roadmap (`REMAINING.md`) and research (`MEMORY-SYSTEMS-RESEARCH.md`) clearly expose structural contradictions in the 0.0.6 brief—specifically the dependency inversion of procedural learning before adapter unification, and the inclusion of rejected cloud infrastructure via pluggable providers.

## 7. What to validate before committing the wave
1. **Topic File Support**: Validate that target CLIs (especially Claude Code and Codex) actually follow file links / `@` includes injected into `CLAUDE.md`/`AGENTS.md` instead of ignoring them.
2. **Reconciliation Latency**: Measure the end-to-end time required to run FTS5 retrieval + the deduplication LLM prompt to ensure the Op-Set approval card generation is fast enough for interactive use.
3. **Adapter Telemetry**: Verify the exact state of the AgentAdapter in 0.0.5 to confirm whether *any* structured tool logging is possible, validating the decision to defer Slice 4.
