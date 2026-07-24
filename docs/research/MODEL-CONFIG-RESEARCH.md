# Per-session model configuration across CLIs (research, 2026-07-24)

How Morz sets WHICH MODEL each CLI launches with — per session (spawn args) and persistent (config writes via the 0.0.2 config-writer). Verified July 2026; claude flag help verified locally (v2.1.187), agy inspected locally (v1.0.14+).

## Matrix

| CLI | Per-session (Morz spawn args) | Persistent default | Models (July 2026) | Notes |
|---|---|---|---|---|
| **Claude Code** | `claude --model <alias\|full-id>` — works interactive AND `-p` (verified locally) | `model` key in `~/.claude/settings.json` (user) / `.claude/settings.json` (project) / `settings.local.json` (git-ignored, wins) | aliases `fable`, `opus`, `sonnet`, `haiku`; full ids `claude-fable-5`, `claude-opus-4-8`, `claude-sonnet-4-6`, `claude-haiku-4-5` | `/model` switches mid-session. `--fallback-model a,b` chain (print mode). No ANTHROPIC_MODEL env support. Precedence: flag > /model > settings.local > settings |
| **Codex CLI** | `codex -m <model>` / `codex exec --model <model>` | `model = "gpt-5.5"` in `~/.codex/config.toml` (+ `model_provider`); `CODEX_MODEL` env | `gpt-5.5` (default, 400k ctx), `gpt-5.4`; `gpt-5.2/5.1-codex` deprecated 2026-07-23 | Custom providers via `[model_providers.<id>]` (base_url/env_key, `wire_api="responses"` only) → OpenRouter/Azure/Ollama/LM Studio. Global config only, no per-project |
| **Antigravity (agy)** | `agy --model "<id>"` | default in `~/.gemini/config/config.json` (+ `~/.gemini/antigravity-cli/settings.json`) | `gemini-3.5-flash` (default), `gemini-3.1-pro` (High/Low), `claude-sonnet-4-6`, `claude-opus-4-6`, `gpt-oss-120b` | `/model` mid-session; `agy models` lists. agy itself is multi-vendor (runs Claude/GPT-OSS) |
| **OpenCode** | `opencode --model <provider/model>` / `opencode run -m ...` | `"model": "provider/model"` in `./opencode.json` (project) or `~/.config/opencode/opencode.json` (global); `small_model` optional; `OPENCODE_CONFIG` env points at a file | `provider/model` format, e.g. `anthropic/claude-sonnet-4-5`; `opencode models [provider]` lists | Auth via `opencode auth login` → `~/.local/share/opencode/auth.json`. Models.dev registry + custom providers |

## Morz design consequences
- **One `ModelChoice` abstraction per connection:** `{ cli, model, source: 'session-flag' | 'user-config' | 'inherit' }`. Default = **inherit** (respect the user's own CLI config — control philosophy). Session override = spawn flag only. Persistent change = diff-first config write through the existing config-writer (backups, mtime-guard) — never silent.
- Every launch surface (lane robot, dispatcher promptSeed, planner engines, pulse) resolves through this abstraction.
- Show the mechanism in the UI (mono hint: `--model sonnet` / `~/.codex/config.toml`) — transparency beats magic.
- Model catalogs per CLI are static tables + `agy models` / `opencode models` detection where available; refresh on connections sync.

## Sources
- claude: local `claude --help` (v2.1.187) + agent doc research (settings hierarchy)
- codex: morphllm.com/codex-provider-configuration; codex.danielvaughan.com custom-providers guide
- agy: antigravity.google/docs/cli/using; antigravity.google/docs/models; local `agy --help` + `~/.gemini` inspection
- opencode: opencode.ai/docs/cli; open-code.ai/en/docs/config
