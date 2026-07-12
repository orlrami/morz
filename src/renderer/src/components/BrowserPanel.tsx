import { motion } from 'framer-motion'
import { IconRefresh, IconCrosshair, IconDeviceMobile, IconDeviceDesktop, IconSend } from '@tabler/icons-react'
import { colors } from '@/lib/tokens'
import { cliTint } from '@/lib/mock'
import { springs } from '@/lib/springs'

/*
 * In-app browser + element pick (design workflow).
 * Phase 4 wiring: BrowserView + CDP; pick assembles an ElementContext
 * (ref + selector + styles + crop + source loc) routed over the bus.
 * Image+styles go to Antigravity/Gemini for design critique; source-loc+HTML
 * to the code agent for the edit.
 */
export function BrowserPanel(): JSX.Element {
  return (
    <section className="flex min-w-0 flex-1 flex-col" style={{ background: colors.page }} aria-label="Browser">
      {/* toolbar */}
      <div className="flex items-center gap-2 border-b px-3 py-2" style={{ borderColor: 'var(--color-line)' }}>
        <IconRefresh size={14} stroke={1.5} style={{ color: colors.quartzDim }} />
        <div
          className="flex flex-1 items-center gap-2 rounded-[10px] border px-3 py-1.5 font-mono text-[11px]"
          style={{ background: colors.panel, borderColor: 'var(--color-line-strong)', color: colors.quartzDim }}
        >
          localhost:5173
          <span className="ml-auto rounded-full px-2 py-px text-[9px] font-semibold" style={{ background: 'rgba(34,197,94,0.16)', color: colors.done }}>
            HMR live
          </span>
        </div>
        <button
          className="flex cursor-pointer items-center gap-1.5 rounded-[10px] border px-2.5 py-1.5 text-[11px] font-semibold"
          style={{ borderColor: 'rgba(203,162,90,0.45)', color: colors.bronzeHot, background: 'rgba(203,162,90,0.12)', fontFamily: 'var(--font-display)' }}
        >
          <IconCrosshair size={13} stroke={2} />
          Pick element — on
        </button>
        <span className="flex gap-1" style={{ color: colors.quartzDim }}>
          <IconDeviceDesktop size={14} stroke={1.5} style={{ color: colors.quartz }} />
          <IconDeviceMobile size={14} stroke={1.5} />
        </span>
      </div>

      <div className="flex min-h-0 flex-1">
        {/* fake rendered page with picked element */}
        <div className="relative m-4 min-w-0 flex-1 overflow-hidden rounded-xl border" style={{ background: '#FBF8F2', borderColor: 'var(--color-line-strong)' }}>
          <div className="p-8">
            <div className="h-4 w-40 rounded" style={{ background: '#D8D2C4' }} />
            <div className="mt-6 h-8 w-3/5 rounded" style={{ background: '#3A362C' }} />
            <div className="mt-3 h-3 w-4/5 rounded" style={{ background: '#D8D2C4' }} />
            <div className="mt-2 h-3 w-3/5 rounded" style={{ background: '#D8D2C4' }} />
            {/* the picked element */}
            <motion.div
              className="relative mt-6 inline-block rounded-lg px-6 py-3 text-sm font-semibold"
              style={{ background: '#C24E32', color: '#fff', fontFamily: 'var(--font-display)' }}
              animate={{ boxShadow: ['0 0 0 2px rgba(203,162,90,0.9), 0 0 0 6px rgba(203,162,90,0.25)', '0 0 0 2px rgba(203,162,90,0.9), 0 0 0 10px rgba(203,162,90,0)'] }}
              transition={{ duration: 1.6, repeat: Infinity, ease: 'easeOut' }}
            >
              Start free trial
              <span
                className="absolute -top-6 left-0 rounded-md px-1.5 py-0.5 font-mono text-[9.5px] font-normal"
                style={{ background: colors.panel, color: colors.bronzeHot, border: '1px solid rgba(203,162,90,0.45)' }}
              >
                button.cta-primary · @e5
              </span>
            </motion.div>
            <div className="mt-8 grid grid-cols-3 gap-4">
              {[0, 1, 2].map((i) => (
                <div key={i} className="h-24 rounded-lg" style={{ background: '#EAE4D6' }} />
              ))}
            </div>
          </div>
        </div>

        {/* ElementContext card */}
        <motion.aside
          initial={{ x: 40, opacity: 0 }}
          animate={{ x: 0, opacity: 1, transition: springs.panel }}
          className="my-4 mr-4 flex w-[260px] shrink-0 flex-col rounded-xl border p-3"
          style={{ background: colors.panel, borderColor: 'var(--color-line-strong)' }}
          aria-label="Picked element"
        >
          <p className="text-[10px] uppercase tracking-wider" style={{ color: colors.quartzDim }}>
            Picked element
          </p>
          <p className="mt-1 font-mono text-[11px]" style={{ color: colors.bronzeHot }}>
            button.cta-primary <span style={{ color: colors.quartzDim }}>· @e5</span>
          </p>
          <p className="font-mono text-[10px]" style={{ color: colors.quartzDim }}>
            src/components/Hero.tsx:42
          </p>

          <div className="mt-2 rounded-lg border p-2 font-mono text-[10px] leading-relaxed" style={{ borderColor: 'var(--color-line)', color: colors.quartzDim }}>
            <p>background: #C24E32</p>
            <p>padding: 12px 24px</p>
            <p>border-radius: 8px</p>
            <p>font: 600 14px Geist</p>
            <p style={{ color: colors.quartzDim }}>+ 26 more · crop 218×46</p>
          </div>

          <p className="mt-3 text-[10px] uppercase tracking-wider" style={{ color: colors.quartzDim }}>
            Send to
          </p>
          <div className="mt-1.5 space-y-1.5">
            <button
              className="flex w-full cursor-pointer items-center gap-2 rounded-[10px] border px-2.5 py-2 text-left text-[11px]"
              style={{ borderColor: 'var(--color-line-strong)', color: colors.quartz }}
            >
              <span className="size-1.5 rounded-full" style={{ background: cliTint.agy }} />
              <span>
                <span className="font-semibold" style={{ fontFamily: 'var(--font-display)' }}>Antigravity</span>
                <span className="block text-[9.5px]" style={{ color: colors.quartzDim }}>design critique — image + styles</span>
              </span>
              <IconSend size={12} stroke={1.5} className="ml-auto" style={{ color: colors.quartzDim }} />
            </button>
            <button
              className="flex w-full cursor-pointer items-center gap-2 rounded-[10px] border px-2.5 py-2 text-left text-[11px]"
              style={{ borderColor: 'var(--color-line-strong)', color: colors.quartz }}
            >
              <span className="size-1.5 rounded-full" style={{ background: cliTint.codex }} />
              <span>
                <span className="font-semibold" style={{ fontFamily: 'var(--font-display)' }}>builder-1</span>
                <span className="block text-[9.5px]" style={{ color: colors.quartzDim }}>edit code — source loc + HTML</span>
              </span>
              <IconSend size={12} stroke={1.5} className="ml-auto" style={{ color: colors.quartzDim }} />
            </button>
          </div>
          <p className="mt-auto pt-2 text-[9.5px] leading-relaxed" style={{ color: colors.quartzDim }}>
            Agents drive this same visible page — you watch every click.
          </p>
        </motion.aside>
      </div>
    </section>
  )
}
