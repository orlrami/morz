import {
  IconAdjustments,
  IconBrowser,
  IconGitCommit,
  IconHistory,
  IconLayoutSidebarLeftExpand,
  IconListCheck,
  IconSettings,
  IconTerminal2,
  IconTopologyStar3
} from '@tabler/icons-react'
import type { ModuleId } from '@shared/modules'
import {
  ONBOARDING_SLOTS,
  type OnboardingMode,
  type OnboardingSlotId,
  type OnboardingTargetId
} from '@shared/onboarding'
import { MorzSignal, MorzWordmark } from './Brand'
import { colors } from '@/lib/tokens'

interface OnboardingPreviewProps {
  modules: Record<ModuleId, boolean>
  models: Record<OnboardingTargetId, string>
  slots: Record<OnboardingSlotId, string>
  autonomy: OnboardingMode
}

const PREVIEW_MODULES: readonly {
  id: ModuleId
  label: string
  icon: typeof IconTerminal2
}[] = [
  { id: 'sessions', label: 'Sessions', icon: IconHistory },
  { id: 'commit', label: 'Commit', icon: IconGitCommit },
  { id: 'review', label: 'Review', icon: IconListCheck },
  { id: 'orchestration', label: 'Waves', icon: IconTopologyStar3 },
  { id: 'browser', label: 'Browser', icon: IconBrowser },
  { id: 'organizer', label: 'Organizer', icon: IconLayoutSidebarLeftExpand },
  { id: 'workshop', label: 'Workshop', icon: IconAdjustments }
]

function spawnLine(cli: 'claude' | 'codex' | 'agy' | 'opencode', model: string): string {
  if (model === 'inherit') return `${cli}  ·  Morz adds no model flag`
  if (cli === 'claude') return `claude --model ${model}`
  if (cli === 'codex') return `codex -m ${model}`
  if (cli === 'agy') return `agy --model "${model}"`
  return `opencode --model ${model}`
}

