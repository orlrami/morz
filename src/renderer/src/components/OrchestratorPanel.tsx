import { motion } from 'framer-motion'
import { IconArrowUp } from '@tabler/icons-react'
import { spawnPlan, busEvents, cliTint } from '@/lib/mock'
import { colors } from '@/lib/tokens'
import { staggerContainer, staggerItem, springs } from '@/lib/springs'

const TAG_STYLE: Record<string, { bg: string; fg: string }> = {
  HANDOFF: { bg: 'rgba(203,162,90,0.16)', fg: '#E4BC77' },
  DONE: { bg: 'rgba(34,197,94,0.16)', fg: '#22C55E' },
  BLOCKED: { bg: 'rgba(245,158,11,0.16)', fg: '#F59E0B' }
}

/*
 * Orchestrator side panel = the live blackboard.
 * You talk to it; it proposes a plan; nothing spawns until you approve.
 */
export function OrchestratorPanel(): JSX.Element {
  return (
    <aside
      className="flex w-[330px] shrink-0 flex-col overflow-hidden border-l"
      style={{ background: colors.panel, borderColor: 'var(--color-line)' }}
      aria-label="Orchestrator"
    >
      {/* header */}
      <div className="flex items-center gap-2 border-b px-3.5 py-2.5" style={{ borderColor: 'var(--color-line)' }}>
        <span
          className="size-4 rounded-[5px]"
          style={{ background: `linear-gradient(135deg, ${colors.bronzeHot}, #9a7226)` }}
          aria-hidden
        />
        <span className="text-[13px] font-bold" style={{ fontFamily: 'var(--font-display)' }}>
          Orchestrator
        </span>
        <span className="ml-auto text-[10px]" style={{ color: colors.quartzDim }}>
          5 agents · 1 blocked
        </span>
      </div>

      {/* conversation */}
      <motion.div
        variants={staggerContainer}
        initial="hidden"
        animate="show"
        className="flex flex-1 flex-col gap-2.5 overflow-y-auto p-3"
      >
        <motion.div
          variants={staggerItem}
          className="max-w-[92%] self-end rounded-2xl rounded-br-[4px] border px-3 py-2 text-xs leading-relaxed"
          style={{ background: 'rgba(203,162,90,0.14)', borderColor: 'rgba(203,162,90,0.3)' }}
        >
          Run an 8-agent team to finish phase 5. Route the math to Gemini.
        </motion.div>

        <motion.div
          variants={staggerItem}
          className="max-w-[96%] self-start rounded-2xl rounded-bl-[4px] border px-3 py-2.5 text-xs leading-relaxed"
          style={{ background: colors.card + '99', borderColor: 'var(--color-line)', color: colors.quartzDim }}
        >
          <p>
            <strong style={{ color: colors.quartz }}>Plan — 5 agents, 2 waves.</strong> Routing math →{' '}
            <strong style={{ color: colors.quartz }}>agy / Gemini</strong> per your rules. Nothing launches until you
            approve.
          </p>

          <ul className="mt-2 overflow-hidden rounded-[10px] border" style={{ borderColor: 'var(--color-line-strong)' }}>
            {spawnPlan.map((row, i) => (
              <li
                key={row.id}
                className="flex items-center gap-2 px-2.5 py-1.5 text-[11px]"
                style={{ borderTop: i === 0 ? 'none' : '1px solid var(--color-line)' }}
              >
                <span className="size-1.5 rounded-full" style={{ background: cliTint[row.cli] }} />
                <span className="font-semibold" style={{ color: colors.quartz, fontFamily: 'var(--font-display)' }}>
                  {row.role}
                </span>
                <span className="truncate">{row.task}</span>
                <span className="ml-auto text-[9.5px]" style={{ color: colors.quartzDim }}>
                  {row.cli === 'agy' ? 'agy' : row.cli === 'claude' ? 'Claude' : 'Codex'}
                </span>
              </li>
            ))}
          </ul>

          <div className="mt-2.5 flex gap-2">
            <motion.button
              whileHover={{ scale: 1.02 }}
              transition={springs.snappy}
              className="cursor-pointer rounded-[10px] px-3.5 py-1.5 text-xs font-semibold"
              style={{
                background: `linear-gradient(180deg, ${colors.bronzeHot}, ${colors.bronze})`,
                color: '#241c0a',
                boxShadow: '0 4px 16px rgba(203,162,90,0.25)',
                fontFamily: 'var(--font-display)'
              }}
            >
              Approve &amp; launch
            </motion.button>
            <button
              className="cursor-pointer rounded-[10px] border px-3.5 py-1.5 text-xs font-medium"
              style={{ borderColor: 'var(--color-line-strong)', color: colors.quartzDim, fontFamily: 'var(--font-display)' }}
            >
              Edit plan
            </button>
          </div>
        </motion.div>
      </motion.div>

      {/* message bus */}
      <div className="border-t px-3.5 py-2.5" style={{ borderColor: 'var(--color-line)' }}>
        <p className="mb-1.5 text-[9.5px] uppercase tracking-wider" style={{ color: colors.quartzDim }}>
          ◇ Message bus
        </p>
        <ul className="space-y-1">
          {busEvents.map((event) => (
            <li key={event.id} className="flex items-center gap-2 text-[11px]" style={{ color: colors.quartzDim }}>
              <span
                className="rounded px-1.5 py-px text-[8.5px] font-extrabold"
                style={{ background: TAG_STYLE[event.tag].bg, color: TAG_STYLE[event.tag].fg }}
              >
                {event.tag}
              </span>
              <span className="truncate">{event.text}</span>
            </li>
          ))}
        </ul>
      </div>

      {/* steer input */}
      <div className="flex items-center gap-2 border-t p-3" style={{ borderColor: 'var(--color-line)' }}>
        <div
          className="flex-1 rounded-full border px-3.5 py-2 text-xs"
          style={{ background: colors.page, borderColor: 'var(--color-line-strong)', color: colors.quartzDim }}
        >
          Steer the team…
        </div>
        <button
          className="flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-full"
          style={{ background: `linear-gradient(135deg, ${colors.bronzeHot}, ${colors.bronze})`, color: '#241c0a' }}
          aria-label="Send"
        >
          <IconArrowUp size={15} stroke={2.5} />
        </button>
      </div>
    </aside>
  )
}
