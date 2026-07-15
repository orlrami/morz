import { useEffect, useRef, useState } from 'react'
import { motion } from 'framer-motion'
import { IconCheck, IconTrash, IconUserMinus } from '@tabler/icons-react'
import type { SpawnPlan } from '@shared/spawn-plan'
import type { RouteDecision, RoutingTarget, StoredPlanAmendment, StoredSpawnPlan } from '@shared/ipc'
import { colors } from '@/lib/tokens'
import { useModeStore } from '@/store/modeStore'
import { useRoutingStore } from '@/store/routingStore'

const ROUTE_LABEL: Record<RoutingTarget, string> = {
  agy: 'Antigravity',
  codex: 'Codex',
  claude: 'Claude',
  local: 'a local model'
}

function routeCli(target: RoutingTarget): 'agy' | 'codex' | 'claude' {
  return target === 'local' ? 'claude' : target
}

interface PlanCardProps {
  record: StoredSpawnPlan
  busy: boolean
  onUpdate(plan: SpawnPlan, expectedHash: string): Promise<void>
  onApprove(planHash: string): Promise<void>
  onDiscard(planHash: string): Promise<void>
}

export function PlanCard({
  record,
  busy,
  onUpdate,
  onApprove,
  onDiscard
}: PlanCardProps): JSX.Element {
  const [draft, setDraft] = useState(record.plan)
  const [suggestions, setSuggestions] = useState<Map<number, RouteDecision>>(new Map())
  const [autoNotice, setAutoNotice] = useState<string[]>([])
  const autoAppliedHash = useRef('')
  const onUpdateRef = useRef(onUpdate)
  const mode = useModeStore((state) => state.mode)
  const routeTask = useRoutingStore((state) => state.routeTask)
  const hasUnsavedEdits = JSON.stringify(draft.agents) !== JSON.stringify(record.plan.agents)

  useEffect(() => setDraft(record.plan), [record.plan])
  useEffect(() => {
    onUpdateRef.current = onUpdate
  }, [onUpdate])

  // w8/routing — rules-only suggestions; no model/classifier call occurs here.
  useEffect(() => {
    if (mode === 'manual' || record.state !== 'PROPOSED') {
      setSuggestions(new Map())
      return
    }
    let cancelled = false
    void Promise.all(
      record.plan.agents.map((agent) =>
        routeTask(`${agent.role}\n${agent.promptSeed}`, { spaceRoot: record.plan.spaceRoot })
      )
    ).then((decisions) => {
      if (cancelled) return
      const next = new Map<number, RouteDecision>()
      decisions.forEach((decision, index) => {
        const agent = record.plan.agents[index]
        if (!decision || !agent) return
        const compatibleLocal = decision.target === 'local' && agent.cli === 'claude'
        if (!compatibleLocal && routeCli(decision.target) !== agent.cli) next.set(index, decision)
      })
      setSuggestions(next)

      if (mode === 'orchestrated' && next.size > 0 && autoAppliedHash.current !== record.plan.planHash) {
        autoAppliedHash.current = record.plan.planHash
        const agents = record.plan.agents.map((agent, index) => {
          const suggestion = next.get(index)
          return suggestion ? { ...agent, cli: routeCli(suggestion.target) } : agent
        })
        setAutoNotice(
          [...next].map(([index, decision]) =>
            `Auto-routed ${record.plan.agents[index].role} to ${ROUTE_LABEL[decision.target]}`
          )
        )
        void onUpdateRef.current({ ...record.plan, agents }, record.plan.planHash).catch(() => {
          autoAppliedHash.current = ''
        })
      }
    })
    return () => {
      cancelled = true
    }
  }, [mode, record.plan, record.state, routeTask])

  const savePrompt = (index: number): void => {
    const promptSeed = draft.agents[index]?.promptSeed.trim()
    if (!promptSeed || promptSeed === record.plan.agents[index]?.promptSeed) return
    void onUpdate(
      { ...draft, agents: draft.agents.map((agent, i) => (i === index ? { ...agent, promptSeed } : agent)) },
      record.plan.planHash
    )
  }

  const removeAgent = (index: number): void => {
    if (draft.agents.length <= 1) return
    void onUpdate(
      { ...draft, agents: draft.agents.filter((_, i) => i !== index) },
      record.plan.planHash
    )
  }

  const applySuggestion = (index: number): void => {
    const suggestion = suggestions.get(index)
    if (!suggestion) return
    const agents = draft.agents.map((agent, i) =>
      i === index ? { ...agent, cli: routeCli(suggestion.target) } : agent
    )
    void onUpdate({ ...draft, agents }, record.plan.planHash)
  }

  const keepPlannedRoute = (index: number): void => {
    setSuggestions((current) => {
      const next = new Map(current)
      next.delete(index)
      return next
    })
  }

  return (
    <motion.section
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      className="rounded-xl border p-2.5"
      style={{
        borderColor: record.state === 'APPROVED' ? `${colors.done}66` : `${colors.bronze}55`,
        background: `linear-gradient(180deg, ${colors.card}ee, ${colors.card}99)`,
        boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.04), 0 6px 24px rgba(0,0,0,0.16)'
      }}
      aria-label="Spawn plan"
    >
      <div className="flex items-center gap-2">
        <span className="text-[10px] font-extrabold uppercase tracking-[0.12em]" style={{ color: colors.bronzeHot }}>
          {record.state}
        </span>
        <code className="ml-auto text-[9px]" style={{ color: colors.quartzDim }} title={record.plan.planHash}>
          {record.plan.planHash.slice(0, 8)}
        </code>
      </div>
      <p className="mt-1 text-[11px] leading-snug" style={{ color: colors.quartz }}>
        {record.plan.goal}
      </p>
      <code
        className="mt-1 block truncate text-[8.5px]"
        style={{ color: colors.quartzDim }}
        title={record.plan.spaceRoot}
      >
        {record.plan.spaceRoot}
      </code>

      <div className="mt-2 space-y-1.5">
        {autoNotice.map((notice) => (
          <p
            key={notice}
            data-testid="routing-auto-notice"
            className="rounded-md border px-2 py-1 text-[9px]"
            style={{ borderColor: `${colors.working}55`, color: colors.working, background: `${colors.working}0d` }}
          >
            {notice}
          </p>
        ))}
        {draft.agents.map((agent, index) => (
          <div
            key={agent.agentId}
            className="rounded-lg border p-2"
            style={{ borderColor: 'var(--color-line)', background: 'rgba(0,0,0,0.1)' }}
          >
            <div className="flex min-w-0 items-center gap-1.5">
              <span className="truncate text-[11px] font-semibold" style={{ color: colors.quartz }}>
                {agent.role}
              </span>
              <span
                className="shrink-0 rounded px-1 py-px text-[8px] font-bold uppercase"
                style={{ background: `${colors.working}20`, color: colors.working }}
              >
                {agent.cli}
              </span>
              {record.state === 'PROPOSED' && (
                <button
                  type="button"
                  aria-label={`Remove ${agent.role}`}
                  title={draft.agents.length <= 1 ? 'A plan needs at least one agent' : `Remove ${agent.role}`}
                  disabled={busy || draft.agents.length <= 1}
                  onClick={() => removeAgent(index)}
                  className="ml-auto rounded p-0.5 disabled:cursor-not-allowed disabled:opacity-35"
                  style={{ color: colors.quartzDim }}
                >
                  <IconUserMinus size={12} stroke={1.8} />
                </button>
              )}
            </div>
            <code className="mt-0.5 block truncate text-[9px]" style={{ color: colors.quartzDim }} title={agent.branch}>
              {agent.branch}
            </code>
            {mode === 'assisted' && suggestions.has(index) && (
              <div
                className="mt-1.5 flex items-center gap-1 rounded-md border px-2 py-1"
                style={{ borderColor: `${colors.bronze}66`, background: `${colors.bronze}0d` }}
              >
                <span className="min-w-0 flex-1 truncate text-[9px]" style={{ color: colors.bronzeHot }}>
                  Route &apos;{agent.role}&apos; to {ROUTE_LABEL[suggestions.get(index)!.target]}?
                </span>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => applySuggestion(index)}
                  className="rounded px-1.5 py-0.5 text-[8.5px] font-bold disabled:opacity-40"
                  style={{ background: colors.bronze, color: colors.page }}
                >
                  Apply
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => keepPlannedRoute(index)}
                  className="rounded px-1 py-0.5 text-[8.5px] disabled:opacity-40"
                  style={{ color: colors.quartzDim }}
                >
                  Keep
                </button>
              </div>
            )}
            <textarea
              aria-label={`Prompt for ${agent.role}`}
              value={agent.promptSeed}
              readOnly={record.state !== 'PROPOSED'}
              disabled={busy}
              rows={3}
              maxLength={12_000}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  agents: current.agents.map((item, i) =>
                    i === index ? { ...item, promptSeed: event.target.value } : item
                  )
                }))
              }
              onBlur={() => savePrompt(index)}
              className="mt-1.5 w-full resize-y rounded-md border bg-black/10 px-2 py-1.5 text-[10px] leading-relaxed outline-none focus:ring-1 disabled:opacity-60"
              style={{
                borderColor: 'var(--color-line-strong)',
                color: colors.quartz,
                '--tw-ring-color': colors.bronze
              } as React.CSSProperties}
            />
          </div>
        ))}
      </div>

      {record.state === 'PROPOSED' && (
        <div className="mt-2 flex gap-1.5">
          <button
            type="button"
            disabled={busy || hasUnsavedEdits}
            title={hasUnsavedEdits ? 'Save prompt edits before approval' : 'Approve this exact plan hash'}
            onClick={() => void onApprove(record.plan.planHash)}
            className="flex flex-1 items-center justify-center gap-1 rounded-md px-2 py-1.5 text-[10px] font-bold disabled:cursor-wait disabled:opacity-50"
            style={{
              background: `linear-gradient(180deg, ${colors.bronzeHot}, ${colors.bronze})`,
              color: colors.page,
              boxShadow: `0 3px 12px ${colors.bronze}22, inset 0 1px 0 rgba(255,255,255,0.2)`
            }}
          >
            <IconCheck size={12} stroke={2.2} />
            Approve &amp; Run
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void onDiscard(record.plan.planHash)}
            className="flex items-center gap-1 rounded-md border px-2 py-1.5 text-[10px] disabled:opacity-50"
            style={{ borderColor: 'var(--color-line-strong)', color: colors.quartzDim }}
          >
            <IconTrash size={11} stroke={1.8} />
            Discard
          </button>
        </div>
      )}
    </motion.section>
  )
}