export function OnboardingPreview({
  modules,
  models,
  slots,
  autonomy
}: OnboardingPreviewProps): JSX.Element {
  const enabled = PREVIEW_MODULES.filter((module) => modules[module.id])
  return (
    <section
      aria-label="Live preview"
      className="flex h-full min-h-0 flex-col"
      style={{ background: colors.panel }}
    >
      <div className="border-b px-6 py-5" style={{ borderColor: 'var(--color-line)' }}>
        <p className="text-[10px] font-semibold uppercase tracking-[0.18em]" style={{ color: colors.bronze }}>
          Live preview
        </p>
        <h2 className="mt-1 text-base font-bold" style={{ fontFamily: 'var(--font-display)' }}>
          Your shell, before you open it
        </h2>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-6">
        <div
          className="overflow-hidden rounded-2xl border shadow-2xl"
          style={{ background: colors.page, borderColor: 'var(--color-line-strong)' }}
        >
          <div
            className="flex h-9 items-center gap-2 border-b px-3"
            style={{ background: colors.panel, borderColor: 'var(--color-line)' }}
          >
            <MorzSignal className="h-4 w-6" style={{ color: colors.quartz }} />
            <MorzWordmark className="text-[11px]" />
            <span className="ml-4 rounded-md px-2 py-0.5 text-[8px]" style={{ background: colors.card, color: colors.quartzDim }}>
              project
            </span>
          </div>

          <div className="flex h-[286px]">
            <div
              className="flex w-11 shrink-0 flex-col items-center gap-2 border-r py-3"
              style={{ background: colors.panel, borderColor: 'var(--color-line)' }}
            >
              <span className="relative grid size-7 place-items-center rounded-lg" style={{ background: colors.card, color: colors.bronzeHot }}>
                <span className="absolute -left-1 h-4 w-0.5 rounded-full" style={{ background: colors.bronze }} />
                <IconTerminal2 size={14} stroke={1.5} />
              </span>
              <IconLayoutSidebarLeftExpand size={14} stroke={1.5} style={{ color: colors.quartzDim }} />
              <span className="my-1 h-px w-5" style={{ background: 'var(--color-line-strong)' }} />
              {enabled.map((module) => {
                const Icon = module.icon
                return (
                  <span
                    key={module.id}
                    title={module.label}
                    className="grid size-7 place-items-center rounded-lg"
                    style={{ color: colors.quartzDim }}
                  >
                    <Icon size={14} stroke={1.5} />
                  </span>
                )
              })}
              <IconSettings className="mt-auto" size={14} stroke={1.5} style={{ color: colors.quartzDim }} />
            </div>

            <div className="min-w-0 flex-1">
              <div
                className="flex h-9 items-center gap-1 overflow-hidden border-b px-2"
                role="tablist"
                aria-label="Preview tabs"
                style={{ borderColor: 'var(--color-line)' }}
              >
                <span
                  role="tab"
                  aria-selected="true"
                  className="rounded-md border px-2 py-1 text-[8px]"
                  style={{ background: colors.card, borderColor: 'var(--color-line-strong)' }}
                >
                  Terminals
                </span>
                {enabled.map((module) => (
                  <span
                    key={module.id}
                    role="tab"
                    aria-selected="false"
                    className="shrink-0 px-1.5 py-1 text-[8px]"
                    style={{ color: colors.quartzDim }}
                  >
                    {module.label}
                  </span>
                ))}
              </div>
              <div className="grid h-[247px] grid-cols-2 gap-px p-px" style={{ background: 'var(--color-line)' }}>
                {[0, 1].map((pane) => (
                  <div key={pane} className="p-3" style={{ background: '#1f1e1a' }}>
                    <p className="font-mono text-[7px]" style={{ color: colors.quartzFaint }}>
                      PS C:\Projects\morz&gt;
                    </p>
                    <p className="mt-2 font-mono text-[7px]" style={{ color: pane === 0 ? colors.agentClaude : colors.agentCodex }}>
                      {pane === 0 ? 'ready for your next task' : 'plain shell · no agent'}
                    </p>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>

        <div className="mt-5">
          <h3 className="text-[11px] font-bold uppercase tracking-[0.12em]" style={{ color: colors.quartzDim }}>
            Launch defaults
          </h3>
          <div className="mt-2 space-y-1.5">
            {(['claude', 'codex', 'agy', 'opencode'] as const).map((cli) => (
              <code
                key={cli}
                className="block rounded-lg border px-3 py-2 text-[9.5px]"
                style={{
                  background: colors.page,
                  borderColor: 'var(--color-line)',
                  color: colors.quartz
                }}
              >
                {spawnLine(cli, models[cli])}
              </code>
            ))}
          </div>
        </div>

        <p
          className="mt-4 rounded-xl border px-3 py-2.5 text-[10px] leading-relaxed"
          style={{ background: 'rgba(203,162,90,0.08)', borderColor: 'rgba(203,162,90,0.25)', color: colors.quartzDim }}
        >
          <strong style={{ color: colors.bronzeHot }}>
            {autonomy === 'manual' ? 'Manual' : autonomy === 'assisted' ? 'Assisted' : 'Orchestrated'}
          </strong>
          {' · '}
          {autonomy === 'manual'
            ? 'Morz never starts an agent without you.'
            : autonomy === 'assisted'
              ? 'Agent actions stay visible and user-directed.'
              : 'Morz may propose teams; every launch still needs approval.'}
        </p>
        <div className="mt-3 flex flex-wrap gap-1.5">
          {ONBOARDING_SLOTS.map((slot) => (
            <span
              key={slot.id}
              className="rounded-full border px-2 py-1 text-[8.5px]"
              style={{ borderColor: 'var(--color-line-strong)', color: colors.quartzDim }}
            >
              {slot.label}: {slot.providers.find((provider) => provider.id === slots[slot.id])?.label}
            </span>
          ))}
        </div>
      </div>
    </section>
  )
}
