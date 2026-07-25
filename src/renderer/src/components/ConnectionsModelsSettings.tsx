/*
 * w15/model-choice — "Connections & Models" settings section (mock: Morz
 * Settings.html). One card per CLI: status/version + applies-to chips, model
 * select, apply-as radios, live mono mechanism line, Claude fallback chain,
 * and a per-space override when a space is active.
 *
 * Inherit = Morz adds no flag. Session flag = per-launch argv, no files.
 * Write to CLI config = a diff proposal through the config-writer that the
 * user approves in ConfigDiffDialog — never a silent write.
 *
 * Agent 6 (w15/settings-ia) mounts this component in the new settings nav.
 */
import { useCallback, useEffect, useState } from 'react'
import type {
  ConfigWriterProposal,
  ModelChoiceSetInput,
  ModelChoiceSnapshot,
  MorzModelsBridge
} from '@shared/ipc'
import {
  CONFIG_WRITE_CLIS,
  describeMechanism,
  MODEL_CONFIG_PATH_LABEL,
  type ModelChoice,
  type ModelCli,
  type ModelSource
} from '@shared/model-choice'
import { colors } from '@/lib/tokens'
import { useConnectionsStore } from '@/store/connectionsStore'
import { selectActiveSpace, useSpaceStore } from '@/store/spaceStore'
import { ConfigDiffDialog } from './ConfigDiffDialog'

function modelsApi(): MorzModelsBridge | undefined {
  return (window as unknown as { morzModels?: MorzModelsBridge }).morzModels
}

const CLI_LABEL: Record<ModelCli, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  agy: 'Antigravity',
  opencode: 'OpenCode'
}

/** Which launch surfaces each connection powers (mock chips). */
const APPLIES_TO: Record<ModelCli, string[]> = {
  claude: ['LANES', 'DISPATCH', 'PLANNER'],
  codex: ['DISPATCH', 'PLANNER', 'REVIEWER'],
  agy: ['DISPATCH', 'ROUTING: MATH'],
  opencode: ['BYO ASSISTANT']
}

const SOURCE_LABEL: Record<ModelSource, string> = {
  'session-flag': 'Session flag',
  'cli-config': 'Write to CLI config',
  inherit: 'Inherit'
}

function sourcesFor(cli: ModelCli): ModelSource[] {
  return CONFIG_WRITE_CLIS.includes(cli)
    ? ['session-flag', 'cli-config', 'inherit']
    : ['session-flag', 'inherit']
}

