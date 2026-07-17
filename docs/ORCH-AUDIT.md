# Orchestrator End-to-End Audit

**Audit date:** 2026-07-16
**Branch:** `w12/orch-audit`
**Live gate:** `MORZ_LIVE_ORCH=1`
**Goal:** one Codex agent creates `hello.py` plus a `unittest`, verifies them, and commits only those files.

## Executive result

The bounded live flow completed through planning, approval, dispatch, real agent file generation, verification, Morz staging/commit, cross-model review, Stop, and cleanup.

Final live evidence:

```text
planner=claude
agent=hello-builder (codex), port=43600
commit=539e637 (ephemeral fixture commit)
reviewer=claude, findings=0
handoff task state=accepted
run before Stop=running
run after Stop=aborted
Playwright: 1 passed (1.7m)
```

This is not yet a self-closing orchestrator. A successful agent commit and review do not advance the agent/run to `done`; dispatched panes are not wired to the `AgentAdapter` event stream; and an approved handoff cannot wake a raw dispatched pane. The final test therefore calls Stop, producing the honest terminal state `aborted`.

## Environment and commands

| Item | Observed |
|---|---|
| Claude Code | `2.1.187` |
| Codex CLI | `0.144.5` |
| Agy | `1.1.3` |
| Python | `3.10.11` |
| Node | `26.4.0` |
| Git | `2.55.0.windows.1` |

Commands used:

```powershell
npm.cmd run typecheck
npm.cmd run build
npx.cmd playwright test e2e/orch-e2e.spec.ts --reporter=list
$env:MORZ_LIVE_ORCH='1'
npx.cmd playwright test e2e/orch-e2e.spec.ts --reporter=list
node scripts/adapters-smoke.mjs
```

No `electron-rebuild`, `npm rebuild`, or native-module rebuild was run.

## Works / breaks matrix

| Surface | Live action and evidence | Verdict | Break or follow-up |
|---|---|---|---|
| Claude planner | The UI sent the tiny goal through `planner:plan`. Claude returned a schema-valid plan with one Codex agent, null worktree/port fields, the exact temporary `spaceRoot`, and a canonical hash. | **WORKS** | Planner retries/validation were not forced in the successful run. |
| Codex planner engine | Inspected and attempted to locate an engine selection path. `PlannerBridge.plan(goal, spaceRoot)` has no engine parameter; `PlannerDependencies` exposes only `runClaude`; `planGoal` falls back to `runClaudePlanner`; amendments also call `runClaudePlanner` directly. | **BROKEN / ABSENT** | There is no runtime error because there is no callable Codex-planner path. Add an explicit planner-engine contract and a Codex NDJSON parser before claiming dual-engine planning. |
| Proposed-plan approval | `Approve & Run` changed the card from `PROPOSED` to `APPROVED`; the planner store and dispatcher store agreed on the hash; dispatch returned a real UUID run. | **WORKS** | The live plan did not need an edit/reroute. The current branch still rejects CLI reroutes with `Plan edit changed immutable fields for <agent>`; Agent 1 owns that parallel fix. |
| Dispatch hash gate | The approved stored plan was re-hashed before spawning. The live run launched only after approval. Existing `dispatch.spec.ts` also covers tamper refusal. | **WORKS** | No bypass observed. |
| Git worktree | A run-tagged worktree was created beside the temporary Space on the planner-selected branch. The test asserted branch and path before allowing the agent to proceed. | **WORKS** | See the untracked `.morz/` security note below. |
| Port allocation | The agent received port `43600`; status exposed the same positive port. | **WORKS** | Usage of the assigned port is agent-defined; dispatch only allocates and exports it. |
| Visible pane | The PTY host listed the run pane and returned a positive shell PID. | **WORKS** | The CLI is launched by typing into PowerShell, so native TUI prompts remain visible and interactive. |
| Real Codex build | `codex.exe` received the generated kickoff prompt in the run worktree and created `hello.py` plus `test_hello.py`. Independent execution printed `hello`; `python -m unittest -v` returned 0 and `OK`. | **WORKS WITH OWNER GATE** | A fresh path stops at Codex's native prompt: `Do you trust the contents of this directory? ... 1. Yes, continue ... Press enter to continue`. The live test explicitly selects `1` only because it created and controls the fixture. Production correctly leaves this decision in the visible TUI. |
| Native agent commit | Codex sometimes reached staging, but command approvals made agent-side stage/commit nondeterministic. | **BREAKS UNATTENDED** | The final proof does not auto-approve arbitrary Codex commands. It hands the two verified files to Morz's bounded Commit tool instead. |
| Morz commit tool | Called `stageFile` for exactly `hello.py` and `test_hello.py`, inspected `stagedDiff`, committed `feat: add hello program`, and verified `log` plus `git show`. Commit `539e637` contained exactly the two target files. | **WORKS** | The commit belonged to the disposable worktree and was removed during cleanup. |
| Cross-model reviewer | Called the real reviewer with author `codex`, base `main`, head `HEAD`. Real Claude returned strict JSON, `sameModelReview=false`, and zero findings. | **WORKS** | Review result is not connected to the run-state machine. |
| Run-store create/query | `listRuns` and `runStatus` returned the real run, run tag, agent detail, PID, port, branch, worktree, kickoff task, and state. | **WORKS** | Usage remained `{usd:null,tokens:null}` because raw dispatched panes do not feed adapter metering. |
| Automatic agent completion | After verified files, commit, and review, the agent was still `running`. | **BROKEN** | `setAgentRunState` exists in `dispatcher.ts` but is not exposed/wired to raw pane/adaptor results. |
| Automatic run completion | Immediately before Stop, the run was still `running`. | **BROKEN** | No commit/review/DoD event transitions the run through `merging` to `done`. |
| Kickoff bus task | Dispatch created an accepted kickoff task and recorded its ID in agent detail. | **PARTIAL** | The raw Codex pane did not claim or complete it; it remained `accepted`. The kickoff prompt does not perform the bus lifecycle automatically. |
| Approved bus handoff | The live test posted a handoff to `hello-builder`, observed the approval request, approved it, and saw the payload delivered. | **DELIVERY WORKS; WAKE BREAKS** | The task remained `accepted`. `handoff.ts` calls only Claude's structured `injectPointerPrompt`; the dispatched Codex TUI is not an adapter lane, so no pointer was injected and no claim occurred. |
| Connections detection | Live refresh reported Claude, Codex, and Agy installed. Claude/Codex authentication was not reported false. OpenCode was excluded from planning and dispatch. | **WORKS / BEST EFFORT** | Agy auth is always `null` because `authStatus` has no Agy probe. Installed is not the same as authenticated. |
| Running-lane detection | The active-agent pill showed `hello-builder` as Codex. `morzPaneInfo.list()` found `codex.exe` as the PowerShell descendant/foreground process. | **WORKS** | Dispatched pills primarily come from run state; process-tree detection supplied the live executable identity. |
| Global Stop | Stop killed the pane/process tree, released the run, and returned run=`aborted`, agent=`cancelled`; the PID became dead. | **WORKS** | A successful run still requires Stop because there is no done transition. |
| Cleanup | Cleanup removed the run worktree and branch; the test verified neither remained. | **WORKS** | Cleanup is only allowed after a terminal run state. |
| Codex `AgentAdapter` | `node scripts/adapters-smoke.mjs` produced `ADAPTER_OK`, a thread ID, a result event, and token usage. | **WORKS** | This adapter is not the path used by dispatcher panes. |
| Agy `AgentAdapter` | Real `agy.exe` started in ConPTY, but no joined reply token arrived in 300 seconds. Tail remained at the empty prompt with `Gemini 3.5 Flash (Medium)`. | **BROKEN LIVE** | Exact smoke error: `timeout: agy reply token`. The smoke exited 1. |
| Claude `AgentAdapter` | Source contract and existing live handoff pattern were reviewed, but the orchestrator proof used Claude planner/reviewer subprocesses, not `claudeAdapter`. | **NOT EXERCISED BY DISPATCH** | Dispatcher bypasses the adapter registry, so a separate lane test is not proof of orchestrated Claude dispatch. |

