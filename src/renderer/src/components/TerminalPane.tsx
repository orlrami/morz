import { motion } from 'framer-motion'
import { IconCheck, IconFolder, IconClockHour4 } from '@tabler/icons-react'
import type { MockAgent, MockBlock } from '@/lib/mock'
import { colors, statusColor } from '@/lib/tokens'
import { staggerContainer, staggerItem } from '@/lib/springs'

interface TerminalPaneProps {
  agent: MockAgent
  blocks: MockBlock[]
  /** Live tail under the blocks: what the agent is doing right now. */
  tail?: 'cursor' | 'approval'
}

/*
 * Terminal pane with command blocks — the signature surface.
 * Each command + output + exit + cwd + time is one addressable block.
 * xterm.js replaces the mock stream in Phase 1; the block chrome stays.
 */
export function TerminalPane({ agent, blocks, tail }: TerminalPaneProps): JSX.Element {
  const blocked = agent.status === 'blocked'

  return (
    <section
      className="relative flex min-w-0 flex-1 flex-col overflow-hidden"
      style={{ background: colors.page }}
      aria-label={`Terminal — ${agent.name}`}
    >
      {blocked && (
        <motion.div
          className="pointer-events-none absolute inset-0 z-10 rounded-none border-[1.5px]"
          style={{ borderColor: statusColor.blocked }}
          animate={{ opacity: [0.85, 0.35, 0.85] }}
          transition={{ duration: 1.8, repeat: Infinity, ease: 'easeInOut' }}
          aria-hidden
        />
      )}

      {/* pane header */}
      <div
        className="flex shrink-0 items-center gap-2 border-b px-3 py-2"
        style={{ background: colors.panel, borderColor: 'var(--color-line)' }}
      >
        <span className="size-2 rounded-full" style={{ background: statusColor[agent.status] }} />
        <span className="text-xs font-semibold" style={{ fontFamily: 'var(--font-display)' }}>
          {agent.name}
        </span>
        <span
          className="rounded-full px-2 py-px text-[9.5px] font-semibold"
          style={{
            background: `${statusColor[agent.status]}26`,
            color: statusColor[agent.status]
          }}
        >
          {blocked ? 'blocked · needs you' : agent.status}
        </span>
        <span className="ml-auto flex items-center gap-1 font-mono text-[10px]" style={{ color: colors.quartzDim }}>
          <IconFolder size={11} stroke={1.5} />
          {agent.worktree}
        </span>
      </div>

      {/* command blocks */}
      <motion.div
        variants={staggerContainer}
        initial="hidden"
        animate="show"
        className="flex-1 space-y-2.5 overflow-y-auto p-3 font-mono text-[12px] leading-relaxed"
      >
        {blocks.map((block) => (
          <motion.article
            key={block.id}
            variants={staggerItem}
            className="overflow-hidden rounded-[7px] border"
            style={{ borderColor: 'var(--color-line)' }}
          >
            <header
              className="flex items-center gap-2 px-2.5 py-1.5"
              style={{ background: colors.panel }}
            >
              <IconCheck size={13} stroke={2} style={{ color: block.exit === 0 ? colors.done : colors.error }} />
              <span className="truncate" style={{ color: colors.quartz }}>
                {block.cmd}
              </span>
              <span
                className="ml-auto flex shrink-0 items-center gap-1 text-[10px]"
                style={{ color: colors.quartzDim }}
              >
                <IconClockHour4 size={10} stroke={1.5} />
                {block.time}
              </span>
            </header>
            <div className="px-2.5 py-1.5" style={{ color: colors.quartzDim }}>
              {block.output.map((line, i) => (
                <p key={i} className="whitespace-pre-wrap">
                  {line.map((seg, j) => {
                    if (seg.kind === 'add') return <span key={j} style={{ color: colors.done }}>{seg.text}</span>
                    if (seg.kind === 'del') return <span key={j} style={{ color: colors.error }}>{seg.text}</span>
                    if (seg.kind === 'path')
                      return (
                        <button
                          key={j}
                          className="cursor-pointer underline decoration-dotted underline-offset-2 hover:brightness-125"
                          style={{ color: colors.bronzeHot }}
                          title="Ctrl+click to open in side preview"
                        >
                          {seg.text}
                        </button>
                      )
                    return <span key={j}>{seg.text}</span>
                  })}
                </p>
              ))}
            </div>
          </motion.article>
        ))}

        {tail === 'cursor' && (
          <motion.p variants={staggerItem} style={{ color: colors.quartzDim }}>
            {agent.activity.toLowerCase()}
            <motion.span
              className="ml-1 inline-block h-3.5 w-[7px] align-[-2px]"
              style={{ background: colors.bronzeHot }}
              animate={{ opacity: [1, 0, 1] }}
              transition={{ duration: 1.1, repeat: Infinity, ease: 'linear' }}
              aria-hidden
            />
          </motion.p>
        )}

        {tail === 'approval' && (
          <motion.div variants={staggerItem} style={{ color: statusColor.blocked }}>
            <p>
              ▲ Approve write to prod migration{' '}
              <button
                className="cursor-pointer underline decoration-dotted underline-offset-2"
                style={{ color: colors.bronzeHot }}
              >
                src/db/migrate.ts
              </button>
              ?
            </p>
            <p className="mt-0.5" style={{ color: colors.quartzDim }}>
              waiting for your approval …
            </p>
            <div className="mt-2 flex gap-2 font-sans">
              <button
                className="cursor-pointer rounded-[10px] px-3.5 py-1.5 text-xs font-semibold"
                style={{
                  background: `linear-gradient(180deg, ${colors.bronzeHot}, ${colors.bronze})`,
                  color: '#241c0a',
                  fontFamily: 'var(--font-display)'
                }}
              >
                Approve
              </button>
              <button
                className="cursor-pointer rounded-[10px] border px-3.5 py-1.5 text-xs font-semibold"
                style={{
                  borderColor: 'rgba(239,68,68,0.4)',
                  color: colors.error,
                  fontFamily: 'var(--font-display)'
                }}
              >
                Deny
              </button>
            </div>
          </motion.div>
        )}
      </motion.div>
    </section>
  )
}
