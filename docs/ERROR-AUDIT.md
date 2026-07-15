# Runtime Error Audit — Wave 7

**Audit date:** 2026-07-14 (America/New_York)
**Branch:** `w7/errors-research`
**Baseline:** `474e3b3`
**Launch:** `node_modules/electron/dist/electron.exe out/main/index.js`

## Method

The production build was launched with an isolated `MORZ_USER_DATA`. Main-process stdout/stderr, renderer console messages, renderer `pageerror` events, failed renderer requests, and renderer HTTP responses at or above 400 were collected during:

- 60 seconds idle after boot;
- Terminals, Commit, Waves, Review, Organizer, Settings, and Workshop view switches;
- a Workshop refresh;
- Manual → Assisted, opening a Claude lane without submitting a prompt, then Assisted → Manual;
- another 60 seconds idle after the interaction tour.

The Workshop source state after the foreground refresh was:

| Source | Observed state | HTTP / transport result | Notification Center |
|---|---|---|---|
| Official MCP Registry | `ok` initially, then delayed `error` | 200 responses; the 200-page local safety budget expired while a valid next cursor remained | Yes, error with Retry now |
| OpenRouter models | `ok` | 200 | No failure notice needed |
| OpenRouter benchmarks | `needs-key` | Request skipped because no key was configured | Yes, informational |
| GitHub stars | `ok` | Successful enrichment during this run | No failure notice needed |

The existing deterministic sync fixture was also run to exercise failure classifications:

| Forced path | Observed result | Notification Center |
|---|---|---|
| Registry connection refused | `offline`, retry timestamp | Yes, warning with Retry now |
| OpenRouter benchmarks HTTP 401 | `needs-key` | Yes, informational; models remain usable |
| GitHub HTTP 403 + rate-limit reset | `rate-limited`, cached stars retained | Yes, warning with Retry now |

## Findings

### Sync

| Severity | Symptom | Source | Root cause | Fix / disposition | Status |
|---|---|---|---|---|---|
| HIGH | A healthy first Registry sync fails after roughly 30 seconds with `Registry pagination exceeded safety limit`. | `src/main/services/catalog.ts` (`continueRegistrySync`) | The Registry cursor walks versioned records while Morz upserts canonical server IDs. After 200 successful pages, the isolated audit DB contained 6,768 distinct MCP items and a non-repeated persisted cursor (`io.github.agentkitai/lore:1.3.0`). Exhausting a bounded work slice was incorrectly treated as a remote failure. | Preserve the cursor, end the slice as healthy progress, and schedule the next bounded slice. Keep repeated-cursor and malformed-page conditions fatal. | Fixed |
| HIGH | A Registry cursor cycle spanning two bounded slices could run indefinitely. | `src/main/services/catalog.ts` (`syncRegistry`, `continueRegistrySync`) | The cursor set was local to one 200-page continuation, so an external cycle whose repeat landed just beyond that boundary evaded detection. | Keep one scan-wide cursor set and claim every resume cursor before its request. A deterministic boundary-cycle fixture now stops at 200 requests with a classified Registry notice. | Fixed |
| MEDIUM | A scheduled continuation and foreground refresh could start from the same cursor concurrently. | `src/main/services/catalog.ts` (`syncRegistry`) | The old guard was assigned only after the first page returned, leaving the first request outside the protected background promise. | Set an active guard before reading source state or issuing the first request; hold it through the background slice and use it for `syncing` state. | Fixed |
| MEDIUM | Handled Registry/offline/GitHub failures still write raw `console.error`/`console.warn`; invalid benchmark credentials write `console.info`. | `src/main/services/catalog.ts` (`reportSourceFailure`, `optionalBenchmarks`, `fetchGithubStars`) | Wave 6 added Notification Center routing but retained duplicate diagnostic logging. The real tour produced one stderr line even though the same failure was already persisted as a notice. | Remove duplicate source logging. Durable notices and source status remain the user-facing error surface. | Fixed |
| INFO | A post-fix GitHub enrichment attempt ended with transport-level `fetch failed` and no HTTP response. | `src/main/services/catalog.ts` (`enrichGithubStars`) | The remote request failed before an HTTP status was available. | Existing offline classification set a five-minute retry, retained cached data, emitted one stable warning notice, and produced no raw console output. | Gracefully handled |

### Unhandled rejection / main process

| Severity | Symptom | Source | Root cause | Fix / disposition | Status |
|---|---|---|---|---|---|
| HIGH | Detached main-process promise rejections and uncaught exceptions have no app-level error route. | `src/main/index.ts` | No `process` handlers are registered, so Node/Electron owns the failure mode and the Notification Center receives nothing. | Register early global handlers and upsert stable `app:*` error notices. Rejections remain recoverable; uncaught exceptions persist the notice synchronously and exit nonzero so the app does not continue in an undefined state. | Fixed |
| HIGH | Arbitrary exception messages could persist credentials, URL secrets, filesystem paths, or multiline payloads in `morz.db`. | `src/main/index.ts`, `src/renderer/src/components/ErrorBoundary.tsx` | Truncation and control-character removal alone do not enforce the notification trust boundary. | Collapse to one line; redact Bearer and authorization-scheme values, quoted or unquoted credential assignments, URL credentials/query/fragment data, and Windows paths before persistence. | Fixed |

