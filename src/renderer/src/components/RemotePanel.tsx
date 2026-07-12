import { motion } from 'framer-motion'
import { IconMicrophone, IconLock } from '@tabler/icons-react'
import { spaces, cliTint, cliLabel } from '@/lib/mock'
import { colors, statusColor } from '@/lib/tokens'
import { staggerContainer, staggerItem, springs } from '@/lib/springs'

/*
 * Remote mission control — the phone view (Phase 5: morzd + relay, E2E).
 * Same event stream as the desktop; structured feed, not a raw terminal.
 * Shown here in a device frame so the mobile design reviews alongside desktop.
 */
export function RemotePanel(): JSX.Element {
  const agents = spaces[0].agents
  const blocked = agents.find((a) => a.status === 'blocked')!

  return (
    <section
      className="flex min-w-0 flex-1 items-center justify-center gap-10 overflow-auto p-6"
      style={{ background: colors.page }}
      aria-label="Remote mission control"
    >
      {/* phone frame */}
      <motion.div
        initial={{ y: 24, opacity: 0 }}
        animate={{ y: 0, opacity: 1, transition: springs.panel }}
        className="flex h-[640px] w-[312px] shrink-0 flex-col overflow-hidden rounded-[36px] border-[7px] shadow-2xl"
        style={{ background: colors.page, borderColor: '#14120d' }}
      >
        <div className="flex items-center justify-between px-5 pb-1 pt-3 text-[10px] font-semibold" style={{ color: colors.quartzDim }}>
          <span>9:41</span>
          <span className="flex items-center gap-1">
            <IconLock size={9} stroke={2} />
            Morz · E2E
          </span>
          <span>5G · 82%</span>
        </div>

        {/* push banner */}
        <div
          className="mx-2.5 mt-1 flex items-start gap-2.5 rounded-2xl border p-2.5"
          style={{ background: colors.card, borderColor: 'rgba(245,158,11,0.42)' }}
        >
          <span
            className="flex size-7 shrink-0 items-center justify-center rounded-lg text-[11px] font-extrabold"
            style={{ background: `linear-gradient(135deg, ${colors.bronzeHot}, #9a7226)`, color: '#241c0a' }}
          >
            M
          </span>
          <span className="min-w-0 text-[11px] leading-snug">
            <span className="font-bold">builder-2 needs you</span>
            <span className="block truncate font-mono text-[10px]" style={{ color: colors.quartzDim }}>
              Approve write to src/db/migrate.ts?
            </span>
          </span>
        </div>

        {/* fleet header + chips */}
        <div className="flex items-center gap-2 px-4 pb-1 pt-2.5">
          <span className="text-[15px] font-extrabold" style={{ fontFamily: 'var(--font-display)' }}>Fleet</span>
          <span className="text-[10px]" style={{ color: colors.quartzDim }}>morz-core</span>
          <span className="ml-auto flex items-center gap-1 text-[9.5px]" style={{ color: statusColor.done }}>
            <span className="size-1.5 rounded-full" style={{ background: statusColor.done }} />
            live
          </span>
        </div>
        <div className="flex gap-1.5 px-2.5 pb-2">
          {[
            { n: '2', l: 'working', c: statusColor.working },
            { n: '1', l: 'blocked', c: statusColor.blocked },
            { n: '1', l: 'done', c: statusColor.done },
            { n: '78%', l: 'Antigravity', c: colors.bronzeHot }
          ].map((chip) => (
            <span key={chip.l} className="flex-1 rounded-xl border p-1.5 text-center" style={{ background: colors.panel, borderColor: 'var(--color-line)' }}>
              <span className="block text-[14px] font-extrabold" style={{ color: chip.c, fontFamily: 'var(--font-display)' }}>{chip.n}</span>
              <span className="block text-[8.5px]" style={{ color: colors.quartzDim }}>{chip.l}</span>
            </span>
          ))}
        </div>

        {/* agent cards */}
        <motion.div variants={staggerContainer} initial="hidden" animate="show" className="min-h-0 flex-1 space-y-1.5 overflow-y-auto px-2.5">
          <motion.div
            variants={staggerItem}
            className="rounded-2xl border p-2.5"
            style={{ background: colors.panel, borderColor: 'rgba(245,158,11,0.5)' }}
          >
            <div className="flex items-center gap-2">
              <span className="size-2 rounded-full" style={{ background: statusColor.blocked }} />
              <span className="text-[12px] font-bold">{blocked.name}</span>
              <span className="text-[9px]" style={{ color: cliTint[blocked.cli] }}>{cliLabel[blocked.cli]}</span>
              <span className="ml-auto rounded-full px-1.5 py-px text-[8.5px] font-bold" style={{ background: 'rgba(245,158,11,0.16)', color: statusColor.blocked }}>
                blocked
              </span>
            </div>
            <p className="mt-1.5 text-[10.5px] leading-snug" style={{ color: colors.quartzDim }}>
              Wants to write prod migration <span className="font-mono" style={{ color: colors.bronzeHot }}>src/db/migrate.ts</span>
            </p>
            <div className="mt-2 flex gap-1.5">
              <button className="flex-1 cursor-pointer rounded-[10px] py-1.5 text-[11px] font-bold" style={{ background: `linear-gradient(180deg, ${colors.bronzeHot}, ${colors.bronze})`, color: '#241c0a' }}>
                Approve
              </button>
              <button className="flex-1 cursor-pointer rounded-[10px] border py-1.5 text-[11px] font-bold" style={{ borderColor: 'rgba(239,68,68,0.4)', color: colors.error }}>
                Deny
              </button>
              <button className="flex-1 cursor-pointer rounded-[10px] border py-1.5 text-[11px]" style={{ borderColor: 'var(--color-line-strong)', color: colors.quartzDim }}>
                Interrupt
              </button>
            </div>
          </motion.div>

          {agents
            .filter((a) => a.status !== 'blocked')
            .map((a) => (
              <motion.div key={a.id} variants={staggerItem} className="rounded-2xl border p-2.5" style={{ background: colors.panel, borderColor: 'var(--color-line)' }}>
                <div className="flex items-center gap-2">
                  <span className="size-2 rounded-full" style={{ background: statusColor[a.status] }} />
                  <span className="text-[12px] font-bold">{a.name}</span>
                  <span className="text-[9px]" style={{ color: cliTint[a.cli] }}>{cliLabel[a.cli]}</span>
                  <span className="ml-auto text-[8.5px]" style={{ color: statusColor[a.status] }}>{a.status}</span>
                </div>
                <p className="mt-1 truncate text-[10.5px]" style={{ color: colors.quartzDim }}>{a.activity}</p>
              </motion.div>
            ))}
        </motion.div>

        {/* steer */}
        <div className="flex items-center gap-2 border-t p-2.5" style={{ borderColor: 'var(--color-line)', background: colors.panel }}>
          <span className="flex-1 rounded-full border px-3 py-2 text-[11px]" style={{ background: colors.card, borderColor: 'var(--color-line-strong)', color: colors.quartzDim }}>
            Steer the team…
          </span>
          <span className="flex size-8 items-center justify-center rounded-full" style={{ background: `linear-gradient(135deg, ${colors.bronzeHot}, ${colors.bronze})`, color: '#241c0a' }}>
            <IconMicrophone size={14} stroke={2} />
          </span>
        </div>
      </motion.div>

      {/* side notes */}
      <div className="max-w-[300px] text-[12.5px] leading-relaxed" style={{ color: colors.quartzDim }}>
        <p className="text-sm font-bold" style={{ color: colors.quartz, fontFamily: 'var(--font-display)' }}>
          Your fleet, from anywhere.
        </p>
        <p className="mt-2">
          Same event stream as this desktop — structured feed, not a raw terminal. Approve, deny, or interrupt from
          the lock screen; batch approvals when several agents block at once; speak to steer.
        </p>
        <p className="mt-2">
          Outbound-only relay (no open ports) and end-to-end encrypted — the relay never reads your code.
        </p>
      </div>
    </section>
  )
}
