## Verdict: FINDINGS

1. **HIGH — Partial-only usage is invisible.**  
   [RunsPanel.tsx](/C:/Projects/morz-seam/src/renderer/src/components/RunsPanel.tsx:556) renders usage only when tokens or USD are non-null. If the first/final read times out, status is `{tokens:null, usd:null, partial:true}`, so neither `N+` nor “at least” appears. Include `partial` in the guard and render an explicit incomplete/`0+` floor.

2. **MEDIUM — Automatic exit may not publish the metering gap.**  
   [pane-bridge.ts](/C:/Projects/morz-seam/src/main/orchestrator/pane-bridge.ts:278) pushes after finalization only when an activity chip existed. For a title-silent pane, the liveness watcher can publish terminal state before the five-second deadline; when the timeout later sets `partial`, no further `run:changed` fires. Repro produced:
   `partial:true, pushes:0, gaps:1`. Push when `!finished` as well.

3. **MEDIUM — The partial marker is lost after restart.**  
   [pane-bridge.ts](/C:/Projects/morz-seam/src/main/orchestrator/pane-bridge.ts:150) stores gaps only in an in-memory `Set`, while run and usage totals persist. A restart probe changed the same run from `partial:true` to `false`, making historical undercount look exact. Persist the gap with run/cost state.

Confirmed:

- Timeout releases teardown; late resolution records zero usage and zero pushes, with timer/pane/scan cleanup present.
- Activity-only changes push once per chunk; hardened ConPTY e2e passed.
- Bare-ESC chaining extracts two- and three-deep sequences correctly.
- `partial` is run-ID scoped and does not contaminate later runs. Within a timed-out run it correctly remains true because the abandoned result is discarded.
- Verification: OSC 25/25, bridge 28/28, usage 9/9, typecheck, production build, and dispatch-seam e2e all passed.