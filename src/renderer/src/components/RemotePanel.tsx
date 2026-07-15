import { motion } from 'framer-motion'
import { IconDeviceMobile, IconLock } from '@tabler/icons-react'
import { colors } from '@/lib/tokens'
import { springs } from '@/lib/springs'

/* Remote remains on the roadmap, but this build has no relay or mobile client. */
export function RemotePanel(): JSX.Element {
  return (
    <section
      className="flex min-w-0 flex-1 items-center justify-center overflow-auto p-6"
      style={{ background: colors.page }}
      aria-label="Remote"
    >
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0, transition: springs.panel }}
        className="max-w-[440px] rounded-2xl border p-7 text-center shadow-xl"
        style={{ background: colors.panel, borderColor: 'var(--color-line-strong)' }}
      >
        <span
          className="mx-auto flex size-12 items-center justify-center rounded-2xl border"
          style={{ background: colors.card, borderColor: 'var(--color-line)', color: colors.bronzeHot }}
        >
          <IconDeviceMobile size={24} stroke={1.4} />
        </span>
        <h1 className="mt-4 text-base font-bold" style={{ fontFamily: 'var(--font-display)' }}>
          Morz remote ships in a future version
        </h1>
        <p className="mt-2 text-xs leading-relaxed" style={{ color: colors.quartzDim }}>
          The mobile mission-control client and its outbound relay are parked on the roadmap. This desktop build
          does not send agent activity to a remote service.
        </p>
        <p
          className="mt-4 flex items-center justify-center gap-1.5 rounded-lg border px-3 py-2 text-[10.5px]"
          style={{ background: colors.card, borderColor: 'var(--color-line)', color: colors.quartzDim }}
        >
          <IconLock size={12} stroke={1.6} />
          No relay is configured or running.
        </p>
      </motion.div>
    </section>
  )
}