## Security and trust-boundary findings

### HIGH — rendered kickoff memory is an untracked repository file

- **Location:** `src/main/orchestrator/dispatcher.ts`, `launchAgent`, the `.morz/kickoff.md` write.
- **Observed:** live `git status --short` contained `?? .morz/`.
- **Risk:** `kickoff.md` contains the complete prompt and prepended rendered memory. An agent using `git add -A` can accidentally commit sensitive project/user context.
- **Fix:** keep kickoff material outside the worktree, or add `.morz/` to the worktree's private `.git/info/exclude` before launch. Do not silently modify the project's shared `.gitignore`.

### MEDIUM — raw pane dispatch bypasses normalized permission/state contracts

- **Locations:** `src/main/orchestrator/dispatcher.ts:168-179,300`; `src/main/adapters/registry.ts`.
- **Observed:** Codex's trust/command gates appeared only in the TUI; run state, bus handoff, usage, and reviewer state were unaware of them.
- **Risk:** the user can see the prompt, but orchestration cannot distinguish waiting-for-approval from productive work. Runs appear `running` indefinitely.
- **Fix:** either launch through a visible adapter-aware PTY seam or add a narrow terminal-event bridge that reports permission/block/result events without auto-approving them.

## Remaining breakage, in priority order

1. **No automatic `done`:** commit/review success does not update agent or run state.
2. **Dispatcher/adapters are disconnected:** raw panes bypass normalized events, permissions, metering, interrupt semantics, and pointer handoffs.
3. **Bus handoff cannot wake dispatched agents:** approved payload delivery works, but the task stays `accepted`.
4. **No Codex planner engine:** planning and amendments are hardwired to Claude.
5. **Native CLI gates require owner interaction:** Codex repository trust is expected and visible; later command approvals prevent an unattended agent-native commit.
6. **Agy adapter live round trip failed:** `timeout: agy reply token` after five minutes.
7. **Kickoff prompt/memory can be committed accidentally:** `.morz/kickoff.md` is untracked inside the worktree.
8. **Plan reroute immutable-field blocker exists on this branch:** exact error `Plan edit changed immutable fields for <agent>`; owned by Agent 1's parallel lane.
9. **No merge step was observed:** the disposable branch was reviewed and then removed, not merged back to the Space's base branch.

## Reproduction

The spec is opt-in and never spends tokens in the default suite:

```powershell
# Default/CI-safe proof
npx.cmd playwright test e2e/orch-e2e.spec.ts
# => 1 skipped

# Real end-to-end proof
$env:MORZ_LIVE_ORCH='1'
npx.cmd playwright test e2e/orch-e2e.spec.ts --reporter=list
# => 1 passed (1.7m)
```

The live test always creates an isolated repository, verifies that the planner preserved its exact `spaceRoot` before approval, stages only the two known files, and removes the run worktree/branch in `finally`.
