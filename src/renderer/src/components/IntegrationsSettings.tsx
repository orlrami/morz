import { useEffect, useState } from 'react'
import { IconExternalLink, IconPlugConnected } from '@tabler/icons-react'
import { colors } from '@/lib/tokens'
import { newPaneId, useLayoutStore } from '@/store/layoutStore'
import { selectActiveSpaceRoot, useSpaceStore } from '@/store/spaceStore'
import { useSlotsStore } from '@/store/slotsStore'
import { SLOTS, type SlotId, type SlotProvider } from '@shared/slots'

const SLOT_COPY: Record<SlotId, { title: string; description: string }> = {
  git: {
    title: 'Git surface',
    description: 'Choose the staging and commit workflow Morz should surface.'
  },
  review: {
    title: 'Code review',
    description: 'External reviewers stay PR-side. Morz stores only this preference.'
  },
  editor: {
    title: 'Editor',
    description: 'Route file opens to the Morz overlay or your external editor.'
  }
}

async function launchGitPane(providerId: 'lazygit' | 'gitui', cwd: string): Promise<void> {
  const pty = window.morz?.pty
  if (!pty) throw new Error('PTY bridge is unavailable')
  const paneId = `slot-git-${providerId}-${newPaneId('pane').slice(-8)}`
  const result = await pty.spawn({ paneId, cwd, cols: 120, rows: 36 })
  if (!result.ok) throw new Error(`Could not launch ${providerId}`)
  useLayoutStore.getState().addPane({
    paneId,
    kind: 'terminal',
    cwd,
    shell: '',
    touched: true
  })
  pty.write(paneId, `${providerId}\r`)
}

function installLabel(provider: SlotProvider): string {
  return `Install ${provider.label}`
}

export function IntegrationsSettings(): JSX.Element {
  const choices = useSlotsStore((state) => state.choices)
  const availability = useSlotsStore((state) => state.availability)
  const loading = useSlotsStore((state) => state.loading)
  const error = useSlotsStore((state) => state.error)
  const hydrate = useSlotsStore((state) => state.hydrate)
  const choose = useSlotsStore((state) => state.choose)
  const cwd = useSpaceStore(selectActiveSpaceRoot)
  const [actionError, setActionError] = useState<string | null>(null)

  useEffect(() => {
    void hydrate()
  }, [hydrate])

  const selectProvider = async (slotId: SlotId, provider: SlotProvider): Promise<void> => {
    setActionError(null)
    try {
      await choose(slotId, provider.id)
      if (slotId === 'git' && (provider.id === 'lazygit' || provider.id === 'gitui')) {
        await launchGitPane(provider.id, cwd)
      }
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  return (
    <div className="mx-auto w-full max-w-[680px]" data-testid="settings-mount-integrations">
      <div className="flex items-start gap-3">
        <span
          className="flex size-8 shrink-0 items-center justify-center rounded-md border"
          style={{ background: colors.card, borderColor: 'var(--color-line-strong)' }}
        >
          <IconPlugConnected size={16} stroke={1.5} />
        </span>
        <div>
          <h2 className="text-sm font-bold" style={{ fontFamily: 'var(--font-display)' }}>
            Integrations
          </h2>
          <p className="mt-1 text-xs leading-relaxed" style={{ color: colors.quartzDim }}>
            Pick the tools Morz should hand work to. Credentials remain with each provider.
          </p>
        </div>
      </div>

      <div className="mt-5 divide-y" style={{ borderColor: 'var(--color-line)' }}>
        {SLOTS.map((slot) => (
          <section key={slot.id} className="py-4 first:pt-0 last:pb-0">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <div>
                <h3 className="text-xs font-semibold" style={{ fontFamily: 'var(--font-display)' }}>
                  {SLOT_COPY[slot.id].title}
                </h3>
                <p className="mt-0.5 text-[10.5px]" style={{ color: colors.quartzDim }}>
                  {SLOT_COPY[slot.id].description}
                </p>
              </div>
            </div>

            <div className="mt-3 grid gap-2 sm:grid-cols-2">
              {slot.providers.map((provider) => {
                const available = !provider.requiresBin || availability[provider.requiresBin] === true
                const unavailable = !!provider.requiresBin && !loading && !available
                const selected = choices[slot.id] === provider.id
                return (
                  <label
                    key={provider.id}
                    className="flex min-h-12 items-center gap-2 rounded-md border px-3 py-2"
                    style={{
                      background: selected ? colors.card : colors.panel,
                      borderColor: selected ? 'rgba(203,162,90,0.55)' : 'var(--color-line)',
                      color: unavailable ? colors.quartzFaint : colors.quartz,
                      opacity: unavailable ? 0.62 : 1
                    }}
                  >
                    <input
                      type="radio"
                      name={`slot-${slot.id}`}
                      value={provider.id}
                      checked={selected}
                      disabled={unavailable}
                      onChange={() => void selectProvider(slot.id, provider)}
                      className="size-3.5"
                      style={{ accentColor: colors.bronze }}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block text-[11px] font-semibold">{provider.label}</span>
                      <span className="block text-[9px]" style={{ color: colors.quartzDim }}>
                        {provider.kind === 'pane'
                          ? 'Dedicated Morz pane'
                          : provider.kind === 'external'
                            ? 'PR-side service'
                            : provider.kind === 'handoff'
                              ? 'External file handoff'
                              : 'Built into Morz'}
                      </span>
                    </span>
                    {unavailable && provider.installUrl && (
                      <a
                        href={provider.installUrl}
                        target="_blank"
                        rel="noopener"
                        aria-label={installLabel(provider)}
                        className="flex shrink-0 items-center gap-1 text-[9px] hover:underline"
                        style={{ color: colors.bronzeHot }}
                        onClick={(event) => event.stopPropagation()}
                      >
                        Install
                        <IconExternalLink size={10} stroke={1.5} />
                      </a>
                    )}
                    {provider.kind === 'external' && provider.statusUrl && selected && (
                      <a
                        href={provider.statusUrl}
                        target="_blank"
                        rel="noopener"
                        aria-label={`${provider.label} PR status`}
                        className="flex shrink-0 items-center gap-1 text-[9px] hover:underline"
                        style={{ color: colors.bronzeHot }}
                        onClick={(event) => event.stopPropagation()}
                      >
                        PR status
                        <IconExternalLink size={10} stroke={1.5} />
                      </a>
                    )}
                  </label>
                )
              })}
            </div>
          </section>
        ))}
      </div>

      {(choices.git === 'lazygit' || choices.git === 'gitui') && (
        <div
          role="status"
          className="mt-4 rounded-md border px-3 py-2 text-[10.5px]"
          style={{
            background: 'rgba(203,162,90,0.08)',
            borderColor: 'rgba(203,162,90,0.35)',
            color: colors.bronzeHot
          }}
        >
          {choices.git} replaces the Morz Commit module while selected.
        </div>
      )}
      {(error || actionError) && (
        <p className="mt-3 text-[10.5px]" role="alert" style={{ color: colors.error }}>
          {actionError ?? error}
        </p>
      )}
    </div>
  )
}
