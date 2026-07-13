import { useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { IconHandStop, IconSteeringWheel, IconUsersGroup } from '@tabler/icons-react'
import { springs } from '@/lib/springs'
import { colors } from '@/lib/tokens'
import { ORCHESTRATED_AVAILABLE, useModeStore, type MorzMode } from '@/store/modeStore'
import { useLaneStore } from '@/store/laneStore'
import { useLayoutStore } from '@/store/layoutStore'
import { getMorz } from '@/store/spaceStore'

const MODES: { id: MorzMode; label: string; icon: typeof IconHandStop }[] = [
  { id: 'manual', label: 'Manual', icon: IconHandStop },
  { id: 'assisted', label: 'Assisted', icon: IconSteeringWheel },
  { id: 'orchestrated', label: 'Orchestrated', icon: IconUsersGroup }
]

/*
 * Compact control dial for the status bar — "assist, don't take over."
 * Live (Slice 6): reads/sets modeStore. Orchestrated is a visible but
 * disabled position until 0.0.3. Switching into Manual winds down every
 * Claude lane so Manual is provably inert from that point on.
 */
export function ModeDialCompact(): JSX.Element {
  const mode = useModeStore((s) => s.mode)
  const setMode = useModeStore((s) => s.setMode)
  const [hovered, setHovered] = useState<MorzMode | null>(null)

  const switchMode = (next: MorzMode): void => {
    if (next === mode) return
    if (next === 'orchestrated' && !ORCHESTRATED_AVAILABLE) return
    if (next === 'manual') {
      // Last Claude calls happen HERE, while still leaving Assisted; once the
      // mode flips, nothing in the renderer touches window.morz.claude.
      const morz = getMorz()
      for (const lane of useLaneStore.getState().lanes) {
        morz?.claude.interrupt(lane.agentId)
        useLayoutStore.getState().removePane(lane.paneId)
        useLaneStore.getState().removeLane(lane.paneId)
      }
    }
    setMode(next)
  }

  return (
    <div
      className="flex items-center gap-0.5 rounded-full border p-0.5"
      style={{ background: colors.page, borderColor: 'var(--color-line-strong)' }}
      role="radiogroup"
      aria-label="Orchestration mode"
    >
      {MODES.map((m) => {
        const active = mode === m.id
        const disabled = m.id === 'orchestrated' && !ORCHESTRATED_AVAILABLE
        const expanded = active || hovered === m.id
        const Icon = m.icon
        return (
          <button
            key={m.id}
            role="radio"
            aria-checked={active}
            aria-disabled={disabled}
            aria-label={m.label}
            title={disabled ? 'Orchestrated ships in 0.0.3' : m.label}
            onClick={() => switchMode(m.id)}
            onMouseEnter={() => setHovered(m.id)}
            onMouseLeave={() => setHovered(null)}
            className={`relative flex items-center overflow-hidden rounded-full px-1.5 py-[3px] ${
              disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'
            }`}
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
                    <span className="pl-1">
                      {m.label}
                      {disabled && ' · 0.0.3'}
                    </span>
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
