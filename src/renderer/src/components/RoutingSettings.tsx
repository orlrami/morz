import { useEffect } from 'react'
import { IconRefresh, IconRoute, IconShieldLock } from '@tabler/icons-react'
import type { RoutingTarget } from '@shared/ipc'
import { colors } from '@/lib/tokens'
import { useRoutingStore } from '@/store/routingStore'
import { useSpaceStore } from '@/store/spaceStore'

const TARGET_LABEL: Record<RoutingTarget, string> = {
  agy: 'Antigravity',
  codex: 'Codex',
  claude: 'Claude',
  local: 'Local model'
}

function commaList(value: string): string[] {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
}

/** Compact control-panel editor matching the existing Morz card language. */
export function RoutingSettings(): JSX.Element {
  const spaceRoot = useSpaceStore((state) => state.spaces[0]?.root ?? '')
  const {
    rules,
    localModels,
    spacePrivate,
    loading,
    saving,
    message,
    error,
    load,
    updateRule,
    saveRules,
    setSpacePrivate,
    refreshLocalModels
  } = useRoutingStore()

  useEffect(() => {
    void load(spaceRoot)
  }, [load, spaceRoot])

  return (
    <section
      className="mt-5 border-t pt-4"
      style={{ borderColor: 'var(--color-line)' }}
      aria-label="Routing settings"
    >
      <div className="flex items-center gap-2">
        <IconRoute size={14} stroke={1.7} style={{ color: colors.bronzeHot }} />
        <h3 className="text-xs font-semibold" style={{ fontFamily: 'var(--font-display)' }}>
          Routing
        </h3>
        <button
          type="button"
          aria-label="Refresh local models"
          title="Refresh local models"
          disabled={loading}
          onClick={() => void refreshLocalModels()}
          className="ml-auto rounded-md border p-1 disabled:opacity-40"
          style={{ borderColor: 'var(--color-line-strong)', color: colors.quartzDim }}
        >
          <IconRefresh size={12} stroke={1.8} />
        </button>
      </div>
      <p className="mt-1 text-[10.5px] leading-relaxed" style={{ color: colors.quartzDim }}>
        Ordered rules suggest the brain for each task. Rules are local, editable, and never invoke a classifier.
      </p>

      <div className="mt-2 flex flex-wrap gap-1.5" aria-label="Local model status">
        {localModels.map((status) => (
          <span
            key={status.provider}
            className="rounded-md border px-2 py-1 text-[9.5px]"
            style={{
              borderColor: status.healthy ? `${colors.done}66` : 'var(--color-line-strong)',
              color: status.healthy ? colors.done : colors.quartzDim,
              background: status.healthy ? `${colors.done}0d` : 'rgba(0,0,0,0.08)'
            }}
            title={status.detail ?? status.baseUrl}
          >
            {status.provider === 'lm-studio' ? 'LM Studio' : 'Ollama'} ·{' '}
            {status.healthy ? status.models[0] ?? 'online' : 'offline'}
          </span>
        ))}
      </div>
      <p className="mt-1.5 text-[9.5px] leading-relaxed" style={{ color: colors.quartzDim }}>
        Local routing requires a Claude-Code-compatible Anthropic <code>/v1/messages</code> endpoint.
      </p>

      <label
        className="mt-3 flex min-h-11 items-center gap-2 rounded-lg border px-2.5 py-2 text-[10.5px]"
        style={{ borderColor: 'var(--color-line)', background: 'rgba(0,0,0,0.08)' }}
      >
        <IconShieldLock size={13} stroke={1.7} style={{ color: colors.bronzeHot }} />
        <span className="min-w-0 flex-1">
          <span className="block font-semibold" style={{ color: colors.quartz }}>
            Private space — force local
          </span>
          <span className="block truncate text-[9px]" style={{ color: colors.quartzDim }} title={spaceRoot}>
            {spaceRoot || 'No active space'}
          </span>
        </span>
        <input
          type="checkbox"
          aria-label="Private space — force local"
          checked={spacePrivate}
          disabled={!spaceRoot}
          onChange={(event) => void setSpacePrivate(spaceRoot, event.target.checked)}
          className="size-4 accent-[#CBA25A]"
        />
      </label>

      <div className="mt-3 space-y-2">
        {rules.map((rule) => (
          <fieldset
            key={rule.id}
            className="rounded-lg border p-2.5"
            style={{ borderColor: 'var(--color-line)', background: colors.panel }}
          >
            <legend className="px-1 text-[10px] font-semibold" style={{ color: colors.quartz }}>
              {rule.label}
            </legend>
            <div className="grid grid-cols-[1fr_128px] gap-2">
              <label className="text-[9px]" style={{ color: colors.quartzDim }}>
                {rule.label} keywords
                <input
                  aria-label={`${rule.label} keywords`}
                  value={rule.match.keywords.join(', ')}
                  maxLength={4_000}
                  onChange={(event) => updateRule(rule.id, { keywords: commaList(event.target.value) })}
                  className="mt-1 w-full rounded-md border bg-black/10 px-2 py-1.5 text-[10px] outline-none focus:ring-1"
                  style={{
                    borderColor: 'var(--color-line-strong)',
                    color: colors.quartz,
                    '--tw-ring-color': colors.bronze
                  } as React.CSSProperties}
                />
              </label>
              <label className="text-[9px]" style={{ color: colors.quartzDim }}>
                Target
                <select
                  aria-label={`${rule.label} target`}
                  value={rule.target}
                  onChange={(event) => updateRule(rule.id, { target: event.target.value as RoutingTarget })}
                  className="mt-1 w-full rounded-md border bg-black/10 px-2 py-1.5 text-[10px] outline-none"
                  style={{ borderColor: 'var(--color-line-strong)', color: colors.quartz }}
                >
                  {(Object.keys(TARGET_LABEL) as RoutingTarget[]).map((target) => (
                    <option key={target} value={target}>{TARGET_LABEL[target]}</option>
                  ))}
                </select>
              </label>
            </div>
            <label className="mt-2 block text-[9px]" style={{ color: colors.quartzDim }}>
              Reason
              <input
                aria-label={`${rule.label} reason`}
                value={rule.reason}
                maxLength={300}
                onChange={(event) => updateRule(rule.id, { reason: event.target.value })}
                className="mt-1 w-full rounded-md border bg-black/10 px-2 py-1.5 text-[10px] outline-none"
                style={{ borderColor: 'var(--color-line-strong)', color: colors.quartz }}
              />
            </label>
          </fieldset>
        ))}
      </div>

      <div className="mt-2 flex items-center gap-2">
        <button
          type="button"
          disabled={saving || rules.length === 0}
          onClick={() => void saveRules()}
          className="min-h-11 rounded-md px-3 py-1.5 text-[10px] font-bold disabled:opacity-40"
          style={{ background: colors.bronze, color: colors.page }}
        >
          Save routing rules
        </button>
        {message && <span className="text-[9.5px]" style={{ color: colors.done }}>{message}</span>}
      </div>
      {error && <p role="alert" className="mt-2 text-[9.5px]" style={{ color: colors.error }}>{error}</p>}
    </section>
  )
}
