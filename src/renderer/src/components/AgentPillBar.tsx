import { motion } from 'framer-motion'
import { spaces, cliTint } from '@/lib/mock'
import { colors, statusColor } from '@/lib/tokens'
import { springs } from '@/lib/springs'

/*
 * Agent pill-bar: one pill per active agent, identity tint + status ring.
 * Click a pill → focus that agent's pane (Phase 1 wiring).
 */
export function AgentPillBar(): JSX.Element {
  const agents = spaces[0].agents

  return (
    <div
      className="flex h-11 shrink-0 items-center gap-2 overflow-x-auto border-b px-3"
      style={{ background: colors.page, borderColor: 'var(--color-line)' }}
      role="tablist"
      aria-label="Active agents"
    >
      {agents.map((agent, i) => {
        const blocked = agent.status === 'blocked'
        return (
          <motion.button
            key={agent.id}
            role="tab"
            initial={{ opacity: 0, x: 24 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ ...springs.panel, delay: i * 0.05 }}
            whileHover={{ scale: 1.02 }}
            className="relative flex shrink-0 cursor-pointer items-center gap-2 rounded-full border py-1 pl-2 pr-3"
            style={{
              background: colors.panel,
              borderColor: blocked ? 'rgba(245,158,11,0.55)' : 'var(--color-line-strong)'
            }}
          >
            {blocked && (
              <motion.span
                className="absolute inset-0 rounded-full border"
                style={{ borderColor: statusColor.blocked }}
                animate={{ scale: [1, 1.12], opacity: [0.7, 0] }}
                transition={{ duration: 1.5, repeat: Infinity, ease: 'easeOut' }}
                aria-hidden
              />
            )}
            <span
              className="flex size-5 items-center justify-center rounded-full text-[9px] font-bold uppercase"
              style={{ background: `${cliTint[agent.cli]}22`, color: cliTint[agent.cli] }}
              aria-hidden
            >
              {agent.name.slice(0, 2)}
            </span>
            <span className="text-[11.5px] font-medium" style={{ fontFamily: 'var(--font-display)' }}>
              {agent.name}
            </span>
            <span className="size-1.5 rounded-full" style={{ background: statusColor[agent.status] }} />
          </motion.button>
        )
      })}

      <span className="ml-auto shrink-0 text-[10.5px]" style={{ color: colors.quartzDim }}>
        wave 2 of 2 · 1 blocked
      </span>
    </div>
  )
}
