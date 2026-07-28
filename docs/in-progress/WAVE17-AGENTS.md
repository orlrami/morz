# Wave 17 (0.0.6 revised + 0.0.7 pre-work) — agent launch pack (6 agents)

Scope: [`WAVE17.md`](WAVE17.md) · consensus record: `three-brain-out/2026-07-27-morz-006-memory/SYNTHESIS.md` · vision: [`../roadmap/REMAINING.md`](../roadmap/REMAINING.md)

## Setup (run once per agent, from C:\Projects)

```powershell
git -C C:\Projects\morz worktree add C:\Projects\morz-<dir> -b <branch> main
cmd /c mklink /J C:\Projects\morz-<dir>\node_modules C:\Projects\morz\node_modules
```

| Agent | Model | Branch | Dir |
|---|---|---|---|
| A renderer-core | Fable 5 | `w17/renderer-core` | `morz-render` |
| B context-blocks | Fable 5 | `w17/context-blocks` | `morz-blocks` |
| C supersession | GPT-5.6 Sol | `w17/supersession` | `morz-super` |
| D event-log | GPT-5.6 Sol | `w17/event-log` | `morz-evlog` |
| E adapter-seam | Fable 5 | `w17/adapter-seam` | `morz-seam` |
| F planner-models | GPT-5.6 Sol | `w17/planner-models` | `morz-planmodel` |

Launch order: A, D, E, F immediately. B and C after A pushes its renderer contract (or start them on interface stubs A publishes in its first commit — A must commit `src/main/memory/render.ts` types first).

## Common rules — PREPEND TO EVERY PROMPT

