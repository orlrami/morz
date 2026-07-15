import { useEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { IconSearch, IconRobot, IconRocket, IconSparkles, IconLayoutSidebar } from '@tabler/icons-react'
import { paletteActions, type PaletteAction } from '@/lib/mock'
import { colors } from '@/lib/tokens'
import { springs } from '@/lib/springs'

const GROUP_ICON: Record<string, typeof IconRobot> = {
  agent: IconRobot,
  spawn: IconRocket,
  skill: IconSparkles,
  view: IconLayoutSidebar
}

interface CommandPaletteProps {
  open: boolean
  onClose: () => void
  /** Live actions prepended to the mock list (wave-2 seam: Shell's Claude lane). */
  extraActions?: PaletteAction[]
  onAction?: (id: string) => void
}

/*
 * cmd-K palette with typed filters: `agent:` `spawn:` `skill:` `view:`.
 * Subsequence fuzzy match; spring-down entrance over a blurred backdrop.
 */
export function CommandPalette({ open, onClose, extraActions, onAction }: CommandPaletteProps): JSX.Element {
  const [query, setQuery] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (open) {
      setQuery('')
      requestAnimationFrame(() => inputRef.current?.focus())
    }
  }, [open])

  const results = useMemo(() => {
    const all = [...(extraActions ?? []), ...paletteActions]
    const q = query.trim().toLowerCase()
    if (!q) return all
    const [prefix, ...rest] = q.split(':')
    const scoped = rest.length > 0 ? all.filter((a) => a.group === prefix) : all
    const needle = (rest.length > 0 ? rest.join(':') : q).trim()
    if (!needle) return scoped
    return scoped.filter((a) => {
      // subsequence fuzzy match
      let i = 0
      for (const ch of a.label.toLowerCase()) {
        if (ch === needle[i]) i++
        if (i === needle.length) return true
      }
      return false
    })
  }, [query, extraActions])

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="absolute inset-0 z-50 flex items-start justify-center pt-[12vh]"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0, transition: { duration: 0.12 } }}
          style={{ background: 'rgba(20,18,12,0.55)', backdropFilter: 'blur(6px)' }}
          onClick={onClose}
        >
          <motion.div
            role="dialog"
            aria-label="Command palette"
            initial={{ opacity: 0, y: -28, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1, transition: springs.float }}
            exit={{ opacity: 0, y: -16, scale: 0.98, transition: { duration: 0.12 } }}
            className="w-[560px] overflow-hidden rounded-2xl border shadow-2xl"
            style={{ background: colors.panel, borderColor: 'var(--color-line-strong)' }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-2.5 border-b px-4 py-3" style={{ borderColor: 'var(--color-line)' }}>
              <IconSearch size={16} stroke={1.5} style={{ color: colors.quartzDim }} />
              <input
                ref={inputRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => e.key === 'Escape' && onClose()}
                placeholder="Type a command — or filter with agent: spawn: skill: view:"
                className="flex-1 bg-transparent text-[13px] outline-none placeholder:text-[rgba(238,230,217,0.35)]"
                style={{ color: colors.quartz }}
              />
              <kbd
                className="rounded border px-1.5 py-0.5 text-[9.5px]"
                style={{ borderColor: 'var(--color-line-strong)', color: colors.quartzDim }}
              >
                Esc
              </kbd>
            </div>

            <ul className="max-h-[320px] overflow-y-auto p-1.5">
              {results.length === 0 && (
                <li className="px-3 py-6 text-center text-xs" style={{ color: colors.quartzDim }}>
                  No matching commands. Clear the filter to see everything.
                </li>
              )}
              {results.map((action, i) => {
                const Icon = GROUP_ICON[action.group] ?? IconSparkles
                return (
                  <motion.li
                    key={action.id}
                    initial={{ opacity: 0, y: 4 }}
                    animate={{ opacity: 1, y: 0, transition: { ...springs.snappy, delay: i * 0.02 } }}
                  >
                    <button
                      onClick={() => {
                        onAction?.(action.id)
                        onClose()
                      }}
                      className="flex w-full cursor-pointer items-center gap-2.5 rounded-[10px] px-2.5 py-2 text-left text-xs transition-colors"
                      style={{ color: colors.quartz }}
                      onMouseEnter={(e) => (e.currentTarget.style.background = colors.card)}
                      onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                    >
                      <span
                        className="flex size-6 items-center justify-center rounded-md border"
                        style={{ borderColor: 'var(--color-line)', color: colors.bronzeHot }}
                      >
                        <Icon size={13} stroke={1.5} />
                      </span>
                      {action.label}
                      {action.hint && (
                        <span
                          className="ml-auto rounded-full px-2 py-px text-[9px] font-semibold"
                          style={{ background: 'rgba(228,169,79,0.16)', color: '#E4A94F' }}
                        >
                          {action.hint}
                        </span>
                      )}
                    </button>
                  </motion.li>
                )
              })}
            </ul>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
