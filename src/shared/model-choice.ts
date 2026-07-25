/*
 * w15/model-choice — which model each CLI launches with (WAVE15 slice 6).
 * Research spec: docs/research/MODEL-CONFIG-RESEARCH.md (verified July 2026).
 *
 * One ModelChoice per connection. Default is INHERIT: Morz adds NO flag and
 * the user's own CLI config decides — control philosophy ("assist, don't take
 * over"). A session flag applies per launch and touches no files. A cli-config
 * choice is applied by the user through a diff-first config-writer proposal;
 * launches then also add no flag (the CLI's own config carries the model).
 *
 * Every launch surface (Claude lanes, dispatcher, planner engines, pulse,
 * BYO opencode) resolves through this module's flag builders. Pure module —
 * no electron/node imports; renderer, main, and tests all share it.
 */

export type ModelCli = 'claude' | 'codex' | 'agy' | 'opencode'

export type ModelSource = 'inherit' | 'session-flag' | 'cli-config'

export interface ModelChoice {
  cli: ModelCli
  /** Catalog id or full model id; 'inherit' = respect the CLI's own default. */
  model: string | 'inherit'
  source: ModelSource
  /** Claude only: --fallback-model chain (print mode), comma-joined. */
  fallback?: string | null
}

export const MODEL_CLIS: readonly ModelCli[] = ['claude', 'codex', 'agy', 'opencode']

export const MODEL_SOURCES: readonly ModelSource[] = ['inherit', 'session-flag', 'cli-config']

/** CLIs whose persistent default Morz can propose a config diff for (agy has
 * no supported config write — session flag or inherit only). */
export const CONFIG_WRITE_CLIS: readonly ModelCli[] = ['claude', 'codex', 'opencode']

/** Model ids travel into spawn args and typed PTY commands — keep them to a
 * strict shape (letters/digits plus . _ / : -) so they can never smuggle
 * quotes, spaces, or shell metacharacters. */
export const SAFE_MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._/:-]*$/

export function isSafeModelId(model: string): boolean {
  return model.length <= 120 && SAFE_MODEL_RE.test(model)
}

export interface ModelCatalogEntry {
  id: string
  label: string
}

/** Static catalogs (July 2026) — the floor; `agy models` / `opencode models`
 * refresh on connections sync merges on top (best-effort, never required). */
export const MODEL_CATALOGS: Record<ModelCli, readonly ModelCatalogEntry[]> = {
  claude: [
    { id: 'fable', label: 'Fable 5' },
    { id: 'opus', label: 'Opus' },
    { id: 'sonnet', label: 'Sonnet' },
    { id: 'haiku', label: 'Haiku' }
  ],
  codex: [
    { id: 'gpt-5.5', label: 'GPT-5.5' },
    { id: 'gpt-5.4', label: 'GPT-5.4' }
  ],
  agy: [
    { id: 'gemini-3.5-flash', label: 'Gemini 3.5 Flash' },
    { id: 'gemini-3.1-pro', label: 'Gemini 3.1 Pro' },
    { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6' },
    { id: 'claude-opus-4-6', label: 'Claude Opus 4.6' },
    { id: 'gpt-oss-120b', label: 'GPT-OSS 120B' }
  ],
  opencode: [{ id: 'anthropic/claude-sonnet-4-5', label: 'anthropic/claude-sonnet-4-5' }]
}

/** The default (and only fallback) choice: inherit, no flag, no files. */
export function inheritChoice(cli: ModelCli): ModelChoice {
  return { cli, model: 'inherit', source: 'inherit', fallback: null }
}

/** True when this choice makes the launch carry a model flag. */
export function appliesAsFlag(choice: ModelChoice): boolean {
  return (
    choice.source === 'session-flag' &&
    choice.model !== 'inherit' &&
    isSafeModelId(choice.model)
  )
}

/** Per-CLI model flag argv (research matrix): claude/agy/opencode use
 * --model, codex uses -m. Inherit (or a non-flag source) = NO flag. */
export function modelFlagArgs(choice: ModelChoice): string[] {
  if (!appliesAsFlag(choice)) return []
  switch (choice.cli) {
    case 'claude':
      return ['--model', choice.model]
    case 'codex':
      return ['-m', choice.model]
    case 'agy':
      return ['--model', choice.model]
    case 'opencode':
      return ['--model', choice.model]
  }
}

/** Parse a user-typed fallback chain ("opus, sonnet") into safe ids. */
export function parseFallbackChain(raw: string | null | undefined): string[] {
  if (!raw) return []
  return raw
    .split(/[,\s]+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0 && isSafeModelId(part))
}

/** Claude print-mode fallback chain (--fallback-model a,b). Only meaningful
 * alongside a session flag; interactive panes never get it. */
export function claudeFallbackArgs(choice: ModelChoice): string[] {
  if (choice.cli !== 'claude' || !appliesAsFlag(choice)) return []
  const chain = parseFallbackChain(choice.fallback)
  return chain.length > 0 ? ['--fallback-model', chain.join(',')] : []
}

/** The typed-into-a-pane command suffix (dispatcher-visible launch). agy gets
 * quoted per the research matrix; ids are SAFE_MODEL_RE-clean so the quotes
 * are cosmetic, not load-bearing. Empty string when no flag applies. */
export function launchCommandModelSuffix(choice: ModelChoice): string {
  if (!appliesAsFlag(choice)) return ''
  switch (choice.cli) {
    case 'claude':
      return ` --model ${choice.model}`
    case 'codex':
      return ` -m ${choice.model}`
    case 'agy':
      return ` --model "${choice.model}"`
    case 'opencode':
      return ` --model ${choice.model}`
  }
}

/** Where a cli-config write would land (display label — resolution of the
 * real absolute path lives in the config-writer). */
export const MODEL_CONFIG_PATH_LABEL: Record<ModelCli, string | null> = {
  claude: '~\\.claude\\settings.json',
  codex: '~\\.codex\\config.toml',
  agy: null,
  opencode: 'opencode.json'
}

const CLI_COMMAND: Record<ModelCli, string> = {
  claude: 'claude',
  codex: 'codex',
  agy: 'agy',
  opencode: 'opencode'
}

/** The live mono mechanism line (settings card + spawn transparency). */
export function describeMechanism(choice: ModelChoice): string {
  const command = CLI_COMMAND[choice.cli]
  const configLabel = MODEL_CONFIG_PATH_LABEL[choice.cli]
  if (choice.source === 'inherit' || choice.model === 'inherit') {
    return configLabel
      ? `every launch → ${command} with no model flag — your ${configLabel} decides`
      : `every launch → ${command} with no model flag — the CLI's own default decides`
  }
  if (choice.source === 'session-flag') {
    const fallback = claudeFallbackArgs(choice)
    const suffix = launchCommandModelSuffix(choice)
    const chain = fallback.length > 0 ? ` --fallback-model ${fallback[1]}` : ''
    return `every launch → ${command}${suffix}${chain} · no files touched`
  }
  return configLabel
    ? `proposes a diff to ${configLabel} → model: "${choice.model}" — you approve before it lands`
    : `no config write supported for ${command} — use a session flag`
}
