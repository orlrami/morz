import { useEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import {
  IconAdjustments,
  IconLayoutSidebar,
  IconPalette,
  IconPuzzle,
  IconRefresh,
  IconRobot,
  IconRocket,
  IconSearch,
  IconSparkles
} from '@tabler/icons-react'
import { colors } from '@/lib/tokens'
import { springs } from '@/lib/springs'

export type PaletteGroup = 'module' | 'run' | 'settings' | 'spawn' | 'theme' | 'view' | 'workshop'

export interface PaletteAction {
  id: string
  group: PaletteGroup
  label: string
  hint?: string
}

const GROUP_ICON: Record<PaletteGroup, typeof IconRobot> = {
  module: IconPuzzle, // w15/modules-core
  run: IconRobot,
  settings: IconAdjustments,
  spawn: IconRocket,
  theme: IconPalette,
  view: IconLayoutSidebar,
  workshop: IconRefresh
}

interface CommandPaletteProps {
  open: boolean
  actions: PaletteAction[]
  onClose(): void
  onAction(id: string): void
}

function fuzzyMatch(label: string, needle: string): boolean {
  let index = 0
  for (const character of label.toLowerCase()) {
    if (character === needle[index]) index += 1
    if (index === needle.length) return true
  }
  return false
}

/*
 * Ctrl-K palette with typed filters such as `spawn:` and `view:`. Actions are
 * supplied by Shell so unavailable IPC capabilities never render as commands.
 */
export function CommandPalette({ open, actions, onClose, onAction }: CommandPaletteProps): JSX.Element {
  const reduceMotion = useReducedMotion()
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const restoreFocusRef = useRef<HTMLElement | null>(null)

  useEffect(() => {
    if (!open) {
      // a11y (w16 review): hand focus back to whatever opened the palette
      // (titlebar icon or the focused pane), not document.body.
      restoreFocusRef.current?.focus?.()
      restoreFocusRef.current = null
      return
    }
    restoreFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null
    setQuery('')
    setActiveIndex(0)
    requestAnimationFrame(() => inputRef.current?.focus())
  }, [open])

  const results = useMemo(() => {
    const normalized = query.trim().toLowerCase()
    if (!normalized) return actions
    const [prefix, ...rest] = normalized.split(':')
    const scoped = rest.length > 0 ? actions.filter((action) => action.group === prefix) : actions
    const needle = (rest.length > 0 ? rest.join(':') : normalized).trim()
    return needle ? scoped.filter((action) => fuzzyMatch(action.label, needle)) : scoped
  }, [actions, query])

  useEffect(() => {
    setActiveIndex((index) => Math.min(index, Math.max(0, results.length - 1)))
  }, [results.length])

  const runSelected = (): void => {
    const action = results[activeIndex]
    if (!action) return
    onAction(action.id)
    onClose()
  }

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="absolute inset-0 z-50 flex items-start justify-center pt-[28vh]"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1, transition: { duration: reduceMotion ? 0 : 0.12 } }}
          exit={{ opacity: 0, transition: { duration: reduceMotion ? 0 : 0.12 } }}
          style={{ background: 'rgba(20,18,12,0.45)' }}
          onClick={onClose}
        >
          <motion.div
            role="dialog"
            aria-label="Command palette"
            initial={{ opacity: 0, y: -16, scale: 0.98 }}
            animate={{
              opacity: 1,
              y: 0,
              scale: 1,
              transition: reduceMotion ? { duration: 0 } : springs.float
            }}
            exit={{ opacity: 0, y: -10, scale: 0.98, transition: { duration: reduceMotion ? 0 : 0.12 } }}
            className="w-[560px] overflow-hidden rounded-2xl border shadow-2xl"
            style={{ background: colors.panel, borderColor: 'var(--color-line-strong)' }}
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex items-center gap-2.5 border-b px-4 py-3" style={{ borderColor: 'var(--color-line)' }}>
              <IconSearch size={16} stroke={1.5} style={{ color: colors.quartzDim }} />
              <input
                ref={inputRef}
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value)
                  setActiveIndex(0)
                }}
                onKeyDown={(event) => {
                  // w12/voice-input: do not run a command while IME composition confirms text.
                  if (event.nativeEvent.isComposing) return
                  if (event.key === 'Escape') onClose()
                  if (event.key === 'ArrowDown') {
                    event.preventDefault()
                    setActiveIndex((index) => results.length === 0 ? 0 : (index + 1) % results.length)
                  }
                  if (event.key === 'ArrowUp') {
                    event.preventDefault()
                    setActiveIndex((index) => results.length === 0 ? 0 : (index - 1 + results.length) % results.length)
                  }
                  if (event.key === 'Home') {
                    event.preventDefault()
                    setActiveIndex(0)
                  }
                  if (event.key === 'End') {
                    event.preventDefault()
                    setActiveIndex(Math.max(0, results.length - 1))
                  }
                  if (event.key === 'Enter') {
                    event.preventDefault()
                    runSelected()
                  }
                }}
                placeholder="Type a command — or filter with spawn: view: settings: theme:"
                className="flex-1 bg-transparent text-[13px] outline-none placeholder:text-[rgba(238,230,217,0.35)]"
                style={{ color: colors.quartz }}
                aria-controls="command-palette-results"
                aria-activedescendant={results[activeIndex] ? `palette-action-${results[activeIndex].id}` : undefined}
              />
              <kbd
                className="rounded border px-1.5 py-0.5 text-[9.5px]"
                style={{ borderColor: 'var(--color-line-strong)', color: colors.quartzDim }}
              >
                Esc
              </kbd>
            </div>

            <ul id="command-palette-results" className="max-h-[320px] overflow-y-auto p-1.5">
              {results.length === 0 && (
                <li className="px-3 py-6 text-center text-xs" style={{ color: colors.quartzDim }}>
                  No matching commands. Clear the filter to see everything.
                </li>
              )}
              {results.map((action, index) => {
                const Icon = GROUP_ICON[action.group] ?? IconSparkles
                const active = index === activeIndex
                // w16/polish-motion — no per-row stagger: long lists pushed the
                // animation tail past the 250ms budget. The sheet moves, rows don't.
                return (
                  <li key={action.id}>
                    <button
                      id={`palette-action-${action.id}`}
                      type="button"
                      onMouseEnter={() => setActiveIndex(index)}
                      onClick={() => {
                        onAction(action.id)
                        onClose()
                      }}
                      className="flex w-full cursor-pointer items-center gap-2.5 rounded-[10px] px-2.5 py-2 text-left text-xs transition-colors focus-visible:outline focus-visible:outline-2"
                      style={{
                        color: colors.quartz,
                        background: active ? colors.card : 'transparent',
                        outlineColor: active ? colors.bronze : undefined
                      }}
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
                  </li>
                )
              })}
            </ul>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
