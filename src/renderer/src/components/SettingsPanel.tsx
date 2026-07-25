import { useEffect, useState } from 'react'
import { motion } from 'framer-motion'
import {
  IconGauge,
  IconPalette,
  IconAdjustments,
  IconPlugConnected,
  IconSparkles,
  IconUpload
} from '@tabler/icons-react'
import { colors } from '@/lib/tokens'
import { springs } from '@/lib/springs'
import { themes, useThemeStore } from '@/lib/themes'
import { ObsidianSettings } from './ObsidianSettings'
import { AssistantSettings } from './AssistantSettings' // w6/assistant
import { PulseSettings } from './PulseSettings' // w6/pulse
import { MemorySettings } from './MemorySettings'
import { RoutingSettings } from './RoutingSettings' // w8/routing
import { VoiceSettings } from './VoiceSettings'
import { UpdateSettings } from './UpdateSettings'
import { ConnectionsSettings } from './ConnectionsSettings' // w11/connections
import { useConnectionsStore } from '@/store/connectionsStore'
import { useModulesStore } from '@/store/modulesStore' // w15/modules-core
import {
  RUN_HISTORY_POLICIES,
  useRunsStore,
  type RunHistoryPolicy
} from '@/store/runsStore'
import { ReportSettings } from './ReportSettings' // w11/report-engine

export type SettingsTab = 'limits' | 'connections' | 'appearance' | 'control' | 'reports'

const TABS: { id: SettingsTab; label: string; icon: typeof IconGauge }[] = [
  { id: 'limits', label: 'Limits & usage', icon: IconGauge },
  { id: 'connections', label: 'Connections', icon: IconPlugConnected },
  { id: 'appearance', label: 'Appearance', icon: IconPalette },
  { id: 'control', label: 'Control', icon: IconAdjustments },
  { id: 'reports', label: 'AI reports', icon: IconSparkles }
]

