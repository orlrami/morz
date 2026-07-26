# <Task or feature name>

<!-- One file per task, not one per repo. Update as you go, not at the end. -->
<!-- This is the handoff: assume the next session starts with zero memory of this one. -->
<!-- Committed to the repo so it survives context compaction, which conversation history does not. -->

**Status:** <not started | in progress | blocked | done>
**Updated:** <YYYY-MM-DD>
**Branch:** <branch>

## Goal

<One paragraph. State what is true when this is finished, phrased so it can be CHECKED rather
than judged. "Invalid emails are rejected and covered by a test" — not "improve validation".>

## Out of scope

- <Things a reasonable person might add but should not. This prevents more rework than the plan does.>

## Verification

The check that proves this works: <command, or the manual steps>
Passing looks like: <expected output / observable result>

## Plan

- [ ] <step>
- [ ] <step>

## Decisions

| Decision | Chosen | Why | Reversible? |
|---|---|---|---|
| <e.g. session storage> | <Redis> | <needs cross-process TTL> | <yes, behind SessionStore> |

## Files touched

- <path> — <what changed>

## Open questions / blockers

- <Question> — needs <who or what> to resolve.

## Notes for the next session

<The two or three things you would say out loud handing this to a colleague.
Include dead ends explicitly, so nobody retries them.>