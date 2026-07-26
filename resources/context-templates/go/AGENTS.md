# AGENTS.md

<!-- Single source of truth for every coding agent in this repo. Codex reads it natively; -->
<!-- Claude Code via CLAUDE.md's @AGENTS.md import; Antigravity support is reported but unverified. -->
<!-- Target: under 150 lines. Only facts an agent CANNOT infer by reading the code. -->
<!-- No codebase overviews or directory listings: agents discover structure themselves, and -->
<!-- measured results (arXiv 2602.11988) show overviews cost tokens without improving outcomes. -->
<!-- HTML comments like these are stripped before loading, so they cost no context. -->

{{projectName}} — <one line: what this is and who uses it>.

## Non-negotiables

<!-- Ordered by blast radius: the worst mistake first. -->

- Never hand-edit <go.sum | generated path>. Regenerate with <go mod tidy>.
- Never commit directly to <main>. Branch as <type>/<short-description>.
- <Anything irreversible an agent could plausibly do: tag a release, force-push, rotate a key.>

## Commands

<!-- Exact, copy-pasteable, including any activation prefix. The highest-value section in this file. -->

- Deps:          <go mod download>
- Build:         <go build ./...>
- Dev server:    <cmd> (port <N>)
- Test (one):    <go test ./path/to/pkg -run '^TestName$'>   <!-- -run takes a REGEX; anchor it -->
- Test (all):    <go test ./...>   <!-- if slow, say how slow, so agents don't reach for it -->
- Vet:           <go vet ./...>
- Lint:          <golangci-lint run>
- Format:        <gofmt -w . | goimports -w .>

## Definition of done

<the one command that gates completion> passes, and you have shown its output.
Do not report a task complete on the basis that the code looks correct.

## Conventions that differ from the default

<!-- Only rules a linter CANNOT enforce. If a linter can enforce it, delete the line here and -->
<!-- configure the linter instead: never send an agent to do a linter's job. -->

- <e.g. All database access goes through src/db/ helpers. Never raw SQL in route handlers.>
- <e.g. Errors use the AppError type. Never throw strings.>

## Gotchas

<!-- Grow this from real friction: add an entry the SECOND time an agent makes the same mistake. -->
<!-- This section is what separates context files that help from ones that only cost tokens. -->
<!-- Best sources: anything that cost you >15 min to diagnose, and anything an agent -->
<!-- "fixed" that was deliberate. If a linter or hook can catch it, do that instead. -->

- <go test -run> takes a regex, not a literal name. Anchor it as '^TestName$' or you will
  silently run every test whose name contains that substring.
- <go test> caches passing results. Add <-count=1> to force a real re-run.

## Pull requests

- Title: <type>(<scope>): <summary>
- Run <lint cmd> and <test cmd> before committing.
