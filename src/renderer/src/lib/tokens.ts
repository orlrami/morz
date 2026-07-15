/* Morz design tokens — locked palette (Phase-0 brief, user approved). */
export const colors = {
  // Surfaces
  page: '#26241E', // graphite base — page background
  panel: '#2E2B24', // panel, card, sidebar
  card: '#37332B', // raised card, hover bg, active surface

  // Neutrals
  quartz: '#EEE6D9', // primary text, labels, active surfaces
  quartzDim: 'rgba(238,230,217,0.66)', // secondary text, placeholders
  quartzFaint: 'rgba(238,230,217,0.40)', // tertiary text, ghost labels

  // Brand + interactive
  bronze: '#CBA25A', // buttons, links, focus, brand
  bronzeHot: '#E4BC77', // hover, active bronze

  // Status semantic (pills, rings — context-separated from bronze)
  working: '#6AA6D9', // soft blue — in progress
  blocked: '#E4A94F', // muted amber — needs you
  done: '#7FB77E', // sage — complete
  error: '#D97C6A', // clay — failed
  warning: '#E0904C', // warm orange — caution

  // Per-agent identity tints (pane border, sidebar dot, DAG node)
  agentClaude: '#E0904C', // warm orange
  agentCodex: '#5FB39A', // muted teal-green
  agentGemini: '#6FA0D8', // soft blue
  agentOpenCode: '#A98BD1' // muted violet
}

export type AgentStatus = 'working' | 'blocked' | 'done' | 'error' | 'idle'

export const statusColor: Record<AgentStatus, string> = {
  working: colors.working,
  blocked: colors.blocked,
  done: colors.done,
  error: colors.error,
  idle: colors.quartzDim
}