export function ConnectionsModelsSettings(): JSX.Element {
  const { connections } = useConnectionsStore()
  const activeSpace = useSpaceStore(selectActiveSpace)
  const spaceRoot = activeSpace?.root
  const [snapshots, setSnapshots] = useState<ModelChoiceSnapshot[]>([])
  const [error, setError] = useState<string | null>(null)
  const [proposal, setProposal] = useState<ConfigWriterProposal | null>(null)
  const [proposing, setProposing] = useState<ModelCli | null>(null)

  const reload = useCallback(async (): Promise<void> => {
    const api = modelsApi()
    if (!api) return
    try {
      setSnapshots(await api.list(spaceRoot))
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Model settings are unavailable')
    }
  }, [spaceRoot])

  useEffect(() => {
    void reload()
    return modelsApi()?.onChanged(() => void reload())
  }, [reload])

  const save = async (input: ModelChoiceSetInput): Promise<void> => {
    const api = modelsApi()
    if (!api) return
    try {
      setError(null)
      setSnapshots(await api.set(input))
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Saving the model choice failed')
    }
  }

  const proposeConfigWrite = async (cli: ModelCli, model: string): Promise<void> => {
    const api = modelsApi()
    if (!api || model === 'inherit') return
    setProposing(cli)
    setError(null)
    try {
      setProposal(await api.proposeConfig(cli, model))
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'The config proposal failed')
    } finally {
      setProposing(null)
    }
  }

  return (
    <section className="mt-8 max-w-[640px]" aria-label="Connections and models">
      <h2 className="text-sm font-bold" style={{ fontFamily: 'var(--font-display)' }}>
        Connections &amp; Models
      </h2>
      <p className="mt-1 text-xs leading-relaxed" style={{ color: colors.quartzDim }}>
        Which model each CLI launches with. <b>Inherit</b> respects the CLI&apos;s own config and adds
        nothing. A <b>session flag</b> applies per launch and touches no files. <b>Write to CLI
        config</b> proposes a diff you approve before anything changes.
      </p>

      {error && (
        <p
          role="alert"
          className="mt-3 rounded-lg border px-3 py-2 text-[10.5px]"
          style={{ borderColor: `${colors.error}66`, color: colors.error, background: `${colors.error}0d` }}
        >
          {error}
        </p>
      )}

      <div className="mt-4 space-y-3">
        {snapshots.map((snapshot) => {
          const cli = snapshot.cli
          const connection = connections.find((entry) => entry.id === cli)
          const installed = connection?.installed ?? false
          const choice = snapshot.global
          const effective: ModelChoice = snapshot.effective
          const overrideModel = snapshot.spaceOverride?.model ?? ''
          const configLabel = MODEL_CONFIG_PATH_LABEL[cli]
          return (
            <article
              key={cli}
              data-testid={`model-card-${cli}`}
              className="rounded-xl border p-3.5"
              style={{ background: colors.panel, borderColor: 'var(--color-line)' }}
            >
              <div className="flex items-center gap-2.5">
                <span
                  className="size-2 shrink-0 rounded-full"
                  style={{ background: installed ? colors.done : 'var(--color-line-strong)' }}
                  aria-hidden="true"
                />
                <h3 className="text-xs font-semibold" style={{ fontFamily: 'var(--font-display)' }}>
                  {CLI_LABEL[cli]}
                </h3>
                <span className="truncate font-mono text-[9px]" style={{ color: colors.quartzDim }}>
                  {installed ? connection?.version ?? 'version unavailable' : 'not found on PATH'}
                </span>
                <span className="ml-auto flex gap-1">
                  {APPLIES_TO[cli].map((chip) => (
                    <span
                      key={chip}
                      className="rounded border px-1.5 py-0.5 text-[8px] font-bold tracking-wide"
                      style={{ borderColor: 'var(--color-line-strong)', color: colors.quartzDim }}
                    >
                      {chip}
                    </span>
                  ))}
                </span>
              </div>

              <div className="mt-3 grid gap-2">
                <label className="flex items-center justify-between gap-3 text-[10.5px]">
                  <span style={{ color: colors.quartzDim }}>Default model</span>
                  <select
                    aria-label={`Default model for ${CLI_LABEL[cli]}`}
                    data-testid={`model-select-${cli}`}
                    value={choice.model}
                    onChange={(event) => {
                      const model = event.target.value
                      void save({
                        cli,
                        model,
                        source:
                          model === 'inherit'
                            ? 'inherit'
                            : choice.source === 'inherit'
                              ? 'session-flag'
                              : choice.source,
                        fallback: choice.fallback ?? null
                      })
                    }}
                    className="min-w-[200px] rounded-md border bg-transparent px-2 py-1 text-[10.5px] outline-none"
                    style={{ borderColor: 'var(--color-line-strong)', color: colors.bronzeHot }}
                  >
                    <option value="inherit">Inherit CLI default</option>
                    {snapshot.catalog.map((entry) => (
                      <option key={entry.id} value={entry.id}>
                        {entry.label}
                      </option>
                    ))}
                  </select>
                </label>

                <div className="flex items-center gap-3 text-[10.5px]">
                  <span style={{ color: colors.quartzDim }}>Apply as</span>
                  <div className="flex gap-3" role="radiogroup" aria-label={`Apply mode for ${CLI_LABEL[cli]}`}>
                    {sourcesFor(cli).map((source) => (
                      <label key={source} className="flex cursor-pointer items-center gap-1.5">
                        <input
                          type="radio"
                          name={`model-source-${cli}`}
                          data-testid={`model-source-${cli}-${source}`}
                          checked={choice.source === source}
                          onChange={() =>
                            void save({
                              cli,
                              model: choice.model,
                              source,
                              fallback: choice.fallback ?? null
                            })
                          }
                        />
                        {SOURCE_LABEL[source]}
                      </label>
                    ))}
                  </div>
                </div>

                {cli === 'claude' && (
                  <label className="flex items-center justify-between gap-3 text-[10.5px]">
                    <span style={{ color: colors.quartzDim }}>Fallback chain</span>
                    <input
                      type="text"
                      data-testid="model-fallback-claude"
                      placeholder="opus, sonnet"
                      defaultValue={choice.fallback ?? ''}
                      onBlur={(event) =>
                        void save({
                          cli,
                          model: choice.model,
                          source: choice.source,
                          fallback: event.target.value.trim() || null
                        })
                      }
                      className="min-w-[200px] rounded-md border bg-transparent px-2 py-1 font-mono text-[10px] outline-none"
                      style={{ borderColor: 'var(--color-line-strong)', color: colors.quartz }}
                    />
                  </label>
                )}

                {choice.source === 'cli-config' && configLabel && (
                  <button
                    type="button"
                    data-testid={`model-propose-${cli}`}
                    disabled={choice.model === 'inherit' || proposing === cli}
                    onClick={() => void proposeConfigWrite(cli, choice.model)}
                    className="w-fit rounded-md border px-2.5 py-1 text-[10px] font-bold disabled:cursor-not-allowed disabled:opacity-45"
                    style={{ borderColor: 'var(--color-line-strong)', color: colors.bronzeHot }}
                  >
                    {proposing === cli ? 'Preparing diff…' : `Propose diff to ${configLabel}`}
                  </button>
                )}

                {spaceRoot && (
                  <label className="flex items-center justify-between gap-3 text-[10.5px]">
                    <span style={{ color: colors.quartzDim }}>
                      Override for <span className="font-mono">{activeSpace?.name ?? spaceRoot}</span>
                    </span>
                    <select
                      aria-label={`Space model override for ${CLI_LABEL[cli]}`}
                      data-testid={`model-override-${cli}`}
                      value={overrideModel}
                      onChange={(event) => {
                        const api = modelsApi()
                        if (!api) return
                        const model = event.target.value
                        const action = model
                          ? api.set({ cli, model, source: 'session-flag', spaceRoot })
                          : api.clearOverride(cli, spaceRoot)
                        void action.then(setSnapshots).catch((reason) =>
                          setError(reason instanceof Error ? reason.message : 'Override failed')
                        )
                      }}
                      className="min-w-[200px] rounded-md border bg-transparent px-2 py-1 text-[10.5px] outline-none"
                      style={{ borderColor: 'var(--color-line-strong)', color: colors.quartz }}
                    >
                      <option value="">Use global default</option>
                      {snapshot.catalog.map((entry) => (
                        <option key={entry.id} value={entry.id}>
                          {entry.label}
                        </option>
                      ))}
                    </select>
                  </label>
                )}

                <p
                  data-testid={`model-mechanism-${cli}`}
                  className="rounded-md border border-dashed px-2 py-1.5 font-mono text-[9.5px] leading-relaxed"
                  style={{ borderColor: 'var(--color-line)', color: colors.quartzDim }}
                >
                  {describeMechanism(effective)}
                </p>
              </div>
            </article>
          )
        })}
      </div>

      <p className="mt-3 text-[9.5px] leading-relaxed" style={{ color: colors.quartzDim }}>
        <b>Per-space overrides:</b> any space can pin its own models. <b>Nothing is silent:</b> config
        writes go through the diff-first writer with backups; session flags show in the launch line.
      </p>

      <ConfigDiffDialog
        open={proposal !== null}
        proposals={proposal ? [proposal] : []}
        onCancel={() => setProposal(null)}
        onApplied={() => {
          setProposal(null)
          void reload()
        }}
      />
    </section>
  )
}
