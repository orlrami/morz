import { useEffect } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { IconLock, IconX } from '@tabler/icons-react'
import { MODULES, type ModuleId } from '@shared/modules'
import { colors } from '@/lib/tokens'
import { springs } from '@/lib/springs'
import { useModeStore } from '@/store/modeStore'
import { useModulesStore } from '@/store/modulesStore'

/** Always-on surfaces â€” shown locked so "core vs module" stays legible. */
const CORE_SURFACES = ['Terminals', 'Explorer', 'IDE', 'Spaces', 'Settings']

const MODULE_HINT: Record<ModuleId, string> = {
  sessions: 'Per-project session history and resume',
  orchestration: 'Orchestrator, waves, and dispatched runs',
  commit: 'Staging surface with AI commit messages',
  review: 'Cross-model reviewer',
  browser: 'Embedded browser with element pick',
  organizer: 'Repo audit and organize proposals',
  workshop: 'Skills, MCP servers, plugins, models',
  pulse: 'Scheduled daily brief',
  voice: 'Push-to-talk dictation (local Whisper)',
  obsidian: 'Vault read/search and ADR write',
  context: 'CLAUDE.md / AGENTS.md / STATUS.md across your spaces'
}

interface ModuleDrawerProps {
  open: boolean
  onClose(): void
}

/*
 * Module drawer (w15/modules-core) â€” the one place modules are switched on and
 * off. Reachable from the shell's `+` affordance and the Ctrl-K
 * `module: enable/disable <name>` actions.
 */
export function ModuleDrawer({ open, onClose }: ModuleDrawerProps): JSX.Element {
  const enabled = useModulesStore((state) => state.enabled)
  const setEnabled = useModulesStore((state) => state.setEnabled)
  const mode = useModeStore((state) => state.mode)

  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose, open])

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="absolute inset-0 z-40 flex justify-end"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0, transition: { duration: 0.12 } }}
          style={{ background: 'rgba(20,18,12,0.45)' }}
          onClick={onClose}
        >
          <motion.aside
            role="dialog"
            aria-label="Modules"
            data-testid="module-drawer"
            initial={{ x: 40, opacity: 0 }}
            animate={{ x: 0, opacity: 1, transition: springs.float }}
            exit={{ x: 24, opacity: 0, transition: { duration: 0.12 } }}
            className="flex h-full w-[320px] flex-col border-l shadow-2xl"
            style={{ background: colors.panel, borderColor: 'var(--color-line-strong)' }}
            onClick={(event) => event.stopPropagation()}
          >
            <div
              className="flex shrink-0 items-center gap-2 border-b px-4 py-3"
              style={{ borderColor: 'var(--color-line)' }}
            >
              <strong className="text-sm" style={{ fontFamily: 'var(--font-display)' }}>
                Modules
              </strong>
              <span className="text-[10px]" style={{ color: colors.quartzDim }}>
                your Morz, your surfaces
              </span>
              <button
                type="button"
                onClick={onClose}
                aria-label="Close module drawer"
                className="ml-auto cursor-pointer rounded p-1 hover:bg-[#37332B]"
                style={{ color: colors.quartzDim }}
              >
                <IconX size={13} stroke={1.5} />
              </button>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto p-4">
              <ModuleSettingsList />
            </div>
          </motion.aside>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

/* Shared registry list — the drawer and Settings > Modules render the same rows. */
export function ModuleSettingsList(): JSX.Element {
  const enabled = useModulesStore((state) => state.enabled)
  const setEnabled = useModulesStore((state) => state.setEnabled)
  const mode = useModeStore((state) => state.mode)
  return (
    <>
              <p
                className="pb-2 text-[10px] uppercase tracking-wider"
                style={{ color: colors.quartzDim }}
              >
                Core â€” always on
              </p>
              <div className="flex flex-wrap gap-1.5">
                {CORE_SURFACES.map((label) => (
                  <span
                    key={label}
                    aria-disabled="true"
                    className="flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px]"
                    style={{
                      background: colors.card,
                      borderColor: 'var(--color-line)',
                      color: colors.quartzDim
                    }}
                  >
                    <IconLock size={9} stroke={1.7} />
                    {label}
                  </span>
                ))}
              </div>

              <p
                className="pb-2 pt-4 text-[10px] uppercase tracking-wider"
                style={{ color: colors.quartzDim }}
              >
                Modules
              </p>
              <div className="space-y-1.5">
                {MODULES.map((def) => {
                  const on = enabled[def.id]
                  const interlocked = def.id === 'orchestration' && on && mode === 'orchestrated'
                  return (
                    <div
                      key={def.id}
                      className="flex items-center gap-2.5 rounded-xl border px-3 py-2"
                      style={{ background: colors.card, borderColor: 'var(--color-line)' }}
                    >
                      <div className="min-w-0 flex-1">
                        <span
                          className="block text-xs font-semibold"
                          style={{ fontFamily: 'var(--font-display)', color: colors.quartz }}
                        >
                          {def.label}
                        </span>
                        <span
                          className="block truncate text-[10px] leading-snug"
                          style={{ color: colors.quartzDim }}
                        >
                          {interlocked
                            ? 'Turning this off drops the dial to Manual'
                            : MODULE_HINT[def.id]}
                        </span>
                      </div>
                      <button
                        type="button"
                        role="switch"
                        aria-checked={on}
                        aria-label={`${def.label} module`}
                        data-testid={`module-toggle-${def.id}`}
                        onClick={() => void setEnabled(def.id, !on)}
                        className="relative h-4 w-8 shrink-0 cursor-pointer rounded-full transition-colors"
                        style={{
                          background: on ? colors.bronze : 'rgba(238,230,217,0.14)'
                        }}
                      >
                        <span
                          className="absolute top-0.5 size-3 rounded-full transition-[left]"
                          style={{
                            left: on ? 18 : 2,
                            background: on ? '#241c0a' : colors.quartzDim
                          }}
                        />
                      </button>
                    </div>
                  )
                })}
              </div>
    </>
  )
}
