import { useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { IconHandStop, IconSteeringWheel, IconUsersGroup } from '@tabler/icons-react'
import { springs } from '@/lib/springs'
import { colors } from '@/lib/tokens'

const MODES = [
  { id: 'manual', label: 'Manual', icon: IconHandStop },
  { id: 'assisted', label: 'Assisted', icon: IconSteeringWheel },
  { id: 'orchestrated', label: 'Orchestrated', icon: IconUsersGroup }
] as const

type ModeId = (typeof MODES)[number]['id']

/*
 * Compact control dial for the status bar — "assist, don't take over."
 * Icon-only; hovering (or the active mode) spring-reveals the label.
 */
export function ModeDialCompact(): JSX.Element {
  const [mode, setMode] = useState<ModeId>('orchestrated')
  const [hovered, setHovered] = useState<ModeId | null>(null)

  return (
    <div
      className="flex items-center gap-0.5 rounded-full border p-0.5"
      style={{ background: colors.page, borderColor: 'var(--color-line-strong)' }}
      role="radiogroup"
      aria-label="Orchestration mode"
    >
      {MODES.map((m) => {
        const active = mode === m.id
        const expanded = active || hovered === m.id
        const Icon = m.icon
        return (
          <button
            key={m.id}
            role="radio"
            aria-checked={active}
            aria-label={m.label}
            onClick={() => setMode(m.id)}
            onMouseEnter={() => setHovered(m.id)}
            onMouseLeave={() => setHovered(null)}
            className="relative flex cursor-pointer items-center overflow-hidden rounded-full px-1.5 py-[3px]"
            style={{ color: active ? '#241c0a' : colors.quartzDim }}
          >
            {active && (
              <motion.span
                layoutId="mode-compact-pill"
                transition={springs.layout}
                className="absolute inset-0 rounded-full"
                style={{ background: `linear-gradient(180deg, ${colors.bronzeHot}, ${colors.bronze})` }}
              />
            )}
            <span className="relative flex items-center">
              <Icon size={12} stroke={2} />
              <AnimatePresence initial={false}>
                {expanded && (
                  <motion.span
                    initial={{ width: 0, opacity: 0 }}
                    animate={{ width: 'auto', opacity: 1, transition: springs.snappy }}
                    exit={{ width: 0, opacity: 0, transition: { duration: 0.12 } }}
                    className="overflow-hidden whitespace-nowrap text-[10px] font-semibold"
                    style={{ fontFamily: 'var(--font-display)' }}
                  >
                    <span className="pl-1">{m.label}</span>
                  </motion.span>
                )}
              </AnimatePresence>
            </span>
          </button>
        )
      })}
    </div>
  )
}