/* Settings: live usage availability, theme importer, and the control defaults. */
export function SettingsPanel({ initialTab = 'limits' }: { initialTab?: SettingsTab }): JSX.Element {
  const [tab, setTab] = useState<SettingsTab>(initialTab)
  const { themeId, setTheme } = useThemeStore()
  const { connections, loading: connectionsLoading, start: startConnections } = useConnectionsStore()
  const modulesEnabled = useModulesStore((state) => state.enabled) // w15/modules-core
  const historyPolicy = useRunsStore((state) => state.historyPolicy)
  const setHistoryPolicy = useRunsStore((state) => state.setHistoryPolicy)
  const usageConnections = connections.filter((connection) => connection.usage !== null)

  useEffect(() => startConnections(), [startConnections])

  return (
    <section
      className="flex min-h-0 min-w-0 flex-1 overflow-hidden"
      style={{ background: colors.page }}
      aria-label="Settings"
    >
      <nav
        className="w-[200px] shrink-0 border-r p-3"
        style={{ borderColor: 'var(--color-line)' }}
      >
        <p className="px-2 pb-2 text-[10px] uppercase tracking-wider" style={{ color: colors.quartzDim }}>
          Settings
        </p>
        {TABS.map((t) => {
          const active = tab === t.id
          const Icon = t.icon
          return (
            <button
              key={t.id}
              type="button"
              aria-current={active ? 'page' : undefined}
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

      <div className="min-h-0 min-w-0 flex-1 overflow-y-auto p-5">
        {tab === 'limits' && (
          <div className="mx-auto w-full max-w-[560px]">
            <h2 className="text-sm font-bold" style={{ fontFamily: 'var(--font-display)' }}>
              Limits &amp; usage
            </h2>
            <p className="mt-1 text-xs leading-relaxed" style={{ color: colors.quartzDim }}>
              Live session and run totals appear in the status bar when adapters report them.
            </p>
            {usageConnections.length > 0 ? (
              <div className="mt-4 space-y-2.5">
                {usageConnections.map((connection) => {
                  const usedPct = connection.usage?.usedPct ?? null
                  const clampedPct = usedPct === null ? null : Math.max(0, Math.min(100, usedPct))
                  const reset = connection.usage?.resetsAt
                    ? new Date(connection.usage.resetsAt).toLocaleString()
                    : null
                  return (
                    <article
                      key={connection.id}
                      className="rounded-xl border p-3"
                      style={{ background: colors.panel, borderColor: 'var(--color-line)' }}
                      data-testid={`usage-${connection.id}`}
                    >
                      <div className="flex items-center justify-between gap-3 text-xs">
                        <span className="font-semibold" style={{ fontFamily: 'var(--font-display)' }}>
                          {connection.label}
                        </span>
                        <span className="font-mono text-[10px]" style={{ color: colors.quartzDim }}>
                          {clampedPct === null ? 'Usage percentage unavailable' : `${clampedPct}% used`}
                        </span>
                      </div>
                      {clampedPct !== null && (
                        <div
                          className="mt-2 h-1.5 overflow-hidden rounded-full"
                          style={{ background: 'rgba(0,0,0,0.24)' }}
                          role="progressbar"
                          aria-label={`${connection.label} usage`}
                          aria-valuemin={0}
                          aria-valuemax={100}
                          aria-valuenow={clampedPct}
                        >
                          <div
                            className="h-full rounded-full"
                            style={{ width: `${clampedPct}%`, background: colors.bronze }}
                          />
                        </div>
                      )}
                      <p className="mt-2 text-[9.5px]" style={{ color: colors.quartzDim }}>
                        {reset ? `Resets ${reset}` : 'Reset time not reported'}
                      </p>
                    </article>
                  )
                })}
              </div>
            ) : (
              <div
                className="mt-4 rounded-xl border border-dashed p-4"
                style={{ background: colors.panel, borderColor: 'var(--color-line-strong)' }}
                role="status"
              >
                <p className="text-xs font-semibold" style={{ fontFamily: 'var(--font-display)' }}>
                  {connectionsLoading ? 'Checking CLI usage…' : 'No CLI usage data is available'}
                </p>
                <p className="mt-1 text-[10.5px] leading-relaxed" style={{ color: colors.quartzDim }}>
                  Morz shows a rolling usage bar only when an installed CLI exposes a real percentage locally.
                </p>
              </div>
            )}
          </div>
        )}

        {tab === 'connections' && <ConnectionsSettings />}

        {tab === 'appearance' && (
          <div className="mx-auto w-full max-w-[560px]">
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
                    type="button"
                    onClick={() => {
                      if (!active) setTheme(t.id)
                    }}
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
          <div className="mx-auto w-full max-w-[560px]">
            <h2 className="text-sm font-bold" style={{ fontFamily: 'var(--font-display)' }}>
              Control
            </h2>
            <p className="mt-1 text-xs leading-relaxed" style={{ color: colors.quartzDim }}>
              Assist, don&apos;t take over. Everything here is opt-in, scoped, and reversible.
            </p>
            <div className="mt-4 space-y-2">
              <label
                className="flex items-center justify-between gap-3 rounded-xl border px-3 py-2.5 text-xs"
                style={{ background: colors.panel, borderColor: 'var(--color-line)' }}
              >
                <span>
                  <span className="block">Run history</span>
                  <span className="mt-0.5 block text-[9.5px]" style={{ color: colors.quartzDim }}>
                    Applies per space on the next app launch. Clearing keeps worktrees and branches.
                  </span>
                </span>
                <select
                  aria-label="Run history policy setting"
                  value={historyPolicy}
                  onChange={(event) =>
                    setHistoryPolicy(event.target.value as RunHistoryPolicy)
                  }
                  className="shrink-0 rounded-md border bg-transparent px-2 py-1 text-[10.5px] outline-none focus-visible:ring-1"
                  style={{ borderColor: 'var(--color-line-strong)', color: colors.bronzeHot }}
                >
                  {RUN_HISTORY_POLICIES.map((policy) => (
                    <option key={policy.value} value={policy.value}>
                      {policy.label}
                    </option>
                  ))}
                </select>
              </label>
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
            {/* // w4/obsidian — w15/modules-core: mounts only with the module on */}
            {modulesEnabled.obsidian && <ObsidianSettings />}
            {/* w6/assistant */}<AssistantSettings />
            {/* w6/pulse — w15/modules-core */}
            {modulesEnabled.pulse && <PulseSettings />}
            <MemorySettings /> {/* // w8/memory-core */}
            {/* w8/routing */}<RoutingSettings />
            {/* // w8/voice — w15/modules-core */}
            {modulesEnabled.voice && <VoiceSettings />}
            {/* // w9/installer */}<UpdateSettings />
          </div>
        )}

        {/* // w11/report-engine */}
        {tab === 'reports' && <ReportSettings />}
      </div>
    </section>
  )
}
