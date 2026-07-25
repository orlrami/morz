import { useEffect, useMemo, useState } from 'react'
import { motion } from 'framer-motion'
import {
  IconAdjustments,
  IconGauge,
  IconPalette,
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
import { ConnectionsModelsSettings } from './ConnectionsModelsSettings' // w15/model-choice
import { IntegrationsSettings } from './IntegrationsSettings' // w15/integration-slots
import { ModuleSettingsList } from './ModuleDrawer' // w15/modules-core
import { useOnboardingStore } from '@/store/onboardingStore' // w15/onboarding
import {
  RUN_HISTORY_POLICIES,
  useRunsStore,
  type RunHistoryPolicy
} from '@/store/runsStore'
import { ReportSettings } from './ReportSettings' // w11/report-engine

type IconComponent = typeof IconGauge

type SettingsSectionId =
  | 'modules'
  | 'connections-models'
  | 'integrations'
  | 'autonomy-permissions'
  | 'planner'
  | 'memory'
  | 'routing'
  | 'limits'
  | 'sessions-history'
  | 'notifications'
  | 'appearance'
  | 'about'

type LegacySettingsTab = 'connections' | 'control' | 'reports'

export type SettingsTab = SettingsSectionId | LegacySettingsTab

interface SettingsSection {
  id: SettingsSectionId
  label: string
  icon: IconComponent
}

const NAV_GROUPS: { label: string; sections: SettingsSection[] }[] = [
  {
    label: 'Workspace',
    sections: [
      { id: 'modules', label: 'Modules', icon: IconAdjustments },
      { id: 'connections-models', label: 'Connections & Models', icon: IconPlugConnected },
      { id: 'integrations', label: 'Integrations', icon: IconPlugConnected }
    ]
  },
  {
    label: 'Agents',
    sections: [
      { id: 'autonomy-permissions', label: 'Autonomy & Permissions', icon: IconAdjustments },
      { id: 'planner', label: 'Planner', icon: IconSparkles },
      { id: 'memory', label: 'Memory', icon: IconSparkles },
      { id: 'routing', label: 'Routing', icon: IconAdjustments }
    ]
  },
  {
    label: 'App',
    sections: [
      { id: 'limits', label: 'Limits & Usage', icon: IconGauge },
      { id: 'sessions-history', label: 'Sessions & History', icon: IconGauge },
      { id: 'notifications', label: 'Notifications', icon: IconSparkles },
      { id: 'appearance', label: 'Appearance', icon: IconPalette },
      { id: 'about', label: 'About', icon: IconSparkles }
    ]
  }
]

const SECTION_BY_ID = NAV_GROUPS.flatMap((group) => group.sections).reduce<Record<SettingsSectionId, SettingsSection>>(
  (acc, section) => {
    acc[section.id] = section
    return acc
  },
  {} as Record<SettingsSectionId, SettingsSection>
)

function normalizeSettingsTab(tab: SettingsTab): SettingsSectionId {
  if (tab === 'connections') return 'connections-models'
  if (tab === 'control') return 'autonomy-permissions'
  if (tab === 'reports') return 'planner'
  return tab
}

function SettingsMountPoint({
  id,
  label,
  description
}: {
  id: 'modules' | 'connections-models' | 'integrations'
  label: string
  description: string
}): JSX.Element {
  return (
    <section
      data-testid={`settings-mount-${id}`}
      aria-label={`${label} mount point`}
      className="rounded-xl border border-dashed p-4"
      style={{ background: colors.panel, borderColor: 'var(--color-line-strong)' }}
    >
      <h3 className="text-xs font-semibold" style={{ fontFamily: 'var(--font-display)' }}>
        {label}
      </h3>
      <p className="mt-1 text-[10.5px] leading-relaxed" style={{ color: colors.quartzDim }}>
        {description}
      </p>
    </section>
  )
}

function SectionHeader({ section }: { section: SettingsSection }): JSX.Element {
  return (
    <header className="mb-4 border-b pb-3" style={{ borderColor: 'var(--color-line)' }}>
      <p className="text-[10px] font-semibold uppercase tracking-[0.14em]" style={{ color: colors.bronzeHot }}>
        Settings / {section.label}
      </p>
      <h2 className="mt-1 text-sm font-bold" style={{ fontFamily: 'var(--font-display)' }}>
        {section.label}
      </h2>
    </header>
  )
}

/* Settings: live usage availability, theme importer, and control defaults migrated into wave-15 IA. */
export function SettingsPanel({ initialTab = 'limits' }: { initialTab?: SettingsTab }): JSX.Element {
  const [tab, setTab] = useState<SettingsSectionId>(() => normalizeSettingsTab(initialTab))
  // w15/modules-core — a disabled module owns no settings surface either.
  const modulesEnabled = useModulesStore((s) => s.enabled)
  const { themeId, setTheme } = useThemeStore()
  const { connections, loading: connectionsLoading, start: startConnections } = useConnectionsStore()
  const historyPolicy = useRunsStore((state) => state.historyPolicy)
  const setHistoryPolicy = useRunsStore((state) => state.setHistoryPolicy)
  const usageConnections = connections.filter((connection) => connection.usage !== null)
  const activeSection = SECTION_BY_ID[tab]

  useEffect(() => startConnections(), [startConnections])

  const autonomyRows = useMemo(
    () => [
      { label: 'Default mode for new spaces', value: 'Manual' },
      { label: 'Orchestrator may propose plans', value: 'On — launch always needs approval' },
      { label: 'Auto-answer known CLI prompts (watchdog)', value: 'Off' },
      { label: 'Remote steering from phone', value: 'Off — enable per space' }
    ],
    []
  )

  return (
    <section
      className="flex min-h-0 min-w-0 flex-1 overflow-hidden"
      style={{ background: colors.page }}
      aria-label="Settings"
    >
      <nav
        className="w-[240px] shrink-0 overflow-y-auto border-r p-3"
        style={{ borderColor: 'var(--color-line)' }}
        aria-label="Settings sections"
      >
        <p className="px-2 pb-2 text-[10px] uppercase tracking-wider" style={{ color: colors.quartzDim }}>
          Settings
        </p>
        <div className="space-y-4">
          {NAV_GROUPS.map((group) => (
            <div key={group.label}>
              <p className="px-2 pb-1.5 text-[9px] font-semibold uppercase tracking-[0.14em]" style={{ color: colors.quartzDim }}>
                {group.label}
              </p>
              {group.sections.map((section) => {
                const active = tab === section.id
                const Icon = section.icon
                return (
                  <button
                    key={section.id}
                    type="button"
                    aria-current={active ? 'page' : undefined}
                    onClick={() => setTab(section.id)}
                    className="relative mb-0.5 flex w-full cursor-pointer items-center gap-2 rounded-lg px-2.5 py-2 text-left text-xs"
                    style={{ color: active ? colors.quartz : colors.quartzDim, fontFamily: 'var(--font-display)' }}
                  >
                    {active && (
                      <motion.span
                        layoutId="settings-section"
                        transition={springs.layout}
                        className="absolute inset-0 rounded-lg border"
                        style={{ background: colors.card, borderColor: 'var(--color-line-strong)' }}
                      />
                    )}
                    <span className="relative flex items-center gap-2">
                      <Icon size={14} stroke={1.5} />
                      {section.label}
                    </span>
                  </button>
                )
              })}
            </div>
          ))}
        </div>
      </nav>

      <div className="min-h-0 min-w-0 flex-1 overflow-y-auto p-5" data-testid="settings-scroll-area">
        <div className="mx-auto w-full max-w-[640px]">
          <SectionHeader section={activeSection} />

          {/* w15 integration — Modules owns the registry list plus the wizard re-entry. */}
          {tab === 'modules' && (
            <div className="space-y-4">
              <ModuleSettingsList />
              <section
                className="rounded-xl border p-4"
                style={{ background: colors.panel, borderColor: 'var(--color-line)' }}
              >
                <h3 className="text-xs font-semibold" style={{ fontFamily: 'var(--font-display)' }}>
                  First-run setup
                </h3>
                <p className="mt-1 text-[10.5px] leading-relaxed" style={{ color: colors.quartzDim }}>
                  Re-open the setup screen to review your CLIs, models, modules and autonomy.
                </p>
                <button
                  type="button"
                  onClick={() => useOnboardingStore.getState().openSetup()}
                  className="mt-3 cursor-pointer rounded-lg px-3 py-1.5 text-[11px] font-semibold"
                  style={{ background: colors.bronze, color: colors.page }}
                >
                  Run setup again
                </button>
              </section>
            </div>
          )}

          {tab === 'connections-models' && (
            <div className="space-y-4">
              <ConnectionsSettings />
              {/* w15/model-choice — per-CLI model selection, re-homed here by the IA */}
              <ConnectionsModelsSettings />
            </div>
          )}

          {tab === 'integrations' && (
            <div className="space-y-4">
              {/* w15/integration-slots — bring-your-own-tool slots, re-homed here by the IA */}
              <IntegrationsSettings />
              {/* // w4/obsidian — w15/modules-core: mounts only with the module on */}
              {modulesEnabled.obsidian && <ObsidianSettings />}
            </div>
          )}

          {tab === 'autonomy-permissions' && (
            <div>
              <p className="text-xs leading-relaxed" style={{ color: colors.quartzDim }}>
                Assist, don&apos;t take over. Everything here is opt-in, scoped, and reversible.
              </p>
              <div className="mt-4 space-y-2">
                {autonomyRows.map((row) => (
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
              {/* // w8/voice — w15/modules-core */}
              {modulesEnabled.voice && <VoiceSettings />}
            </div>
          )}

          {tab === 'planner' && (
            <div className="space-y-4">
              {/* // w11/report-engine */}
              <ReportSettings />
              {/* w6/assistant */}
              <AssistantSettings />
            </div>
          )}

          {tab === 'memory' && <MemorySettings />}

          {tab === 'routing' && <RoutingSettings />}

          {tab === 'limits' && (
            <div>
              <p className="text-xs leading-relaxed" style={{ color: colors.quartzDim }}>
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

          {tab === 'sessions-history' && (
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
          )}

          {/* w6/pulse — w15/modules-core */}
          {tab === 'notifications' && modulesEnabled.pulse && <PulseSettings />}

          {tab === 'appearance' && (
            <div>
              <p className="text-xs leading-relaxed" style={{ color: colors.quartzDim }}>
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

          {tab === 'about' && (
            <div>
              <h3 className="text-xs font-semibold" style={{ fontFamily: 'var(--font-display)' }}>
                About Morz
              </h3>
              <p className="mt-1 text-[10.5px] leading-relaxed" style={{ color: colors.quartzDim }}>
                Windows-first AI terminal, lightweight IDE, and opt-in multi-agent orchestration.
              </p>
              {/* // w9/installer */}
              <UpdateSettings />
            </div>
          )}
        </div>
      </div>
    </section>
  )
}


