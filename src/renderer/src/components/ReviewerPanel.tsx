import { useState } from 'react'
import { motion } from 'framer-motion'
import { IconShieldCheck, IconWand, IconSend } from '@tabler/icons-react'
import { findings, type Finding } from '@/lib/mock'
import { colors } from '@/lib/tokens'
import { staggerContainer, staggerItem, springs } from '@/lib/springs'

const SEVERITY: Record<Finding['severity'], { color: string; label: string }> = {
  high: { color: colors.error, label: 'high' },
  medium: { color: colors.warning, label: 'medium' },
  low: { color: colors.working, label: 'low' }
}

/*
 * Reviewer surface — cross-model by default: the refuting brain is never the
 * author's. Each finding offers the two-tier fix UX: apply deterministic fixes
 * in place, hand complex ones to an agent with full context.
 */
export function ReviewerPanel(): JSX.Element {
  const [selected, setSelected] = useState(findings[0].id)
  const active = findings.find((f) => f.id === selected)!

  return (
    <section className="flex min-w-0 flex-1" style={{ background: colors.page }} aria-label="Review">
      {/* findings list */}
      <div className="flex w-[300px] shrink-0 flex-col border-r" style={{ borderColor: 'var(--color-line)' }}>
        <div
          className="flex items-center gap-2 border-b px-3 py-2"
          style={{ borderColor: 'var(--color-line)' }}
        >
          <IconShieldCheck size={14} stroke={1.5} style={{ color: colors.bronzeHot }} />
          <span className="text-xs font-semibold" style={{ fontFamily: 'var(--font-display)' }}>
            Review — working tree
          </span>
          <span className="ml-auto text-[10px]" style={{ color: colors.quartzDim }}>
            3 findings
          </span>
        </div>
        <motion.ul variants={staggerContainer} initial="hidden" animate="show" className="flex-1 overflow-y-auto p-2">
          {findings.map((f) => (
            <motion.li key={f.id} variants={staggerItem}>
              <button
                onClick={() => setSelected(f.id)}
                className="w-full cursor-pointer rounded-[10px] border p-2.5 text-left transition-colors"
                style={{
                  borderColor: selected === f.id ? 'rgba(203,162,90,0.45)' : 'transparent',
                  background: selected === f.id ? colors.card : 'transparent',
                  marginBottom: 4
                }}
              >
                <div className="flex items-center gap-2">
                  <span
                    className="rounded-full px-1.5 py-px text-[8.5px] font-bold uppercase"
                    style={{ background: `${SEVERITY[f.severity].color}22`, color: SEVERITY[f.severity].color }}
                  >
                    {SEVERITY[f.severity].label}
                  </span>
                  <span className="truncate font-mono text-[10px]" style={{ color: colors.quartzDim }}>
                    {f.file}:{f.line}
                  </span>
                </div>
                <p className="mt-1 text-xs" style={{ color: colors.quartz }}>
                  {f.title}
                </p>
              </button>
            </motion.li>
          ))}
        </motion.ul>
        <p className="border-t px-3 py-2 text-[10px]" style={{ borderColor: 'var(--color-line)', color: colors.quartzDim }}>
          Verified before surfacing · reviewer model ≠ author model
        </p>
      </div>

      {/* finding detail */}
      <div className="flex min-w-0 flex-1 flex-col p-4">
        <div className="flex items-center gap-2">
          <span
            className="rounded-full px-2 py-0.5 text-[9.5px] font-bold uppercase"
            style={{
              background: `${SEVERITY[active.severity].color}22`,
              color: SEVERITY[active.severity].color
            }}
          >
            {SEVERITY[active.severity].label}
          </span>
          <h2 className="text-sm font-semibold" style={{ fontFamily: 'var(--font-display)' }}>
            {active.title}
          </h2>
        </div>
        <p className="mt-1 font-mono text-[10.5px]" style={{ color: colors.quartzDim }}>
          {active.file}:{active.line} · refuted by {active.refutedBy}
        </p>

        <div
          className="mt-3 rounded-[10px] border p-3 text-xs leading-relaxed"
          style={{ borderColor: 'var(--color-line)', background: colors.panel, color: colors.quartzDim }}
        >
          {active.detail}
        </div>

        {/* gutter-comment style snippet */}
        <div
          className="mt-3 overflow-hidden rounded-[10px] border font-mono text-[11.5px]"
          style={{ borderColor: 'var(--color-line)' }}
        >
          <div className="px-3 py-1.5" style={{ background: colors.panel, color: colors.quartzDim }}>
            src/api/limiter.ts
          </div>
          <div className="p-3" style={{ color: colors.quartzDim }}>
            <p>
              <span className="mr-3 select-none" style={{ color: colors.quartzDim }}>13</span>
              {'export function createApi(app: Express) {'}
            </p>
            <p style={{ background: `${SEVERITY[active.severity].color}12` }}>
              <span className="mr-3 select-none" style={{ color: SEVERITY[active.severity].color }}>14</span>
              <span style={{ color: colors.quartz }}>const limiter = tokenBucket(60, 60_000)</span>
            </p>
            <p>
              <span className="mr-3 select-none">15</span>
              {'  app.use(limiter)'}
            </p>
          </div>
        </div>

        <div className="mt-4 flex gap-2">
          <motion.button
            whileHover={{ scale: 1.02 }}
            transition={springs.snappy}
            className="flex cursor-pointer items-center gap-1.5 rounded-[10px] px-3.5 py-2 text-xs font-semibold"
            style={{
              background: `linear-gradient(180deg, ${colors.bronzeHot}, ${colors.bronze})`,
              color: '#241c0a',
              fontFamily: 'var(--font-display)'
            }}
          >
            <IconWand size={13} stroke={2} />
            Apply fix
          </motion.button>
          <button
            className="flex cursor-pointer items-center gap-1.5 rounded-[10px] border px-3.5 py-2 text-xs font-medium"
            style={{ borderColor: 'var(--color-line-strong)', color: colors.quartzDim, fontFamily: 'var(--font-display)' }}
            title="Send the finding + context to an agent as a task"
          >
            <IconSend size={13} stroke={1.5} />
            Send to agent
          </button>
        </div>
      </div>
    </section>
  )
}
