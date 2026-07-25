# Morz — everything left (0.0.5 → the end)

*One map of what's missing and what we work on, in order. Detail lives in the linked docs; this is the spine. Updated 2026-07-24.*

**Shipped so far:** 0.0.1 Terminal · 0.0.2 Bus · 0.0.3 Orchestrated · 0.0.4 Learns You — installed + dogfooded as a signed exe. Waves 10–14 (dogfood) + w15 pre-work merged: opt-in route chips (no silent plan rewrite), fast planner default (Sonnet + GPT-5.5 race, Claude model picker).

---

## 0.0.5 — "Your Morz" ✅ BUILT (wave 15, 12 agents — merged + integrated; E2E 189 passed)
*All nine slices below landed. Integration notes + the bugs found while merging: [`../in-progress/STATUS.md`](../in-progress/STATUS.md).*
Scope: [`../in-progress/WAVE15.md`](../in-progress/WAVE15.md) · spec: [`0.0.5.md`](0.0.5.md) · mockups: claude-design project (Shell v3, Start Screen, First Run, Settings).

| # | Slice | What |
|---|---|---|
| 1 | modules-core | Module registry + REAL gating (off = no tab, no process, no sync) + autonomy interlock + drawer + Ctrl-K |
| 2 | shell-premium | Approved redesign: icon rail left, Explorer right, IDE slide-over (ctrl-click overlay), dial-owned orchestrator (Manual = none), 3-group statusbar, pill bar dies |
| 3 | onboarding | First-run configure screen w/ live preview (CLIs + models, modules, slots, autonomy) |
| 4 | integration-slots | BYO tools: git = plain / Morz Commit / lazygit / gitui · review = off / Morz Reviewer / CodeRabbit / Greptile / Copilot · editor = slide-over / VS Code / Cursor |
| 5 | review-fixes | Wave-14 findings (busStore race, clear idempotency, prompt escaping, type guards) |
| 6 | model-choice | ModelChoice per CLI (inherit / session flag / diff-first config write) wired into lanes, dispatch, planner, pulse + Connections & Models settings ([research](../research/MODEL-CONFIG-RESEARCH.md)) |
| 7 | start-screen | Launcher = home; pre-flight row + spawn transparency; **On-launch pref: straight-to-shell (default, sessions restore) vs start screen**; explorer right |
| 8 | settings-ia | Workspace / Agents / App nav; migrate all panels |
| 9 | context-hub | CLAUDE.md / AGENTS.md / STATUS.md manager: spaces × files matrix, templates, shared-block propagation, optional auto-STATUS, memory-export block |

Exit: full e2e green → rebuild exe → dogfood.

## 0.0.5.1 — "Polish & Fix" (NEXT — owner dogfood round 1 on 0.0.5)
Scope: [`../in-progress/WAVE16.md`](../in-progress/WAVE16.md). Drawer portal, context-hub authority fix, draggable setup, dark dropdowns, version freshness + CLI update button, Spotlight palette, motion pass, voice module removed (Wispr Flow covers it), planner = any detected CLI (+OpenCode), memory bootstrap from existing .md files, version bump to 0.0.5.

## 0.0.6 — "Memory that Works" (memory v2 + assistant/vault deepening)
Design locked by [`../research/MEMORY-SYSTEMS-RESEARCH.md`](../research/MEMORY-SYSTEMS-RESEARCH.md) (Honcho/mem0/Letta/Zep/Claude-Code study). Build order:
1. **Op-set reconciliation** (mem0): candidate memory → ADD/UPDATE/DELETE/NOOP against similar existing facts; the op IS the approval card; hash pre-dedup; SQLite audit log.
2. **Bi-temporal facts** (Zep): `valid_at/invalid_at/created_at/expired_at/source_run_id`; contradictions soft-expire, never delete; inject validity windows ("used X until commit Y").
3. **Per-CLI rendering + shared space blocks** (Letta): canonical store rendered at launch into CLAUDE.md / AGENTS.md (Codex+agy) / GEMINI.md as managed `<!-- morz:memory -->` blocks — merges with 0.0.5 context-hub; `space` scope = ONE shared block for a whole dispatched team; `read_only` locked blocks; ~200-line index budget + topic files.
4. **Procedural learning** (the differentiator, ships last): log every CLI/tool/skill invocation + outcome; frequency × recency-decay × success-rate scoring; threshold → PROPOSE a {Title, Description, Content} card ("prefers Codex for refactors", repeated-correction coding standards). Never auto-persist; never promote failing patterns.
5. **Obsidian deepening:** vault as optional durable backing for the store (one note per fact, morz-tagged); ADR browser; context/STATUS mirroring. Optional, no-clobber.
6. **Hermes assistant deepening:** context-hub injection into Hermes proposals; pluggable memory providers (Honcho/mem0) behind the store interface; assistant integration slot (Morz planner / Hermes / OpenClaw / Comet).

