## Verdict: FINDINGS

1. **HIGH — A hung transcript read deadlocks Stop.**  
   [pane-bridge.ts:216](C:/Projects/morz-seam/src/main/orchestrator/pane-bridge.ts:216) awaits both the active scan and final scan without a timeout or cancellation. [dispatcher.ts:481](C:/Projects/morz-seam/src/main/orchestrator/dispatcher.ts:481) blocks teardown on this before marking the run aborted. A never-resolving reader reproduced `finalizeRun()` timing out indefinitely. Add an abortable deadline; release the pane and continue teardown when metering exceeds it.

2. **MEDIUM — Activity-only changes are never pushed to the UI.**  
   [pane-bridge.ts:285](C:/Projects/morz-seam/src/main/orchestrator/pane-bridge.ts:285) calls `push()` only when the lifecycle row changes. Normal `working → idle` leaves the lifecycle `running`, producing zero pushes. Likewise, a same-chunk `waiting → idle` emits internal events but no production subscriber consumes them, and the renderer receives neither state. The renderer only ingests `run:changed` notifications at [runsStore.ts:223](C:/Projects/morz-seam/src/renderer/src/store/runsStore.ts:223). Push once per chunk whenever observable activity changes, even if no ledger write occurs. If transient waiting must be retained, connect the semantic events to an event log.

3. **MEDIUM — A terminating ESC swallows an immediately following OSC.**  
   At [osc-title.ts:149](C:/Projects/morz-seam/src/shared/osc-title.ts:149), a non-ST ESC is counted as consumed, and [osc-title.ts:165](C:/Projects/morz-seam/src/shared/osc-title.ts:165) resumes after it. Repro:

   ```text
   ESC]2;first ESC]2;second BEL
   → ["first"]   // "second" is lost
   ```

   A bare ESC terminates the first OSC but must also be reconsidered as the next sequence’s introducer. Use zero consumption for non-`\` ESC and add this chained-OSC regression test.

The transcript truncation/rotation case is clean: fresh reproduction counted only new deltas across initial read, rotation with copied history, and subsequent truncation (`10 → 20 → 30`).

Both judgment calls are reasonable:

- Dispatcher-known CLI ownership is appropriate; real task titles often omit product names, and the documented false-positive scope is non-terminal.
- Keeping bounded observation on the already-relayed PTY handler is justified by the measured cost. The publication bug above is independent of whether parsing is deferred.

Fresh verification: 54/54 focused unit tests passed, targeted dispatch E2E passed, typecheck passed, and production build passed.