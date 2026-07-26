import { useEffect, useMemo, useState } from 'react'
import {
  IconCheck,
  IconCircleCheckFilled,
  IconDownload,
  IconLoader2,
  IconLock,
  IconSparkles
} from '@tabler/icons-react'
import { MODULES, type ModuleId } from '@shared/modules'
import {
  minimalOnboardingSnapshot,
  ONBOARDING_SLOTS,
  ONBOARDING_TARGETS,
  type OnboardingDetection,
  type OnboardingMode,
  type OnboardingSnapshot
} from '@shared/onboarding'
import { colors } from '@/lib/tokens'
import { MorzSignal, MorzWordmark } from './Brand'
import { OnboardingPreview } from './OnboardingPreview'

interface OnboardingScreenProps {
  snapshot: OnboardingSnapshot
  detections: OnboardingDetection[]
  onSave(snapshot: OnboardingSnapshot): Promise<void>
  onSkip(): Promise<void>
}

const CORE_SURFACES = ['Terminals', 'Explorer', 'IDE overlay', 'Spaces', 'Settings'] as const

function cloneSnapshot(snapshot: OnboardingSnapshot): OnboardingSnapshot {
  return {
    ...snapshot,
    modules: { ...snapshot.modules },
    models: { ...snapshot.models },
    slots: { ...snapshot.slots }
  }
}