Rejected for good: graph DBs, Postgres/Redis, background daemons, LLM on the launch path, unapproved writes.

## 0.0.7 — "The Self-Closing Orchestrator" (close the ORCH-AUDIT gaps)
Everything from [`../ORCH-AUDIT.md`](../ORCH-AUDIT.md) priority list, still open:
1. **Auto-done:** commit/review/DoD events advance agent → run state (`running → merging → done`); no more mandatory Stop.
2. **Dispatcher ⇄ adapters unification:** dispatched panes run through the AgentAdapter seam (or a narrow terminal-event bridge) → normalized permission/block/result events, metering, interrupts. Fixes "waiting-for-approval looks like working".
3. **Handoff wake for dispatched panes:** approved bus payloads reach non-Claude TUIs (pointer injection per adapter), task leaves `accepted`.
4. **Adapter metering for dispatched agents:** usage stops being `{usd:null,tokens:null}`; cost kill-switch covers runs.
5. **Merge step:** reviewed run branch → squash/merge back to the space's base branch as an explicit approved action (today branches are only reviewed then deleted).
6. **agy adapter live fix:** `timeout: agy reply token` smoke failure.
7. **kickoff.md leak fix:** kickoff material out of the worktree or `.git/info/exclude` (HIGH security finding — bit us live on 2026-07-22).
8. **Native-gate visibility:** Codex trust/command prompts surfaced as run states, never auto-approved.
9. **Full Tetris orchestration live proof** (parked since w13) — the end-to-end demo run in-app.

## 0.0.8 — "Parallel Mastery" (competitor-research adoptions)
From [`../research/COMPETITOR-UI-RESEARCH.md`](../research/COMPETITOR-UI-RESEARCH.md):
- **Run rail with attention badges** — left column of parallel runs (status, branch, ±diff, needs-input badge, unread dot), nested per space. The "supervise 5 agents" surface.
- **Task Attempts** — run one task on 2–3 agents in parallel worktrees, diff results side-by-side, keep the winner. Natural fit for the dispatcher; genuine differentiator.
- **Summary/scan transcript mode** for many agents; **inline-on-diff reply to agent**; **squash-rebase one-click finalize**; **drag-to-split session compare**.
- Plus 0.0.3 leftovers that fit here: cost-cap UX revisit, DAG polish.

## 0.0.9 — "Hardening & Polish"
- Whatever review-fix backlog survived + new dogfood QA rounds (owner-driven waves continue).
- Torture/perf passes: many-space, many-run, long-scrollback; PTY fidelity regression suite (existential — block-UI competitors prove CLIs render badly elsewhere).
- Accessibility + keyboard completeness (palette parity for every module), reduced-motion, error-state audit refresh ([`../ERROR-AUDIT.md`](../ERROR-AUDIT.md) was wave-7; redo).
- Voice exact approach revisit (0.0.4 note).

## 0.1.0 — "Out the Door" (distribution)
From [`README.md`](README.md) distribution section:
- **Code signing cert** (Azure Trusted Signing) BEFORE wider distribution — unsigned→signed breaks the updater chain.
- Auto-update flow live (electron-updater feed, currently silent-off/private).
- **macOS port** (dmg + notarization; platform modules already isolated).
- Decisions to make together: open-source release? SaaS tier? Both parked, both need a call here.

## Beyond — parked, real future
- **Morz Remote** (phone mission-control: approve plans/permissions from anywhere; `morzd` outbound relay, E2E).
- Deep LSP in the IDE; marketplace installer for community modules (Workshop tie-in); per-space module overrides.

---

## Standing rules (every wave)
Manual mode provably inert (CI gate) · approval-gated everything, diff-first writes, reversible · PTY fidelity sacred · login-free, local-first · Playwright torture tests land WITH slices · rebuild + reinstall the signed exe each wave so dogfood = packaged product.
