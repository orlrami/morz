/*
 * AI Report Engine contract (dogfood wave — "half-AI reports").
 * ONE configurable summarizer engine the whole app calls for AI reports:
 * commit summaries, file/PNG context, branch summaries, review write-ups.
 * BridgeMind-style — the user connects an engine (their own Claude CLI, or a
 * BYO key for OpenAI / Gemini / OpenRouter) and every "explain this" surface
 * routes through it. Owner: the `report-engine` agent implements it; commit-ai
 * + review-fix consume it. ADDITIVE changes only during the wave.
 */

export type ReportProvider =
  | 'claude-cli' // the user's logged-in `claude` (no key needed) — default
  | 'openai'
  | 'gemini'
  | 'openrouter'
  | 'anthropic-key' // BYO Anthropic API key

/** What kind of thing is being summarized — lets the engine pick a prompt. */
export type ReportKind =
  | 'commit' // "what is this commit about"
  | 'file' // "what is this file / when/why did it enter the branch"
  | 'branch' // "what does this branch do vs its base"
  | 'diff' // freeform diff explanation
  | 'review' // cross-model review write-up

export interface ReportRequest {
  kind: ReportKind
  /** The material to summarize (diff text, file path+meta, commit sha+message+diff). */
  context: string
  /** Optional cwd for CLI-based providers. */
  cwd?: string
}

export interface ReportResult {
  ok: boolean
  /** Markdown summary when ok; short error string when not. */
  text: string
  provider: ReportProvider
}

export interface ReportEngineConfig {
  provider: ReportProvider
  /** Model id for key-based providers (e.g. 'gpt-5.6', 'gemini-3.1-pro'). */
  model?: string
  /** True when a key is stored (never returns the key itself). */
  hasKey: boolean
  configured: boolean
}

export const ReportApi = {
  config: 'report:config', // () => Promise<ReportEngineConfig>
  setProvider: 'report:set-provider', // ({provider, model}) => Promise<ReportEngineConfig>
  setKey: 'report:set-key', // ({provider, key}) => Promise<ReportEngineConfig>  key → safeStorage
  clearKey: 'report:clear-key', // (provider) => Promise<ReportEngineConfig>
  test: 'report:test', // () => Promise<ReportResult>  cheap "reply OK"
  summarize: 'report:summarize' // (ReportRequest) => Promise<ReportResult>
} as const

/** window.morz.report — exposed by the preload (owner: report-engine agent). */
export interface MorzReportApi {
  config(): Promise<ReportEngineConfig>
  setProvider(provider: ReportProvider, model?: string): Promise<ReportEngineConfig>
  setKey(provider: ReportProvider, key: string): Promise<ReportEngineConfig>
  clearKey(provider: ReportProvider): Promise<ReportEngineConfig>
  test(): Promise<ReportResult>
  summarize(req: ReportRequest): Promise<ReportResult>
}

/** Main-side callable so other services (commit, review) summarize without IPC. */
export interface ReportEngine {
  summarize(req: ReportRequest): Promise<ReportResult>
  isConfigured(): boolean
}
