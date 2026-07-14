import { useState } from 'react'
import { IconSparkles } from '@tabler/icons-react'
import { colors } from '@/lib/tokens'
import { useAssistantStore } from '@/store/assistantStore'
import { useModeStore } from '@/store/modeStore'
import { useSpaceStore } from '@/store/spaceStore'
import { PlanCard } from './PlanCard'

/** Assistant input surface. It only mounts in Orchestrated mode and never dispatches directly. */
export function AssistantPanel(): JSX.Element | null {
  const mode = useModeStore((state) => state.mode)
  const spaceRoot = useSpaceStore((state) => state.spaces[0]?.root ?? '')
  const {
    status,
    record,
    busy,
    statusText,
    error,
    propose,
    updatePlan,
    approvePlan,
    discardPlan
  } = useAssistantStore()
  const [goal, setGoal] = useState('')

  if (mode !== 'orchestrated' || status.state !== 'connected') return null

  return (
    <section
      className="mt-3 border-t pt-3"
      style={{ borderColor: 'var(--color-line)' }}
      aria-label="Assistant proposals"
    >
      <div className="flex items-center gap-1.5">
        <IconSparkles size={13} stroke={1.8} style={{ color: colors.bronzeHot }} />
        <h3 className="text-xs font-semibold" style={{ fontFamily: 'var(--font-display)' }}>
          Ask your assistant
        </h3>
      </div>
      <p className="mt-1 text-[10.5px] leading-relaxed" style={{ color: colors.quartzDim }}>
        It can propose a team. Nothing launches until you approve the exact plan hash below.
      </p>

      <form
        className="mt-2 flex gap-1.5"
        onSubmit={(event) => {
          event.preventDefault()
          const trimmed = goal.trim()
          if (trimmed && spaceRoot) void propose(trimmed, spaceRoot)
        }}
      >
        <input
          aria-label="Ask your assistant"
          value={goal}
          onChange={(event) => setGoal(event.target.value)}
          maxLength={4_000}
          placeholder="What should the assistant plan?"
          className="min-w-0 flex-1 rounded-md border bg-black/10 px-2.5 py-2 text-[11px] outline-none focus:ring-1"
          style={{
            borderColor: 'var(--color-line-strong)',
            color: colors.quartz,
            '--tw-ring-color': colors.bronze
          } as React.CSSProperties}
        />
        <button
          type="submit"
          aria-label="Ask assistant"
          disabled={busy || !goal.trim() || !spaceRoot}
          className="rounded-md px-2.5 py-2 text-[10px] font-bold disabled:cursor-not-allowed disabled:opacity-40"
          style={{ background: colors.bronze, color: colors.page }}
        >
          Ask
        </button>
      </form>

      {statusText && (
        <p className="mt-1.5 text-[10px]" style={{ color: colors.bronzeHot }}>
          {statusText}
        </p>
      )}
      {error && (
        <p role="alert" className="mt-1.5 text-[10px] leading-snug" style={{ color: colors.error }}>
          {error}
        </p>
      )}

      {record && (
        <div className="mt-2">
          <PlanCard
            record={record}
            busy={busy}
            onUpdate={updatePlan}
            onApprove={approvePlan}
            onDiscard={discardPlan}
          />
        </div>
      )}
    </section>
  )
}
