# Verdict: FINDINGS

1. **MEDIUM — Edited-plan UI offers CLIs the backend now rejects.**  
   [PlanCard.tsx](C:/Projects/run-20260728051623-26b58c-planner-models/src/renderer/src/components/PlanCard.tsx:57) always lists all four CLIs, and Add Agent defaults to Claude at [line 205](C:/Projects/run-20260728051623-26b58c-planner-models/src/renderer/src/components/PlanCard.tsx:205). Meanwhile, `PlannerApi.update` validates against the detected roster. On a Codex-only installation, Add Agent therefore creates an unavailable Claude agent and the update fails. Selecting any unavailable CLI has the same problem; it also saves the rejected choice as a role default before validation. Filter choices by eligibility, choose an eligible default, and persist defaults only after update succeeds.

2. **MEDIUM — A transient Windows PATH-resolution failure wrongly evicts a CLI.**  
   [connections.ts](C:/Projects/run-20260728051623-26b58c-planner-models/src/main/services/connections.ts:196) converts every `where.exe` failure—including timeout, spawn failure, or output overflow—into `[]`. That becomes `present:false` at [line 691](C:/Projects/run-20260728051623-26b58c-planner-models/src/main/services/connections.ts:691), immediately excluding the CLI from planning until a later successful probe. A CLI `--version` timeout does not have this problem because a resolved candidate keeps `present:true`. PATH resolution needs an `absent | found | probe-error` result; preserve prior presence on probe errors and set false only on an authoritative no-match.

3. **MEDIUM — The claimed 1.0 compatibility behavior is not preserved or surfaced.**  
   Validation correctly strips a model from 1.0 and emits a warning, but [plan-store.ts](C:/Projects/run-20260728051623-26b58c-planner-models/src/main/orchestrator/plan-store.ts:47) unconditionally relabels every stored plan as `1.1`. Direct reproduction produced:
   `{"input":"1.0","stored":"1.1","model":null}`.  
   Additionally, warnings are returned by Main at [planner.ts](C:/Projects/run-20260728051623-26b58c-planner-models/src/main/orchestrator/planner.ts:1323), but neither `PlanCard` nor `OrchestratorPanel` renders `record.warnings`; the assistant-bridge `planGoal` path discards them entirely. A 1.0 model is therefore silently removed, shown as “User default,” and its version rewritten. Preserve 1.0 in storage and visibly render warnings on every proposal path.

Cold-start itself is covered: when no cache exists, `listDetectedConnections()` starts or joins the initial probe, so “not probed yet” does not create an empty roster. A genuinely empty roster cannot produce a run-ready proposal, which is consistent with the new policy.

Verification: node/web typechecks passed; planner tests 21/21; plan-store tests 3/3 through Electron’s ABI; targeted E2E 11 passed, with one live-provider test skipped.