### React

| Severity | Symptom | Source | Root cause | Fix / disposition | Status |
|---|---|---|---|---|---|
| MEDIUM | A render/lifecycle exception can replace the renderer with an uncaught blank screen. | `src/renderer/src/main.tsx` | The root renders `App` directly; no React error boundary exists. | Add a root error boundary that emits a stable notification and renders an accessible reload fallback. | Fixed |
| INFO | No missing-key, hook dependency, `act()`, hydration, or StrictMode warning appeared during the production view tour. | Renderer DevTools console | No reproducible warning in the audited flow. | No speculative component changes. | Verified baseline |

### CSP / assets / design

| Severity | Symptom | Source | Root cause | Fix / disposition | Status |
|---|---|---|---|---|---|
| INFO | No CSP violation, failed font/icon/image request, or failed renderer request appeared during boot or the tour. | `src/renderer/index.html`, production renderer | The current production CSP covers bundled scripts/fonts/images, inline component styles, blob workers, and local development connections used by the app. | Leave CSP unchanged; broadening it without a violation would reduce security. | Verified baseline |
| CROSS-AGENT | `docs/BRAND.md` names Hanken Grotesk for UI/brand, while `src/renderer/src/main.tsx` currently imports Geist and Noto Sans. | Font/design ownership | Wave-7 brand/font integration is owned by Agents 1–3. No load failure occurred, so this is a design-system mismatch rather than a runtime exception. | Integration owner should reconcile the font contract. This branch does not edit font imports, `tokens.ts`, or `globals.css`. | Documented only |
| CROSS-AGENT | `src/main/index.ts` still creates a generated bronze-square tray placeholder even though branded icon assets now exist. | Icon/design ownership | Brand asset wiring is owned by Agents 1–3. | Integration owner should wire the reviewed tray asset. This branch does not modify icon assets or token/style files. | Documented only |

### IPC

| Severity | Symptom | Source | Root cause | Fix / disposition | Status |
|---|---|---|---|---|---|
| INFO | No uncaught IPC error or rejected invoke appeared during the audited view/lane flow. Invalid renderer notification actions are already stripped and main actions are allowlisted. | `src/main/services/notify-center.ts`, preload bridge | Existing wave-6 validation held under the audited flow and its deterministic tests. | Retain the trust boundary; global handlers are a last-resort surface, not a substitute for per-handler validation. | Verified baseline |

## Raw baseline evidence

- Renderer console warnings/errors: **0**
- Renderer `pageerror` events: **0**
- Renderer failed requests / HTTP 4xx–5xx: **0**
- Main stderr: **1** — `[morz] MCP registry sync failed: Registry pagination exceeded safety limit`
- Registry DB after the failed slice: **6,768** canonical MCP rows, `last_sync_at = null`, valid `page_cursor` retained, newest record `2026-07-15T02:03:53.146Z`
- Lane count: **1** after opening in Assisted, **0** after returning to Manual
- Deterministic wave-6 notification suite: **6/6 passed** before wave-7 changes

## Security review

- External catalog JSON remains untrusted and is shape/type/length validated before SQLite writes.
- Registry/GitHub URLs remain protocol/host constrained; test-only endpoint overrides remain gated by `MORZ_E2E=1`.
- Renderer-supplied notification actions remain untrusted and are stripped by Main.
- Global error notices contain one short redacted line, never a stack trace or raw structured payload; E2E verifies planted Bearer, Basic authorization, quoted password, URL credential/query, and Windows-path values never persist.
- The CSP is not broadened because no legitimate resource was blocked.

## Post-fix verification

- Fresh production profile, same two-minute idle/tour/idle procedure: **0** main stdout/stderr errors or warnings, **0** renderer warnings/errors, **0** `pageerror` events, **0** failed renderer requests/CSP violations.
- Live Registry: **16,542** canonical MCP entries, `status = ok`, cursor cleared, `last_sync_at` populated.
- Live OpenRouter models: `status = ok`; optional benchmarks: `needs-key` informational notice.
- Live GitHub transport failure: no HTTP response, `status = offline`, stable warning notice with retry time, no console duplication.
- Deterministic 206-page Registry fixture completed across bounded slices without an error notice.
- Forced detached main-process rejection produced durable `app:unhandled-rejection` notification and no stderr.
- Focused error-hardening spec: **5/5 passed**, including secret redaction, fail-closed exception persistence, and a cross-slice cursor cycle.
- Existing notification/catalog reliability spec: **6/6 passed**.
- Full Electron E2E suite: **60 passed, 6 intentionally skipped live-provider tests, 0 failed**.
