import { useState } from 'react'
import { motion } from 'framer-motion'
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
 * The control dial — "assist, don't take over."
 * Always visible; the user picks how much Morz does. Nothing auto-spawns.
 */
export function ModeDial(): JSX.Element {
  const [mode, setMode] = useState<ModeId>('orchestrated')

  return (
    <div className="px-3 pb-3">
      <p className="mb-1.5 px-1 text-[10px] uppercase tracking-wider" style={{ color: colors.quartzDim }}>
        Control
      </p>
      <div
        className="flex rounded-[10px] border p-0.5"
        style={{ background: colors.page, borderColor: 'var(--color-line)' }}
        role="radiogroup"
        aria-label="Orchestration mode"
      >
        {MODES.map((m) => {
          const active = mode === m.id
          const Icon = m.icon
          return (
            <button
              key={m.id}
              role="radio"
              aria-checked={active}
              onClick={() => setMode(m.id)}
              className="relative flex flex-1 cursor-pointer items-center justify-center gap-1 rounded-lg px-1 py-1.5 text-[10.5px] font-medium"
              style={{
                color: active ? colors.quartz : colors.quartzDim,
                fontFamily: 'var(--font-display)'
              }}
            >
              {active && (
                <motion.span
                  layoutId="mode-dial-pill"
                  transition={springs.layout}
                  className="absolute inset-0 rounded-lg border"
                  style={{ background: colors.card, borderColor: 'var(--color-line-strong)' }}
                />
              )}
              <span className="relative flex items-center gap-1">
                <Icon size={12} stroke={1.5} />
                {m.label}
              </span>
            </button>
          )
        })}
      </div>
    </div>
  )
}
