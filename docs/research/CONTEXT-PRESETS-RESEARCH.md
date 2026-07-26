# Context-file presets — research base (2026-07-25)

*What Morz's shipped CLAUDE.md/AGENTS.md/STATUS.md presets are built on. Full drafts live in `resources/context-templates/`.*

## The evidence

**Anthropic (code.claude.com/docs/en/best-practices + /memory):** per-line test — "would removing this cause mistakes? If not, cut it"; **under 200 lines** ("bloated CLAUDE.md files cause Claude to ignore your actual instructions"); explicit include/exclude table (include: unguessable commands, deviating conventions, gotchas, env quirks; exclude: anything inferable from code, API docs, frequently-changing info, "write clean code" filler); CLAUDE.md is advisory context, NOT enforcement — must-always-run → hook, sometimes-relevant → skill, must-block → permissions.deny; `@path` imports (4 hops, no context savings); **HTML comments are stripped before injection** — free in-template guidance; emphasis ("IMPORTANT", "YOU MUST") works.

**ETH Zurich study (arXiv 2602.11988, 138 instances, 12 repos, 3 agents):** **LLM-generated context files HURT** (−0.5 to −2 pts); human-written helped ~+4 pts; every context file costs 14–22% more tokens; **repository overviews specifically did not help**. Why: human files contain information that exists nowhere else; generated files duplicate the README. → Morz ships fill-in scaffolds, never auto-generated prose.

**agents.md standard (Linux Foundation / Agentic AI Foundation):** nearest-file-wins nesting; Codex chain `~/.codex/AGENTS.override.md → AGENTS.md → repo root→cwd`, 32KiB cap; **Claude Code does not read AGENTS.md** — the documented bridge is `@AGENTS.md` as CLAUDE.md's first line (symlinks need Admin/Dev-Mode on Windows → import is the only safe default for Morz). Antigravity reportedly reads AGENTS.md + GEMINI.md, but this rests on secondary blogs only (support and merge precedence both unverified — check the shipping build before Morz leans on it).

**HumanLayer ("Writing a good CLAUDE.md"):** "never send an LLM to do a linter's job"; under 300 lines (their own: under 60); instruction budget ~150–200 with ~50 already spent by the system prompt; progressive disclosure (pointer docs the agent chooses to read); "prefer pointers to copies"; against `/init`-style generation.

**Verified production files:** getsentry/sentry (AGENTS.md as declared single source of truth; exact executable paths first; "agents can't see the devserver terminal" gotcha), cloudflare/workers-sdk (rules ordered by blast radius; WHERE-TO-LOOK table), openai/codex (hard guardrails + size ceilings; long because it's a lint-spec, not a template to copy).

**Attribution note:** the circulated "Boris Cherny CLAUDE.md" gist has no verifiable provenance (owned by unrelated account, no byline). Shipped nowhere in Morz under his name; its useful content is covered by official docs.

## The architecture the presets encode

AGENTS.md = single cross-CLI source of truth (<150 lines). CLAUDE.md = `@AGENTS.md` + Claude-only delta (<10 lines). Global `~/.claude/CLAUDE.md` = personal working contract (<50 lines). STATUS.md = per-TASK working doc (checkable goal, out-of-scope, verification command, decisions, next-session notes) — survives compaction because it's a file.

UI rules to build around them (0.0.6 candidates): every slot is a blank, never generated prose; live line-count warning at 150/200; "graduate this rule" → hook/skill/permissions.deny; sync global CLAUDE.md ↔ `~/.codex/AGENTS.md` from one editor; "agent hit this twice → add to Gotchas?" nudge.

## Sources
code.claude.com/docs/en/{best-practices,memory,large-codebases} · agents.md · learn.chatgpt.com/docs/agent-configuration/agents-md · arxiv.org/abs/2602.11988 · humanlayer.dev/blog/writing-a-good-claude-md · github.com/{openai/codex,getsentry/sentry,cloudflare/workers-sdk}/blob/*/AGENTS.md · linuxfoundation.org (Agentic AI Foundation) · collections: awesome-claude-code, awesome-claude-md, awesome-agents-md
