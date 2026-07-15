import { useState } from 'react'
import { motion } from 'framer-motion'
import { IconGauge, IconPalette, IconAdjustments, IconUpload } from '@tabler/icons-react'
import { cliUsages, cliTint, cliLabel } from '@/lib/mock'
import { colors } from '@/lib/tokens'
import { springs } from '@/lib/springs'
import { themes, useThemeStore } from '@/lib/themes'
import { ObsidianSettings } from './ObsidianSettings'
import { AssistantSettings } from './AssistantSettings' // w6/assistant

type Tab = 'limits' | 'appearance' | 'control'

const TABS: { id: Tab; label: string; icon: typeof IconGauge }[] = [
  { id: 'limits', label: 'Limits & usage', icon: IconGauge },
  { id: 'appearance', label: 'Appearance', icon: IconPalette },
  { id: 'control', label: 'Control', icon: IconAdjustments }
]

/* Settings: per-CLI membership limits, theme importer, and the control defaults. */
export function SettingsPanel(): JSX.Element {
  const [tab, setTab] = useState<Tab>('limits')
  const { themeId, setTheme } = useThemeStore()

  return (
    <section className="flex min-w-0 flex-1" style={{ background: colors.page }} aria-label="Settings">
      <nav className="w-[200px] shrink-0 border-r p-3" style={{ borderColor: 'var(--color-line)' }}>
        <p className="px-2 pb-2 text-[10px] uppercase tracking-wider" style={{ color: colors.quartzDim }}>
          Settings
        </p>
        {TABS.map((t) => {
          const active = tab === t.id
          const Icon = t.icon
          return (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className="relative mb-0.5 flex w-full cursor-pointer items-center gap-2 rounded-lg px-2.5 py-2 text-left text-xs"
              style={{ color: active ? colors.quartz : colors.quartzDim, fontFamily: 'var(--font-display)' }}
            >
              {active && (
                <motion.span
                  layoutId="settings-tab"
                  transition={springs.layout}
                  className="absolute inset-0 rounded-lg border"
                  style={{ background: colors.card, borderColor: 'var(--color-line-strong)' }}
                />
              )}
              <span className="relative flex items-center gap-2">
                <Icon size={14} stroke={1.5} />
                {t.label}
              </span>
            </button>
          )
        })}
      </nav>

      <div className="min-w-0 flex-1 overflow-y-auto p-5">
        {tab === 'limits' && (
          <div className="max-w-[560px]">
            <h2 className="text-sm font-bold" style={{ fontFamily: 'var(--font-display)' }}>
              Limits &amp; usage
            </h2>
            <p className="mt-1 text-xs leading-relaxed" style={{ color: colors.quartzDim }}>
              Morz tracks each CLI&apos;s rolling window from its membership. The status bar warns before an agent
              hits a wall; the orchestrator routes around exhausted CLIs.
            </p>
            <div className="mt-4 space-y-2.5">
              {cliUsages.map((u) => (
                <div key={u.cli} className="rounded-xl border p-3" style={{ background: colors.panel, borderColor: 'var(--color-line)' }}>
                  <div className="flex items-center gap-2">
                    <span className="size-2 rounded-full" style={{ background: cliTint[u.cli] }} />
                    <span className="text-xs font-semibold" style={{ fontFamily: 'var(--font-display)' }}>
                      {cliLabel[u.cli]}
                    </span>
                    <span className="rounded-md border px-1.5 py-px text-[9px]" style={{ borderColor: 'var(--color-line-strong)', color: colors.quartzDim }}>
                      {u.plan}
                    </span>
                    <span className="ml-auto text-[10.5px]" style={{ color: colors.quartzDim }}>
                      {u.used}% used · resets in {u.resetIn}
                    </span>
                  </div>
                  <div className="mt-2 h-1.5 overflow-hidden rounded-full" style={{ background: 'rgba(238,230,217,0.10)' }}>
                    <motion.span
                      className="block h-full rounded-full"
                      initial={{ width: 0 }}
                      animate={{ width: `${u.used}%`, transition: { ...springs.layout, delay: 0.1 } }}
                      style={{ background: u.used >= 75 ? colors.blocked ?? '#F59E0B' : cliTint[u.cli] }}
                    />
                  </div>
                  <div className="mt-2 flex items-center gap-2 text-[10px]" style={{ color: colors.quartzDim }}>
                    Pause agents at
                    <span className="rounded-md border px-1.5 py-px font-mono" style={{ borderColor: 'var(--color-line-strong)', color: colors.quartz }}>
                      90%
                    </span>
                    of the window · route overflow to
                    <span className="rounded-md border px-1.5 py-px" style={{ borderColor: 'var(--color-line-strong)', color: colors.quartz }}>
                      next available CLI
                    </span>
                  </div>
                </div>
              ))}
            </div>
            <label className="mt-4 flex cursor-pointer items-center gap-2 text-xs" style={{ color: colors.quartzDim }}>
              <span className="flex h-4 w-7 items-center rounded-full p-0.5" style={{ background: 'rgba(238,230,217,0.15)' }}>
                <span className="size-3 rounded-full" style={{ background: colors.quartzDim }} />
              </span>
              Show token &amp; cost counter in the status bar
            </label>
          </div>
        )}

        {tab === 'appearance' && (
          <div className="max-w-[560px]">
            <h2 className="text-sm font-bold" style={{ fontFamily: 'var(--font-display)' }}>
              Appearance
            </h2>
            <p className="mt-1 text-xs leading-relaxed" style={{ color: colors.quartzDim }}>
              Import any base16, VS Code, or Ghostty theme — terminal and app chrome share one palette.
            </p>
            <div className="mt-4 grid grid-cols-3 gap-2.5">
              {themes.map((t) => {
                const active = themeId === t.id
                return (
                  <button
                    key={t.id}
                    onClick={() => setTheme(t.id)}
                    className="cursor-pointer rounded-xl border p-3 text-left transition-transform hover:scale-[1.02]"
                    style={{
                      background: colors.panel,
                      borderColor: active ? 'rgba(203,162,90,0.55)' : 'var(--color-line)'
                    }}
                  >
                    <span className="flex gap-1">
                      {[t.page, t.quartz, t.bronze].map((c) => (
                        <span key={c} className="size-4 rounded-md border" style={{ background: c, borderColor: 'var(--color-line)' }} />
                      ))}
                    </span>
                    <span className="mt-2 block text-[11px] font-semibold" style={{ fontFamily: 'var(--font-display)' }}>
                      {t.name}
                    </span>
                    <span className="text-[9.5px]" style={{ color: active ? colors.bronzeHot : colors.quartzDim }}>
                      {active ? 'active' : t.note}
                    </span>
                  </button>
                )
              })}
            </div>
            <button
              className="mt-3 flex cursor-pointer items-center gap-2 rounded-[10px] border border-dashed px-3.5 py-2 text-xs"
              style={{ borderColor: 'var(--color-line-strong)', color: colors.quartzDim }}
            >
              <IconUpload size={13} stroke={1.5} />
              Import theme file — base16 / VS Code / Ghostty
            </button>
          </div>
        )}

        {tab === 'control' && (
          <div className="max-w-[560px]">
            <h2 className="text-sm font-bold" style={{ fontFamily: 'var(--font-display)' }}>
              Control
            </h2>
            <p className="mt-1 text-xs leading-relaxed" style={{ color: colors.quartzDim }}>
              Assist, don&apos;t take over. Everything here is opt-in, scoped, and reversible.
            </p>
            <div className="mt-4 space-y-2">
              {[
                { label: 'Default mode for new spaces', value: 'Manual' },
                { label: 'Orchestrator may propose plans', value: 'On — launch always needs approval' },
                { label: 'Auto-answer known CLI prompts (watchdog)', value: 'Off' },
                { label: 'Remote steering from phone', value: 'Off — enable per space' }
              ].map((row) => (
                <div
                  key={row.label}
                  className="flex items-center justify-between rounded-xl border px-3 py-2.5 text-xs"
                  style={{ background: colors.panel, borderColor: 'var(--color-line)' }}
                >
                  <span>{row.label}</span>
                  <span className="rounded-md border px-2 py-0.5 text-[10.5px]" style={{ borderColor: 'var(--color-line-strong)', color: colors.bronzeHot }}>
                    {row.value}
                  </span>
                </div>
              ))}
            </div>
            {/* // w4/obsidian */}<ObsidianSettings />
            {/* w6/assistant */}<AssistantSettings />
          </div>
        )}
      </div>
    </section>
  )
}
