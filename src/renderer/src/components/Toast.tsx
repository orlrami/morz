import { useEffect, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { IconBellRinging, IconX } from '@tabler/icons-react'
import { colors, statusColor } from '@/lib/tokens'
import { springs } from '@/lib/springs'

/*
 * Notification toast — fires when a background agent flips state
 * (blocked / done / error). Mock: shows one blocked toast after load.
 */
export function ToastHost(): JSX.Element {
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    const show = setTimeout(() => setVisible(true), 1400)
    const hide = setTimeout(() => setVisible(false), 9000)
    return () => {
      clearTimeout(show)
      clearTimeout(hide)
    }
  }, [])

  return (
    <div className="pointer-events-none absolute bottom-10 right-3 z-50">
      <AnimatePresence>
        {visible && (
          <motion.div
            initial={{ opacity: 0, y: 24, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1, transition: springs.float }}
            exit={{ opacity: 0, scale: 0.95, transition: { duration: 0.15 } }}
            className="pointer-events-auto flex w-[300px] items-start gap-2.5 rounded-2xl border p-3 shadow-2xl"
            style={{ background: colors.panel, borderColor: 'rgba(245,158,11,0.45)' }}
            role="status"
          >
            <span
              className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg"
              style={{ background: 'rgba(245,158,11,0.16)', color: statusColor.blocked }}
            >
              <IconBellRinging size={14} stroke={1.5} />
            </span>
            <span className="min-w-0 text-xs leading-snug">
              <span className="font-bold" style={{ fontFamily: 'var(--font-display)' }}>
                builder-2 needs you
              </span>
              <span className="block" style={{ color: colors.quartzDim }}>
                Approve write to <span className="font-mono" style={{ color: colors.bronzeHot }}>src/db/migrate.ts</span>
              </span>
              <span className="mt-1.5 flex gap-1.5">
                <button
                  className="cursor-pointer rounded-lg px-2.5 py-1 text-[10.5px] font-bold"
                  style={{ background: `linear-gradient(180deg, ${colors.bronzeHot}, ${colors.bronze})`, color: '#241c0a' }}
                  onClick={() => setVisible(false)}
                >
                  Approve
                </button>
                <button
                  className="cursor-pointer rounded-lg border px-2.5 py-1 text-[10.5px]"
                  style={{ borderColor: 'var(--color-line-strong)', color: colors.quartzDim }}
                  onClick={() => setVisible(false)}
                >
                  View
                </button>
              </span>
            </span>
            <button
              onClick={() => setVisible(false)}
              className="cursor-pointer rounded p-0.5 hover:bg-[#37332B]"
              aria-label="Dismiss"
              style={{ color: colors.quartzDim }}
            >
              <IconX size={12} stroke={1.5} />
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
