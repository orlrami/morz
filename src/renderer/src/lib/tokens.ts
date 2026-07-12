/* Morz design tokens — locked palette (Phase-0 brief, user approved). */
export const colors = {
  // Surfaces
  page: '#26241E', // graphite base — page background
  panel: '#2E2B24', // panel, card, sidebar
  card: '#37332B', // raised card, hover bg, active surface

  // Neutrals
  quartz: '#EEE6D9', // primary text, labels, active surfaces
  quartzDim: 'rgba(238,230,217,0.45)', // secondary text, placeholders

  // Brand + interactive
  bronze: '#CBA25A', // buttons, links, focus, brand
  bronzeHot: '#E4BC77', // hover, active bronze

  // Status semantic (pills, rings — context-separated from bronze)
  working: '#3B82F6', // blue — in progress
  blocked: '#F59E0B', // amber — needs you
  done: '#22C55E', // green — complete
  error: '#EF4444', // red — failed
  warning: '#F97316', // orange — caution

  // Per-agent identity tints (pane border, sidebar dot, DAG node)
  agentClaude: '#FB923C', // orange
  agentCodex: '#2DD4BF', // teal-green
  agentGemini: '#60A5FA', // blue
  agentOpenCode: '#A78BFA' // violet
} as const

export type AgentStatus = 'working' | 'blocked' | 'done' | 'error' | 'idle'

export const statusColor: Record<AgentStatus, string> = {
  working: colors.working,
  blocked: colors.blocked,
  done: colors.done,
  error: colors.error,
  idle: colors.quartzDim
}