export function AmendmentCard({
  record,
  busy,
  onApprove,
  onDiscard
}: {
  record: StoredPlanAmendment
  busy: boolean
  onApprove(hash: string): Promise<void>
  onDiscard(hash: string): Promise<void>
}): JSX.Element {
  const { amendment } = record
  const label = amendment.action.kind === 'add'
    ? `Add ${amendment.action.agent.role}`
    : `Replace ${amendment.action.replaceAgentId} with ${amendment.action.agent.role}`
  return (
    <motion.section
      initial={{ opacity: 0, y: 3 }}
      animate={{ opacity: 1, y: 0 }}
      className="rounded-lg border p-2"
      style={{ borderColor: `${colors.blocked}55`, background: `${colors.blocked}0d` }}
      aria-label="Plan amendment"
    >
      <div className="flex items-center gap-1.5">
        <span className="text-[10px] font-semibold" style={{ color: colors.quartz }}>{label}</span>
        <code className="ml-auto text-[8px]" style={{ color: colors.quartzDim }}>
          {amendment.amendmentHash.slice(0, 8)}
        </code>
      </div>
      <p className="mt-1 line-clamp-2 text-[9.5px]" style={{ color: colors.quartzDim }}>
        {amendment.action.agent.promptSeed}
      </p>
      <div className="mt-1.5 flex gap-1">
        <button
          type="button"
          disabled={busy}
          onClick={() => void onApprove(amendment.amendmentHash)}
          className="rounded px-2 py-1 text-[9px] font-bold disabled:opacity-50"
          style={{ background: colors.bronze, color: colors.page }}
        >
          Approve amendment
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => void onDiscard(amendment.amendmentHash)}
          className="rounded px-2 py-1 text-[9px] disabled:opacity-50"
          style={{ color: colors.quartzDim }}
        >
          Discard
        </button>
      </div>
    </motion.section>
  )
}
