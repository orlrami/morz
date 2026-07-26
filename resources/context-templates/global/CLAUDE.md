# Personal defaults

<!-- Applies to every project on this machine. Target: under 50 lines. -->
<!-- Test for each line: if deleting it would not change what the agent does, delete it. -->
<!-- HTML comments like this one are stripped before loading and cost no context. -->

## Environment
- Shell: <pwsh | bash | zsh> — write commands in this syntax, not the other one.
- Package manager: <pnpm> — never <npm | yarn>.
- <Any machine quirk an agent cannot discover: WSL vs native, proxy, custom PATH, non-standard installs.>

## How I want you to work
- Do the task as asked. If you see a real problem with it, say so in a sentence, then continue.
- Ask before: schema or migration changes, auth changes, deleting data, changing a public API,
  adding a dependency, anything that costs money.
- Do not ask before: naming, internal helpers, obvious bug fixes, formatting lines you already touched.
- After two failed attempts at the same problem, STOP. Report what you tried, what failed,
  and what you need. Do not keep changing things at random.

## Verification
- Never report success you have not observed. Say "verified by <check>" or
  "not verified because <reason>". Both are acceptable; a false "works now" is not.
- Prefer the narrowest check that proves the change: one test, one typecheck, one command.

## Finishing
- End with: what changed (file paths), how it was verified, what is still open.
- Show evidence — the command and its output — rather than asserting it passed.