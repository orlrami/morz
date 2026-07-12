import { motion } from 'framer-motion'
import { IconChevronDown, IconChevronRight, IconGitBranch, IconPlus } from '@tabler/icons-react'
import { spaces, cliTint, cliLabel } from '@/lib/mock'
import { colors, statusColor } from '@/lib/tokens'
import { staggerContainer, staggerItem } from '@/lib/springs'
import { ModeDial } from './ModeDial'

/* Spaces sidebar: projects → agents with live status, CLI + model badges, branch. */
export function SpacesSidebar(): JSX.Element {
  const active = spaces[0]
  const collapsed = spaces[1]

  return (
    <aside
      className="flex w-[248px] shrink-0 flex-col overflow-hidden border-r"
      style={{ background: colors.panel, borderColor: 'var(--color-line)' }}
    >
      <div className="flex items-center justify-between px-4 pb-1 pt-3">
        <span className="text-[10px] uppercase tracking-wider" style={{ color: colors.quartzDim }}>
          Spaces
        </span>
        <button
          className="flex cursor-pointer items-center gap-1 rounded-md border px-2 py-0.5 text-[10.5px] font-semibold transition-colors hover:brightness-110"
          style={{
            background: 'rgba(203,162,90,0.14)',
            borderColor: 'rgba(203,162,90,0.32)',
            color: colors.bronzeHot,
            fontFamily: 'var(--font-display)'
          }}
        >
          <IconPlus size={11} stroke={2} />
          New team
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-2 py-1.5">
        {/* active space */}
        <div
          className="rounded-xl border px-2.5 py-2"
          style={{ background: colors.card + '66', borderColor: 'var(--color-line)' }}
        >
          <div className="flex items-center gap-1.5 px-1">
            <IconChevronDown size={12} stroke={1.5} style={{ color: colors.quartzDim }} />
            <span className="text-xs font-semibold" style={{ fontFamily: 'var(--font-display)' }}>
              {active.name}
            </span>
            <span className="ml-auto flex items-center gap-1 text-[10px]" style={{ color: colors.quartzDim }}>
              <IconGitBranch size={11} stroke={1.5} />
              {active.branch}
            </span>
          </div>

          <motion.ul variants={staggerContainer} initial="hidden" animate="show" className="mt-1.5 space-y-0.5">
            {active.agents.map((agent) => (
              <motion.li key={agent.id} variants={staggerItem}>
                <button
                  className="group flex w-full cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors"
                  style={{ color: colors.quartz }}
                  onMouseEnter={(e) => (e.currentTarget.style.background = colors.card)}
                  onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                >
                  <span className="relative flex size-2 shrink-0">
                    {agent.status === 'blocked' && (
                      <motion.span
                        className="absolute inset-0 rounded-full"
                        style={{ background: statusColor.blocked }}
                        animate={{ scale: [1, 1.9], opacity: [0.55, 0] }}
                        transition={{ duration: 1.6, repeat: Infinity, ease: 'easeOut' }}
                      />
                    )}
                    <span className="size-2 rounded-full" style={{ background: statusColor[agent.status] }} />
                  </span>
                  <span className="truncate text-xs">{agent.name}</span>
                  <span className="ml-auto flex shrink-0 items-center gap-1">
                    <span
                      className="rounded-md border px-1.5 py-px text-[9px] font-medium"
                      style={{ borderColor: 'var(--color-line-strong)', color: cliTint[agent.cli] }}
                    >
                      {cliLabel[agent.cli]}
                    </span>
                    <span
                      className="rounded-md border px-1.5 py-px text-[9px]"
                      style={{ borderColor: 'var(--color-line)', color: colors.quartzDim }}
                    >
                      {agent.model}
                    </span>
                  </span>
                </button>
              </motion.li>
            ))}
          </motion.ul>
        </div>

        {/* collapsed space */}
        <button
          className="mt-1.5 flex w-full cursor-pointer items-center gap-1.5 rounded-xl px-3.5 py-2 text-left transition-colors hover:bg-[#37332B]"
          style={{ color: colors.quartzDim }}
        >
          <IconChevronRight size={12} stroke={1.5} />
          <span className="text-xs font-semibold" style={{ color: colors.quartz, fontFamily: 'var(--font-display)' }}>
            {collapsed.name}
          </span>
          <span className="ml-auto flex items-center gap-1 text-[10px]">
            <IconGitBranch size={11} stroke={1.5} />
            {collapsed.branch}
          </span>
        </button>
      </div>

      <div className="border-t pt-2" style={{ borderColor: 'var(--color-line)' }}>
        <ModeDial />
        <div className="flex flex-wrap gap-x-3 gap-y-1 px-4 pb-3 text-[10px]" style={{ color: colors.quartzDim }}>
          <Legend color={statusColor.working} label="working" />
          <Legend color={statusColor.blocked} label="blocked" />
          <Legend color={statusColor.done} label="done" />
          <Legend color={statusColor.error} label="error" />
        </div>
      </div>
    </aside>
  )
}

function Legend({ color, label }: { color: string; label: string }): JSX.Element {
  return (
    <span className="flex items-center gap-1">
      <span className="size-1.5 rounded-full" style={{ background: color }} />
      {label}
    </span>
  )
}