export function OnboardingScreen({
  snapshot,
  detections,
  onSave,
  onSkip
}: OnboardingScreenProps): JSX.Element {
  /* w15 integration — always start from the snapshot the store handed us: its
   * modules mirror the registry (source of truth), so a first run never
   * silently reverts state the app already has. "Start minimal" stays an
   * explicit action (onSkip), not the default draft. */
  const [draft, setDraft] = useState<OnboardingSnapshot>(() => cloneSnapshot(snapshot))
  const [saving, setSaving] = useState<'open' | 'skip' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const detected = useMemo(
    () => new Map(detections.map((item) => [item.id, item])),
    [detections]
  )

  useEffect(() => {
    setDraft(cloneSnapshot(snapshot))
  }, [snapshot])

  const setModule = (id: ModuleId, enabled: boolean): void => {
    setDraft((current) => ({
      ...current,
      modules: { ...current.modules, [id]: enabled },
      autonomy:
        id === 'orchestration' && !enabled && current.autonomy === 'orchestrated'
          ? 'manual'
          : current.autonomy
    }))
  }

  const submit = async (kind: 'open' | 'skip'): Promise<void> => {
    setSaving(kind)
    setError(null)
    try {
      if (kind === 'skip') await onSkip()
      else await onSave({ ...draft, completed: true })
    } catch {
      setError('Setup could not be saved. Your existing configuration was not changed.')
    } finally {
      setSaving(null)
    }
  }

  return (
    <div
      className="fixed inset-0 z-[100] flex flex-col pt-[38px]"
      style={{ background: colors.page }}
      aria-label="First-run setup"
    >
      {/* Frameless window: this full-window surface covers the titlebar. The
       * top padding AND the whole 68px header drag the window (owner feedback
       * w16.1 — a thin strip was too small to find); interactive children opt
       * out individually. */}
      <div
        data-testid="onboarding-drag-strip"
        aria-hidden
        className="absolute inset-x-0 top-0 h-[38px]"
        style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
      />
      <header
        className="flex h-[68px] shrink-0 items-center justify-between border-b px-7"
        style={{
          background: colors.panel,
          borderColor: 'var(--color-line)',
          WebkitAppRegion: 'drag'
        } as React.CSSProperties}
      >
        <div className="flex items-center gap-3">
          <MorzSignal className="h-7 w-10" style={{ color: colors.quartz }} />
          <MorzWordmark className="text-lg" />
          <span className="h-4 w-px" style={{ background: 'var(--color-line-strong)' }} />
          <span className="text-[10px] uppercase tracking-[0.16em]" style={{ color: colors.quartzDim }}>
            First-run setup
          </span>
        </div>
        <p className="text-[10px]" style={{ color: colors.quartzDim }}>
          Local-first · no account required
        </p>
      </header>

      <div className="grid min-h-0 flex-1 grid-cols-[minmax(540px,1.1fr)_minmax(390px,0.9fr)]">
        <main className="min-h-0 overflow-y-auto px-8 py-7">
          <div className="mx-auto max-w-[760px]">
            <div className="mb-7">
              <p className="text-[10px] font-semibold uppercase tracking-[0.2em]" style={{ color: colors.bronze }}>
                Configure once. Change anything later.
              </p>
              <h1 className="mt-2 text-[28px] font-extrabold tracking-[-0.03em]" style={{ fontFamily: 'var(--font-display)' }}>
                Make Morz yours
              </h1>
              <p className="mt-2 max-w-[620px] text-xs leading-relaxed" style={{ color: colors.quartzDim }}>
                Morz uses the tools already on your machine. Pick what belongs in your shell and see the result before anything changes.
              </p>
            </div>

            <SetupSection number="1" title="Your CLIs & default models" description="Detected from PATH. Inherit means Morz adds no model flag.">
              <div className="overflow-hidden rounded-2xl border" style={{ borderColor: 'var(--color-line)' }}>
                {ONBOARDING_TARGETS.map((target, index) => {
                  const detection = detected.get(target.id)
                  const installed = detection?.installed === true
                  return (
                    <div
                      key={target.id}
                      data-testid="onboarding-cli-row"
                      className="grid grid-cols-[minmax(150px,1fr)_minmax(220px,1.2fr)] items-center gap-4 px-4 py-3"
                      style={{
                        background: index % 2 === 0 ? colors.panel : colors.page,
                        borderTop: index === 0 ? undefined : '1px solid var(--color-line)'
                      }}
                    >
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          {installed ? (
                            <IconCircleCheckFilled size={14} style={{ color: colors.done }} />
                          ) : (
                            <span className="size-2 rounded-full" style={{ background: colors.quartzFaint }} />
                          )}
                          <span className="text-xs font-semibold">{target.label}</span>
                          {!installed && (
                            <a
                              href={target.getUrl}
                              target="_blank"
                              rel="noreferrer noopener"
                              className="ml-auto flex items-center gap-1 text-[9.5px] underline-offset-2 hover:underline"
                              style={{ color: colors.bronzeHot }}
                            >
                              <IconDownload size={11} />
                              Get it
                            </a>
                          )}
                        </div>
                        <p className="mt-1 truncate pl-5 font-mono text-[9px]" style={{ color: colors.quartzDim }}>
                          {installed ? detection?.version ?? 'Found · version unavailable' : 'Not found on PATH'}
                        </p>
                      </div>
                      <select
                        aria-label={`Default model for ${target.label}`}
                        value={draft.models[target.id]}
                        onChange={(event) =>
                          setDraft((current) => ({
                            ...current,
                            models: { ...current.models, [target.id]: event.target.value }
                          }))
                        }
                        className="min-w-0 rounded-lg border bg-transparent px-3 py-2 text-[10px]"
                        style={{ borderColor: 'var(--color-line-strong)', color: colors.quartz }}
                      >
                        {target.models.map((model) => (
                          <option key={model.value} value={model.value}>
                            {model.label}
                          </option>
                        ))}
                      </select>
                    </div>
                  )
                })}
              </div>
            </SetupSection>

            <SetupSection number="2" title="Modules & your tools" description="Core stays on. Everything else is opt-in and reversible.">
              <div className="flex flex-wrap gap-2">
                {CORE_SURFACES.map((surface) => (
                  <span
                    key={surface}
                    className="flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[9.5px]"
                    style={{ background: colors.panel, borderColor: 'var(--color-line)', color: colors.quartzDim }}
                  >
                    <IconLock size={11} stroke={1.5} />
                    {surface}
                    <IconCheck size={10} style={{ color: colors.done }} />
                  </span>
                ))}
              </div>

              <div className="mt-3 grid grid-cols-2 gap-2">
                {MODULES.map((module) => {
                  const enabled = draft.modules[module.id]
                  return (
                    <button
                      key={module.id}
                      type="button"
                      role="checkbox"
                      aria-checked={enabled}
                      aria-label={`Enable ${module.label}`}
                      onClick={() => setModule(module.id, !enabled)}
                      className="flex cursor-pointer items-center justify-between rounded-xl border px-3 py-2.5 text-left"
                      style={{
                        background: enabled ? 'rgba(203,162,90,0.10)' : colors.panel,
                        borderColor: enabled ? 'rgba(203,162,90,0.42)' : 'var(--color-line)'
                      }}
                    >
                      <span>
                        <span className="block text-[11px] font-semibold">{module.label}</span>
                        <span className="mt-0.5 block text-[8.5px]" style={{ color: colors.quartzDim }}>
                          {module.id === 'orchestration' ? 'Planner, waves, runs & dock' : enabled ? 'Shown in your shell' : 'Hidden and inactive'}
                        </span>
                      </span>
                      <span
                        className="relative h-4 w-7 rounded-full transition-colors"
                        style={{ background: enabled ? colors.bronze : 'rgba(238,230,217,0.18)' }}
                      >
                        <span
                          className="absolute top-0.5 size-3 rounded-full transition-transform"
                          style={{
                            background: colors.quartz,
                            transform: enabled ? 'translateX(13px)' : 'translateX(2px)'
                          }}
                        />
                      </span>
                    </button>
                  )
                })}
              </div>

              <div className="mt-4 grid grid-cols-3 gap-2">
                {ONBOARDING_SLOTS.map((slot) => (
                  <label
                    key={slot.id}
                    className="rounded-xl border p-3"
                    style={{ background: colors.panel, borderColor: 'var(--color-line)' }}
                  >
                    <span className="block text-[9px] uppercase tracking-[0.12em]" style={{ color: colors.quartzDim }}>
                      {slot.label}
                    </span>
                    <select
                      aria-label={slot.label}
                      value={draft.slots[slot.id]}
                      onChange={(event) =>
                        setDraft((current) => ({
                          ...current,
                          slots: { ...current.slots, [slot.id]: event.target.value }
                        }))
                      }
                      className="mt-2 w-full rounded-lg border bg-transparent px-2 py-1.5 text-[10px]"
                      style={{ borderColor: 'var(--color-line-strong)', color: colors.quartz }}
                    >
                      {slot.providers.map((provider) => {
                        const available =
                          !provider.requiresBin || detected.get(provider.requiresBin)?.installed === true
                        return (
                          <option key={provider.id} value={provider.id} disabled={!available}>
                            {provider.label}{available ? '' : ' · not installed'}
                          </option>
                        )
                      })}
                    </select>
                  </label>
                ))}
              </div>
            </SetupSection>

            <SetupSection number="3" title="Autonomy" description="Manual is the default. Approval gates remain in every mode.">
              <div className="grid grid-cols-3 gap-2" role="radiogroup" aria-label="Default autonomy">
                {([
                  ['manual', 'Manual', 'You start every agent and action.'],
                  ['assisted', 'Assisted', 'Morz helps inside your active session.'],
                  ['orchestrated', 'Orchestrated', 'Morz proposes teams and waves.']
                ] as const).map(([id, label, note]) => {
                  const locked = id === 'orchestrated' && !draft.modules.orchestration
                  const active = draft.autonomy === id
                  return (
                    <button
                      key={id}
                      type="button"
                      role="radio"
                      aria-checked={active}
                      aria-disabled={locked}
                      disabled={locked}
                      onClick={() => setDraft((current) => ({ ...current, autonomy: id as OnboardingMode }))}
                      className="cursor-pointer rounded-xl border p-3 text-left disabled:cursor-not-allowed disabled:opacity-45"
                      style={{
                        background: active ? 'rgba(203,162,90,0.10)' : colors.panel,
                        borderColor: active ? 'rgba(203,162,90,0.48)' : 'var(--color-line)'
                      }}
                    >
                      <span className="flex items-center gap-1.5 text-[11px] font-bold">
                        {active && <IconSparkles size={12} style={{ color: colors.bronzeHot }} />}
                        {label}
                      </span>
                      <span className="mt-1.5 block text-[9px] leading-relaxed" style={{ color: colors.quartzDim }}>
                        {locked ? 'Enable Orchestration to unlock.' : note}
                      </span>
                    </button>
                  )
                })}
              </div>
            </SetupSection>
          </div>
        </main>

        <aside className="min-h-0 border-l" style={{ borderColor: 'var(--color-line)' }}>
          <OnboardingPreview
            modules={draft.modules}
            models={draft.models}
            slots={draft.slots}
            autonomy={draft.autonomy}
          />
        </aside>
      </div>

      <footer
        className="flex min-h-[70px] shrink-0 items-center justify-between gap-4 border-t px-8 py-3"
        style={{ background: colors.panel, borderColor: 'var(--color-line)' }}
      >
        <div>
          {error && <p role="alert" className="text-[10px]" style={{ color: colors.error }}>{error}</p>}
          {!error && <p className="text-[9.5px]" style={{ color: colors.quartzDim }}>Nothing here writes to your CLI configuration files.</p>}
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            disabled={saving !== null}
            onClick={() => void submit('skip')}
            className="cursor-pointer rounded-xl px-4 py-2.5 text-[11px] disabled:cursor-wait disabled:opacity-60"
            style={{ color: colors.quartzDim }}
          >
            {saving === 'skip' ? 'Saving minimal setup…' : 'Skip — start minimal'}
          </button>
          <button
            type="button"
            disabled={saving !== null}
            onClick={() => void submit('open')}
            className="flex min-w-[132px] cursor-pointer items-center justify-center gap-2 rounded-xl px-5 py-2.5 text-[11px] font-bold disabled:cursor-wait disabled:opacity-60"
            style={{ background: colors.bronze, color: colors.page }}
          >
            {saving === 'open' && <IconLoader2 className="animate-spin" size={13} />}
            {saving === 'open' ? 'Opening…' : 'Open Morz'}
          </button>
        </div>
      </footer>
    </div>
  )
}

function SetupSection({
  number,
  title,
  description,
  children
}: {
  number: string
  title: string
  description: string
  children: React.ReactNode
}): JSX.Element {
  return (
    <section className="mb-7">
      <div className="mb-3 flex items-start gap-3">
        <span
          className="grid size-6 shrink-0 place-items-center rounded-lg border text-[10px] font-bold"
          style={{ background: 'rgba(203,162,90,0.10)', borderColor: 'rgba(203,162,90,0.32)', color: colors.bronzeHot }}
        >
          {number}
        </span>
        <div>
          <h2 className="text-sm font-bold" style={{ fontFamily: 'var(--font-display)' }}>{title}</h2>
          <p className="mt-0.5 text-[10px]" style={{ color: colors.quartzDim }}>{description}</p>
        </div>
      </div>
      {children}
    </section>
  )
}
