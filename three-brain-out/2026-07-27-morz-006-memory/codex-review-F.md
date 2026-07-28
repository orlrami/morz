# FINDINGS

1. **HIGH — Detected-only enforcement is optional and bypassed by production planner paths.**  
   `src/main/orchestrator/planner.ts:458` defaults to the entire static catalog when `connections` is absent, while validation at `planner.ts:292` also skips roster checks. [assistant/bridge.ts](C:/Projects/morz/src/main/assistant/bridge.ts:359) calls `planGoal` without connections, and amendments at `planner.ts:1072` do likewise. Both can propose an undetected CLI/model without receiving the required correction.  
   **Fix:** Make the detected roster mandatory inside `generatePlan`/amendment generation, or fetch it centrally. Never interpret a missing roster as “all CLIs.”

2. **HIGH — Removed CLIs remain planner-eligible indefinitely.**  
   [connections.ts](C:/Projects/morz/src/main/services/connections.ts:686) preserves `installed: true` with `versionStale: true` when an executable disappears. New `listDetectedConnections` at `connections.ts:801` returns that cache, and planner filtering checks only `installed`. A previously detected but now absent CLI therefore remains in the catalog and passes validation.  
   **Fix:** Track current executable presence separately, or mark `installed:false` when no PATH candidate exists. Build planner availability from positively present executables, not last-known installation state.

3. **MEDIUM — SpawnPlan 1.0/1.1 compatibility is not faithfully represented.**  
   `src/shared/spawn-plan.ts:25` makes `model` required for every `PlannedAgent`, so a valid typed 1.0 plan without it no longer compiles. Conversely, `planner.ts:168` permits a 1.0 payload containing `model` and normalizes it into active 1.1 behavior; dispatcher validation at `dispatcher.ts:121` likewise accepts a 1.0 plan carrying a model.  
   **Fix:** Use a discriminated version union, or keep `model?: string|null` at the compatibility boundary. For version 1.0, reject or ignore any supplied model and normalize missing model explicitly to `null`.

4. **MEDIUM — The diff deletes unrelated research.**  
   [ORCA-COMPETITOR-RESEARCH.md](C:/Projects/morz/docs/research/ORCA-COMPETITOR-RESEARCH.md:1) is removed wholesale despite being outside Agent F’s scope.  
   **Fix:** Restore the file and exclude the deletion from this change.

The shell-injection path is otherwise defended: static models are allowlisted, OpenCode ids require the safe `provider/model` shape, and dispatcher validation repeats the check before constructing spawn text. I found no exploitable model-name prompt injection or silent UI rewrite.

Verification was static: the supplied diff was not present in `C:\Projects\morz-planmodel`, and targeted Playwright execution there was blocked by the missing `out/main/index.js` build artifact.