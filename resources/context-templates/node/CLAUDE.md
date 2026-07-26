@AGENTS.md

## Claude Code specifics

<!-- Everything cross-tool lives in AGENTS.md, imported above. Keep this file to the Claude-only -->
<!-- delta; if there is none, this file is correctly just the @AGENTS.md line. -->
<!-- On Windows use this @import rather than a symlink: symlinks need Admin or Developer Mode. -->

- Use plan mode for changes under <sensitive path, e.g. src/billing/>.
- Delegate multi-file investigation to subagents so the main context stays free for implementation.
- <Skill, hook, or MCP notes that apply only to Claude Code.>