import { motion } from 'framer-motion'
import { IconFolder } from '@tabler/icons-react'
import type { MockAgent, MockBlock } from '@/lib/mock'
import { colors, statusColor } from '@/lib/tokens'
import { useTerminal } from '@/hooks/useTerminal'

interface TerminalPaneProps {
  agent: MockAgent
  blocks: MockBlock[]
  /** Live tail under the blocks: what the agent is doing right now. */
  tail?: 'cursor' | 'approval'
}

/*
 * Terminal pane — real xterm.js bound to the PTY-host (0.0.1 Slice 1).
 * One continuous buffer; OSC-133 command blocks render as marker-anchored
 * decorations (terminal-blocks.ts); ctrl/shift-click links emit 'open-file'
 * (terminal-links.ts). Pane-header chrome unchanged from Phase 0.
 * blocks/tail props kept for Shell.tsx compatibility; the mock stream is gone.
 */
export function TerminalPane({ agent }: TerminalPaneProps): JSX.Element {
  const blocked = agent.status === 'blocked'
  const { containerRef } = useTerminal(agent.id)

  return (
    <section
      className="relative flex min-w-0 flex-1 flex-col overflow-hidden"
      style={{ background: colors.page }}
      aria-label={`Terminal — ${agent.name}`}
    >
      {blocked && (
        <motion.div
          className="pointer-events-none absolute inset-0 z-10 rounded-none border-[1.5px]"
          style={{ borderColor: statusColor.blocked }}
          animate={{ opacity: [0.85, 0.35, 0.85] }}
          transition={{ duration: 1.8, repeat: Infinity, ease: 'easeInOut' }}
          aria-hidden
        />
      )}

      {/* pane header */}
      <div
        className="flex shrink-0 items-center gap-2 border-b px-3 py-2"
        style={{ background: colors.panel, borderColor: 'var(--color-line)' }}
      >
        <span className="size-2 rounded-full" style={{ background: statusColor[agent.status] }} />
        <span className="text-xs font-semibold" style={{ fontFamily: 'var(--font-display)' }}>
          {agent.name}
        </span>
        <span
          className="rounded-full px-2 py-px text-[9.5px] font-semibold"
          style={{
            background: `${statusColor[agent.status]}26`,
            color: statusColor[agent.status]
          }}
        >
          {blocked ? 'blocked · needs you' : agent.status}
        </span>
        <span className="ml-auto flex items-center gap-1 font-mono text-[10px]" style={{ color: colors.quartzDim }}>
          <IconFolder size={11} stroke={1.5} />
          {agent.worktree}
        </span>
      </div>

      {/* xterm mount — pl-3 leaves room for the block accent strips */}
      <div
        ref={containerRef}
        className="min-h-0 flex-1 py-2 pl-3 pr-1"
        style={{ background: colors.page }}
      />
    </section>
  )
}