> You are one agent of wave 17 on Morz (Electron 32 + React 18 + TS + Tailwind 4, Windows-first AI terminal orchestrating the user's own AI CLIs). Work ONLY in your worktree/branch. Read `docs/in-progress/WAVE17.md` FIRST — it lists decisions already made; do not relitigate them.
> Rules: assist don't take over — every risky action approval-gated, diff-first, reversible; Manual mode provably inert. Colors/fonts ONLY from `src/renderer/src/lib/tokens.ts`, motion from `springs.ts`. e2e tests (Playwright, `e2e/`, helpers `e2e/app.ts`) land WITH the change; unit tests via `npx tsx --test`. Commits `<type>(<area>): ...`, small. UTF-8 stays UTF-8 — never let a tool re-encode non-ASCII into mojibake (no PowerShell -replace on files with em-dashes).
> Verify before finishing: `npm run typecheck` && `npm run build` && your specs. Report honestly what ran and what didn't. Do not merge; leave the branch for the integrator.

---

## Agent A — renderer-core · **Fable 5** · `w17/renderer-core` · `C:\Projects\morz-render`

> Unify Morz's two divergent memory renderers into one canonical module. Today: `renderInjectionLines` (`src/main/memory/opset.ts:347` — titles only, 2000-char budget, injects SUPERSEDED facts) vs `renderMemories` (`src/main/services/context-hub.ts:346` — full bodies, NO budget, THROWS when nothing enabled). They will drift; fix now.
>
> 1. **FIRST COMMIT (unblocks agents B and C): `src/main/memory/render.ts`** exporting the contract: `renderMemoryPreamble(entries, opts): string` (launch injection) and `renderMemoryBlock(entries, opts): string` (context-file managed block), plus shared types. Both from the same input selection logic. Push this commit immediately.
> 2. Selection rules (both outputs): enabled + non-expired facts only — **superseded/expired facts NEVER render** (they stay queryable in the Memory settings UI). Scope filtering stays as today (global/project/space/agent).
> 3. Budget: enforced in the renderer, not at call sites. Preamble keeps the existing ~2000-char behavior. Block output gets a line budget (default 200 lines) — when over, render titles + one-line summaries instead of bodies, and a final line `<!-- morz:memory truncated: N of M facts, open Morz > Memory -->`. Never silently drop.
> 4. Empty/all-disabled store: preamble returns `''`, block returns an empty managed block (markers present, no content). NEVER throw — `renderMemories`'s throw at context-hub.ts:355 dies with it.
> 5. Rewire both call sites (opset injection path via `learn-port.ts`, context-hub `proposeMemoryBlock`) to the new module; delete the old renderers; no orphans.
> 6. Marker-safety stays: memory text containing `<!-- morz:memory -->` / block markers must be escaped (existing `safeMemoryText` behavior — keep its tests green, `src/main/services/context-hub.test.ts:390`).
>
> Deliverables: `render.ts` + rewired call sites + dead code removed. Unit tests (`src/main/memory/render.test.ts`): same input → both outputs consistent; superseded fact excluded from both; empty store → empty outputs, no throw; over-budget → summary mode + truncation line; marker escape. Run `e2e/memory-opset.spec.ts`, `e2e/context-hub.spec.ts`, `e2e/memory.spec.ts`. Coordinate note: agent C changes fact fields (supersession links) — you consume `supersededBy != null` as "don't render" if present, but do NOT depend on C's branch; treat the field as optional.

## Agent B — context-blocks · **Fable 5** · `w17/context-blocks` · `C:\Projects\morz-blocks`

> Extend approval-gated memory rendering to all CLI context files + team-shared blocks, and close two real bugs. Depends on agent A's `src/main/memory/render.ts` contract (cherry-pick A's first commit into your branch if not yet on main; note it in your report so the integrator drops the duplicate).
>
> 1. **`proposeMemoryBlock` for all kinds.** Today it only writes CLAUDE.md (`src/main/services/context-hub.ts:521`). Extend to `agents` (AGENTS.md) and `gemini` (GEMINI.md) kinds through the same diff-first proposal flow. Same managed markers. One proposal per file, batched into one review surface like bootstrap does.
> 2. **`read_only` enforced, not decorative.** A `read_only` memory block/fact rejects `proposeMemoryBlock` re-render AND `saveMemory` mutation at the service layer (not just hidden in UI). Clear error string.
> 3. **`space` scope = one shared team block.** A space-scoped fact approved once renders into the SAME block content for every agent dispatched into that space — one canonical render, not per-agent copies that drift.
> 4. **Fix the `spaceId` drop.** `src/main/orchestrator/dispatcher.ts:325` passes `projectRoot` + `agentId` but omits `spaceId`, so space-scoped memory never reaches dispatched teams. Thread it through; standalone lanes resolve their space from the ACTIVE space, not worktree cwd guessing — check how `learn-port.ts:129` consumers resolve scope and unify.
> 5. **Clean-tree e2e gate (regression for the kickoff-leak class).** New e2e: launch a lane into a git worktree, assert `git status --porcelain` is EMPTY after launch (no memory/context file materialized without approval). This is the wave's most important test — it must fail if anyone ever adds launch-time file writes.
>
> Deliverables: multi-kind proposals + read_only enforcement + space team block + spaceId fix + clean-tree gate. Unit: proposal round-trip per kind (markers idempotent, other `<!-- morz:block:* -->` survive); read_only rejection both paths. E2E: extend `e2e/context-hub.spec.ts` (propose→apply AGENTS.md block), new `e2e/memory-team.spec.ts` (space fact reaches two dispatched agents' preambles — stub adapter — and no other space), new clean-tree spec. Run `context-hub`, `memory-opset`, `orchestrator` suites.

## Agent C — supersession · **GPT-5.6 Sol** · `w17/supersession` · `C:\Projects\morz-super`

> Make bi-temporal memory chains real: linkable, race-safe, atomic. All in `src/main/memory/` (`index.ts`, `opset.ts`, `store.ts`, `src/shared/memory.ts`). Coordinate: agent A owns rendering (`render.ts`) — you own data + apply semantics; add fields as OPTIONAL so A's code compiles without you.
>
> 1. **Supersession links.** On approved UPDATE: expired fact gets `supersededBy: <successorId>`, successor gets `supersedesId: <oldId>`. Kill the synthetic-id mangle at `index.ts:291` — the LIVE fact keeps the clean id; the expired revision gets the derived id. Migration for existing stores (written by d374a68): loads, renders, searches with no warnings; missing link fields tolerated forever.
> 2. **Stale-approval CAS.** A proposal captures the target's revision (content hash). Apply revalidates: target changed since proposal → reject with a clear "memory changed since this was proposed — re-propose" error, surfaced on the card. Test: stage A and B against one target, approve A, approve B → B blocked. (`index.ts:266`.)
> 3. **Atomic apply.** Order the write steps (markdown write → index → audit → applied flag) so a crash at ANY boundary recovers to exactly-once: re-apply after crash is a NOOP (idempotency key in the audit table), never a duplicate successor. Document the ordering in a comment.
> 4. **Restore guard.** Restoring an expired fact whose successor is live either fails with a clear error or expires the successor — never two active facts in one chain. Pick fail-with-error (safer, reversible).
> 5. **All writes through reconciliation.** Manual rule creation (`src/renderer/src/store/memoryStore.ts:113`) and the raw IPC save/remove (`src/main/memory/index.ts:587`) currently bypass dedup/contradiction checks. Route manual saves through the op-set pipeline (a manual save IS pre-approved — skip the card, keep the dedup + audit). Remove or guard raw paths.
> 6. **IPC trust boundary.** Memory IPC handlers get the same sender-frame validation `registerContextHubIpc` does. Copy the pattern, don't invent.
>
> Deliverables: links + migration + CAS + atomic apply + restore guard + unified write path + IPC validation. Unit tests (`src/main/memory/`): UPDATE links both directions; migration from link-less store; CAS blocks second approval; crash matrix (kill between each apply step via injectable failpoints → restart → exactly one result, one logical audit row); restore-with-live-successor fails. E2E: `e2e/memory-opset.spec.ts` extended: approve update → UI shows chain ("replaced <old> on <date>"); concurrent proposals → second shows the re-propose error. Run `memory`, `memory-opset`, `memory-bootstrap` suites.

## Agent D — event-log · **GPT-5.6 Sol** · `w17/event-log` · `C:\Projects\morz-evlog`

> Procedural-learning SUBSTRATE only. A typed, redacted, size-capped log of tool/CLI invocations and outcomes. **This wave emits ZERO memory proposals from the log — that is a hard product decision** (scoring ships in 0.0.7 with real adapter telemetry). New module `src/main/memory/event-log.ts`.
>
> 1. **Schema (typed, versioned):** `{v:1, ts, sessionKind: 'lane'|'dispatched'|'planner', cli, agentId?, spaceId?, event: 'spawn'|'exit'|'tool'|'block'|'interrupt', name?, outcome?: 'ok'|'error'|'blocked'|'unknown', durationMs?, meta?}`. `meta` is a SMALL allowlisted bag — never raw args, never env, never file contents.
> 2. **Sources today (be honest about coverage):** Claude adapter lanes emit structured events (`src/main/adapters/claude.ts` — stream-json includes tool_use; parse `name` + result status). Dispatched panes + other CLIs: log only spawn/exit/duration until agent E's seam lands — record `outcome:'unknown'` rather than guessing. NEVER parse raw PTY text for outcomes (brittle, and the consensus review vetoed it).
> 3. **Redaction:** before write, a redaction pass drops anything matching secret shapes (API keys `sk-…`/`AKIA…`, JWTs, PEM blocks, `.env`-style `KEY=value` with high-entropy values, absolute paths under the user profile get `~` substitution). Build the corpus test FIRST: a fixture list of key/JWT/PEM/env/prompt-injection payloads that must never appear in the written file.
> 4. **Mechanics:** JSONL under the app data dir; crash-safe (truncated final line skipped on load — same contract as `learner.ts:174`); rotation at 5MB keeping last 2 files; single oversized record dropped, not the file. Manual autonomy mode writes NOTHING (module gating, provably inert). Off under `MORZ_E2E=1` unless a spec opts in.
> 5. **Guardrail test (non-negotiable):** after N logged events of every type, `listMemoryProposals()` is byte-identical to before — the log provably produces no cards.
> 6. Tiny read API for later: `readEvents({since, cli})` — no UI this wave beyond a Settings → Memory line showing "N events logged · X MB" with a Clear button (approval = the click).
>
> Deliverables: event-log module + claude-adapter wiring + spawn/exit wiring for dispatched runs + redaction + rotation + counters line. Unit: schema round-trip, redaction corpus, crash-safe tail, rotation, oversized-record drop, zero-proposals guardrail. E2E: `e2e/memory-eventlog.spec.ts` — lane run logs spawn/tool/exit (stubbed adapter); manual mode logs nothing; Clear empties. Run `memory` suites + `orchestrator.spec.ts`.

## Agent E — adapter-seam · **Fable 5** · `w17/adapter-seam` · `C:\Projects\morz-seam`

> 0.0.7 pre-work, item 2 of `docs/ORCH-AUDIT.md`: dispatched panes bypass the AgentAdapter seam, so Morz cannot tell "waiting for approval" from "working", and metering is `{usd:null,tokens:null}`. Build the narrow bridge.
>
> 1. Read `docs/ORCH-AUDIT.md` first, then the current shapes: `src/main/adapters/` (AgentAdapter interface, claude.ts as the reference implementation), `src/main/orchestrator/dispatcher.ts` (how dispatched panes spawn today).
> 2. **Design decision is yours to propose in a `docs/in-progress/SEAM-DESIGN.md` FIRST COMMIT** (half a page: chosen seam shape, event contract, what stays PTY-only) — the integrator reads it at merge time. Constraints: dispatched panes stay REAL terminals (PTY fidelity sacred — no output interception that breaks rendering); the bridge observes, it does not proxy stdin/stdout.
> 3. Minimum contract to land: dispatched Claude runs go through the claude adapter's structured-event path (it already exists for lanes) so they emit normalized `spawn/tool/waiting/result/exit` events + token/cost metering; codex/agy/opencode runs emit at least `spawn/exit/duration` + a `waiting-for-input` heuristic ONLY if the CLI provides a structured signal (do not regex-guess TUI text; if none exists, emit nothing and say so in SEAM-DESIGN.md).
> 4. Events flow to the run store so the Runs UI can show real states (`accepted → running → waiting → done`) — wire the states that exist today; auto-done state ADVANCEMENT is 0.0.7 (do not build the full state machine, just make the events available and visible).
> 5. Metering: where the adapter yields usage, dispatched runs stop reporting `{usd:null,tokens:null}` — surface real numbers in the run card.
>
> Deliverables: SEAM-DESIGN.md + bridge + claude-dispatched normalized events + metering + run-card states. Unit tests for the event mapper. E2E: `e2e/dispatch-seam.spec.ts` — dispatched stub-claude run shows tool events + usage in the run card; dispatched stub-codex shows spawn/exit only (honest coverage). Run `orchestrator`, `runs`, `torture` (PTY fidelity must stay green — that's the regression risk of this slice).

## Agent F — planner-models · **GPT-5.6 Sol** · `w17/planner-models` · `C:\Projects\morz-planmodel`

> Make the planner model-aware: today the plan schema has no per-agent model and the prompt doesn't know which CLIs/models exist (`src/main/orchestrator/planner.ts:421` prompt lists `claude|codex|agy` only — opencode missing too).
>
> 1. **SpawnPlan 1.1:** add optional per-agent `model: string|null` to the schema (`src/shared/` spawn-plan types + validation). Version bump handled compatibly: 1.0 plans (no model field) stay valid — normalize to null. Update `extractSpawnPlanBlock` validation + the planner correction messages.
> 2. **Model catalog in the prompt.** Build the catalog from the CONNECTIONS roster (detected CLIs, `src/main/services/connections.ts`) + a static per-CLI model list in `src/shared/models.ts` (claude: sonnet/opus/fable; codex: gpt-5.5/gpt-5.6-sol; agy: gemini-3.1-pro; opencode: passthrough provider/model). Planner prompt gains: available CLIs = detected ones ONLY (an undetected CLI never appears), each with its models + one-line strength note. Add `opencode` to the cli enum line. Instruct: pick a model per agent, or null = user default.
> 3. **Dispatch honors plan models.** The proposal card's per-agent model chip (exists since w15 model-choice) initializes from the plan's `model` when present — user chips still override (opt-in chips law: no silent rewrites). Dispatcher passes the final model through the existing ModelChoice session-flag path.
> 4. **Planner engine dropdown honesty check:** roster-driven dropdown shipped in w16 — verify plan-proposed models for undetected CLIs get rejected at validation with a correction message (planner told codex isn't installed → replans).
> 5. E2E planner stub (`e2ePlannerResponse`) gains model fields so specs are deterministic.
>
> Deliverables: schema 1.1 + catalog-aware prompt + chip initialization + validation. Unit: `src/main/orchestrator/planner.test.ts` — 1.0 plan normalizes, 1.1 model round-trips, undetected-CLI model rejected with correction. E2E: extend `e2e/orch-engine.spec.ts` + `e2e/model-choice.spec.ts` — plan with models → chips pre-filled → dispatch args carry `--model`; plan without → chips at default. Run `orch-engine`, `model-choice`, `orchestrator`.

---

## Integration order (lead)
A's first commit (render.ts contract) unblocks B and C. Merge order: A → B → C (both consume A; C's optional fields keep A green), then D, E, F in any order. Reconcile points: `src/shared/memory.ts` (A types + C links), dispatcher (B spaceId + E seam + F model passthrough — three small touches, coordinate at merge), `learn-port` call path (A + B). Then full suite → perf smoke (500 facts) → `npm run build:win` → owner dogfood.
