// w11/catalog — hand-maintained recommendation policy, independent of registry ranking.
export interface CuratedMcpGroup {
  label: string
  identifiers: readonly string[]
}

export const RECOMMENDED_MCP_LIMIT = 24

export const CURATED_MCP_ALLOWLIST: readonly CuratedMcpGroup[] = [
  { label: 'Scribe', identifiers: ['scribe-mcp', 'scribe'] },
  { label: 'Stripe', identifiers: ['com.stripe/mcp', '@stripe/mcp', 'stripe'] },
  { label: 'Figma', identifiers: ['figma-mcp', 'figma'] },
  { label: 'GitHub', identifiers: ['github-mcp-server', 'github'] },
  { label: 'Sentry', identifiers: ['sentry-mcp', 'sentry'] },
  { label: 'Notion', identifiers: ['notion-mcp', 'notion'] },
  { label: 'Playwright', identifiers: ['playwright-mcp', 'playwright'] },
  { label: 'PostgreSQL', identifiers: ['postgresql-mcp', 'postgres-mcp', 'postgresql', 'postgres'] },
  { label: 'Supabase', identifiers: ['supabase-mcp', 'supabase'] },
  { label: 'Linear', identifiers: ['linear-mcp', 'linear'] },
  { label: 'Slack', identifiers: ['slack-mcp', 'slack'] },
  { label: 'Cloudflare', identifiers: ['cloudflare-mcp', 'cloudflare'] },
  { label: 'Brave Search', identifiers: ['brave-search-mcp', 'brave-mcp', 'brave-search', 'brave search', 'brave'] },
  { label: 'Exa Search', identifiers: ['exa-search-mcp', 'exa-mcp', 'exa-search', 'exa search', 'exa'] },
  { label: 'Filesystem', identifiers: ['filesystem-mcp', 'server-filesystem', 'filesystem'] },
  { label: 'Puppeteer', identifiers: ['puppeteer-mcp', 'puppeteer'] },
  {
    label: 'Claude design tools',
    identifiers: [
      'claude-code-design',
      'claude-design-mcp',
      'anthropic-design-mcp',
      'claude designer',
      'anthropic designer',
      'claude design',
      'anthropic design'
    ]
  }
]

// Normalized whole-token patterns. Keep broad categories such as "crypto" out so
// legitimate official integrations (for example Coinbase) remain eligible.
export const MCP_RECOMMENDATION_DENYLIST: readonly string[] = [
  'ibm',
  'granite',
  'watson',
  'watsonx',
  'watson x',
  'pump.fun',
  'pump fun',
  'pump',
  'memecoin',
  'meme coin',
  'shitcoin',
  'shit coin',
  'airdrop',
  'solana sniper',
  'solana trading bot',
  'crypto trading bot',
  'token sniper',
  'casino',
  'gambling',
  'wallet drainer',
  'wallet drain'
]
