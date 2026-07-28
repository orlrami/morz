import { useEffect, useState } from 'react'
import { motion } from 'framer-motion'
import { IconCheck, IconRefresh, IconTrash, IconUserMinus, IconUserPlus } from '@tabler/icons-react'
import type { PlannedAgent, PlannedCli, SpawnPlan } from '@shared/spawn-plan'
import { PLANNER_MODEL_CATALOG } from '@shared/models'
import type {
  PlanTeamOptions,
  RouteDecision,
  RoutingTarget,
  StoredPlanAmendment,
  StoredSpawnPlan
} from '@shared/ipc'
import { colors } from '@/lib/tokens'
import { useModeStore } from '@/store/modeStore'
import { useRoutingStore } from '@/store/routingStore'
import { roleKey, usePlanTeamStore } from '@/store/planTeamStore'
import { useConnectionsStore } from '@/store/connectionsStore'

const ROUTE_LABEL: Record<RoutingTarget, string> = {
  agy: 'Antigravity',
  codex: 'Codex',
  claude: 'Claude',
  local: 'a local model'
}

function routeCli(target: RoutingTarget): 'agy' | 'codex' | 'claude' {
  return target === 'local' ? 'claude' : target
}

// w15/plan-route-optin — a saved per-role default surfaces as an opt-in chip,
// shaped like a rule decision so both share one suggestion pipeline.
const SAVED_DEFAULT_RULE_ID = 'saved-default'

function savedDefaultDecision(cli: Exclude<PlannedCli, 'opencode'>): RouteDecision {
  return {
    target: cli,
    reason: 'You picked this model for the role last time.',
    rule: {
      id: SAVED_DEFAULT_RULE_ID,
      label: 'Saved default',
      match: { keywords: [], regex: [] },
      target: cli,
      reason: 'You picked this model for the role last time.',
      enabled: true
    }
  }
}

// w14/multi-agent-plan — per-cli avatar tint + display label for team rows.
const CLI_META: Record<PlannedCli, { label: string; tint: string }> = {
  claude: { label: 'Claude', tint: colors.bronze },
  codex: { label: 'Codex', tint: colors.working },
  agy: { label: 'Antigravity', tint: colors.done },
  opencode: { label: 'OpenCode', tint: colors.quartzDim }
}

const PLAN_CLIS: readonly PlannedCli[] = ['claude', 'codex', 'agy', 'opencode']
const MAX_TEAM_AGENTS = 8

interface PlanCardProps {
  record: StoredSpawnPlan
  busy: boolean
  onUpdate(plan: SpawnPlan, expectedHash: string): Promise<void>
  onApprove(planHash: string): Promise<void>
  onDiscard(planHash: string): Promise<void>
  /** w14/multi-agent-plan — re-plan the same goal with team constraints. */
  onReplan?(options: PlanTeamOptions): Promise<void>
}

export function PlanCard({
  record,
  busy,
  onUpdate,
  onApprove,
  onDiscard,
  onReplan
}: PlanCardProps): JSX.Element {
  const [draft, setDraft] = useState(record.plan)
  const [suggestions, setSuggestions] = useState<Map<number, RouteDecision>>(new Map())
  // w14/multi-agent-plan — the recommendation only rides on the plan response,
  // so keep it per plan id across hash-changing edits.
  const [teamRec, setTeamRec] = useState<{ planId: string; size: number; rationale: string } | null>(
    null
  )
  const [sizeChoice, setSizeChoice] = useState('auto')
  const mode = useModeStore((state) => state.mode)
  const routeTask = useRoutingStore((state) => state.routeTask)
  // w14/multi-agent-plan — remembered per-role model defaults + connection models.
  const teamDefaults = usePlanTeamStore((state) => state.defaults)
  const rememberDefault = usePlanTeamStore((state) => state.remember)
  const connections = useConnectionsStore((state) => state.connections)
  const startConnections = useConnectionsStore((state) => state.start)
  const hasUnsavedEdits = JSON.stringify(draft.agents) !== JSON.stringify(record.plan.agents)

  useEffect(() => setDraft(record.plan), [record.plan])
  useEffect(() => setSizeChoice('auto'), [record.plan.id])
  useEffect(() => startConnections(), [startConnections])
  useEffect(() => {
    if (record.recommendedTeamSize) {
      setTeamRec({
        planId: record.plan.id,
        size: record.recommendedTeamSize,
        rationale: record.teamRationale ?? ''
      })
    } else {
      setTeamRec((current) => (current && current.planId === record.plan.id ? current : null))
    }
  }, [record])

  // w8/routing — rules-only suggestions; no model/classifier call occurs here.
  // w15/plan-route-optin — NOTHING rewrites the planner's proposal silently.
  // The planner's per-agent cli stands as proposed; saved per-role defaults and
  // rule routes both surface as opt-in chips (saved default outranks the rule),
  // so the plan the user approves is exactly the plan the card shows.
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
      record.plan.agents.forEach((agent, index) => {
        const preferred = teamDefaults[roleKey(agent.role)]
        if (preferred && preferred !== 'opencode' && preferred !== agent.cli) {
          next.set(index, savedDefaultDecision(preferred))
          return
        }
        const decision = decisions[index]
        if (!decision) return
        const compatibleLocal = decision.target === 'local' && agent.cli === 'claude'
        if (!compatibleLocal && routeCli(decision.target) !== agent.cli) next.set(index, decision)
      })
      setSuggestions(next)
    })
    return () => {
      cancelled = true
    }
  }, [mode, record.plan, record.state, routeTask, teamDefaults])

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

  // w14/multi-agent-plan — model swap persists as the role's new default.
  const changeCli = (index: number, cli: PlannedCli): void => {
    const agent = draft.agents[index]
    if (!agent || agent.cli === cli) return
    rememberDefault(agent.role, cli)
    void onUpdate(
      {
        ...draft,
        agents: draft.agents.map((item, i) =>
          i === index ? { ...item, cli, model: null } : item
        )
      },
      record.plan.planHash
    )
  }

  const editModel = (index: number, model: string): void => {
    setDraft((current) => ({
      ...current,
      agents: current.agents.map((agent, i) =>
        i === index ? { ...agent, model: model.trim() || null } : agent
      )
    }))
  }

  const saveModel = (index: number): void => {
    const model = draft.agents[index]?.model ?? null
    if (model === (record.plan.agents[index]?.model ?? null)) return
    void onUpdate(draft, record.plan.planHash)
  }

  // w14/multi-agent-plan — append a blank specialist the user seeds via prompt.
  const addAgent = (): void => {
    if (draft.agents.length >= MAX_TEAM_AGENTS) return
    let n = draft.agents.length + 1
    let agentId = `agent-${n}`
    while (draft.agents.some((agent) => agent.agentId === agentId)) {
      n += 1
      agentId = `agent-${n}`
    }
    const added: PlannedAgent = {
      agentId,
      cli: teamDefaults[roleKey('agent')] ?? 'claude',
      model: null,
      role: `Agent ${n}`,
      branch: `run/plan/${record.plan.id.slice(0, 8).toLowerCase()}-${agentId}`,
      worktree: null,
      cwd: '',
      promptSeed: "Describe this agent's task before approving the plan.",
      dependsOn: [],
      port: null
    }
    void onUpdate({ ...draft, agents: [...draft.agents, added] }, record.plan.planHash)
  }

  // w14/multi-agent-plan — smaller trims the team; larger re-plans with the
  // required size; Auto leaves the orchestrator's proposal untouched.
  const applyTeamSize = (value: string): void => {
    setSizeChoice(value)
    if (value === 'auto') return
    const size = Number(value)
    if (!Number.isInteger(size) || size === draft.agents.length) return
    if (size < draft.agents.length) {
      void onUpdate({ ...draft, agents: draft.agents.slice(0, size) }, record.plan.planHash)
    } else if (onReplan) {
      void onReplan({
        teamSize: size,
        team: draft.agents.map(({ role, cli }) => ({ role, cli }))
      })
    }
  }

  const replanWithTeam = (): void => {
    if (!onReplan) return
    void onReplan({
      teamSize: draft.agents.length,
      team: draft.agents.map(({ role, cli }) => ({ role, cli }))
    })
  }

  const modelLabel = (cli: PlannedCli): string => {
    const model = connections.find((connection) => connection.id === cli)?.model
    return model ? `${CLI_META[cli].label} · ${model}` : CLI_META[cli].label
  }

  const applySuggestion = (index: number): void => {
    const suggestion = suggestions.get(index)
    if (!suggestion) return
    changeCli(index, routeCli(suggestion.target))
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

      {/* w14/multi-agent-plan — team proposal header + size control */}
      {teamRec && (
        <p
          data-testid="team-recommendation"
          className="mt-1.5 rounded-md border px-2 py-1 text-[9.5px] leading-snug"
          style={{ borderColor: `${colors.bronze}55`, color: colors.bronzeHot, background: `${colors.bronze}0d` }}
        >
          Orchestrator recommends {teamRec.size} agent{teamRec.size === 1 ? '' : 's'}
          {teamRec.rationale ? ` — ${teamRec.rationale}` : ''}
        </p>
      )}
      {record.state === 'PROPOSED' && (
        <div className="mt-1.5 flex items-center gap-1.5">
          <span className="text-[9px] font-semibold uppercase tracking-wide" style={{ color: colors.quartzDim }}>
            Team size
          </span>
          <select
            aria-label="Team size"
            value={sizeChoice}
            disabled={busy}
            onChange={(event) => applyTeamSize(event.target.value)}
            className="rounded-md border bg-black/10 px-1 py-0.5 text-[9px] font-semibold outline-none focus:ring-1 disabled:opacity-40"
            style={{
              borderColor: 'var(--color-line-strong)',
              color: colors.quartz,
              '--tw-ring-color': colors.bronze
            } as React.CSSProperties}
          >
            <option value="auto">Auto</option>
            {[1, 2, 3, 4, 5, 6].map((size) => (
              <option key={size} value={size}>
                {size}
              </option>
            ))}
          </select>
          <button
            type="button"
            aria-label="Add agent"
            title={draft.agents.length >= MAX_TEAM_AGENTS ? 'A plan holds at most 8 agents' : 'Add an agent'}
            disabled={busy || draft.agents.length >= MAX_TEAM_AGENTS}
            onClick={addAgent}
            className="ml-auto flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[9px] font-semibold disabled:cursor-not-allowed disabled:opacity-40"
            style={{ borderColor: 'var(--color-line-strong)', color: colors.quartz }}
          >
            <IconUserPlus size={11} stroke={1.8} />
            Add agent
          </button>
        </div>
      )}

      <div className="mt-2 space-y-1.5">
        {draft.agents.map((agent, index) => (
          <div
            key={agent.agentId}
            className="rounded-lg border p-2"
            style={{ borderColor: 'var(--color-line)', background: 'rgba(0,0,0,0.1)' }}
          >
            <div className="flex min-w-0 items-center gap-1.5">
              {/* w14/multi-agent-plan — avatar tint follows the assigned cli */}
              <span
                aria-hidden
                className="size-2 shrink-0 rounded-full"
                style={{ background: CLI_META[agent.cli].tint }}
              />
              <span className="truncate text-[11px] font-semibold" style={{ color: colors.quartz }}>
                {agent.role}
              </span>
              <select
                aria-label={`Model for ${agent.role}`}
                value={agent.cli}
                disabled={busy || record.state !== 'PROPOSED'}
                onChange={(event) => changeCli(index, event.target.value as PlannedCli)}
                className="ml-auto max-w-[130px] shrink-0 rounded-md border bg-black/10 px-1 py-0.5 text-[8.5px] font-semibold outline-none focus:ring-1 disabled:opacity-50"
                style={{
                  borderColor: 'var(--color-line-strong)',
                  color: CLI_META[agent.cli].tint,
                  '--tw-ring-color': colors.bronze
                } as React.CSSProperties}
              >
                {PLAN_CLIS.map((cli) => (
                  <option key={cli} value={cli}>
                    {modelLabel(cli)}
                  </option>
                ))}
              </select>
              {record.state === 'PROPOSED' && (
                <button
                  type="button"
                  aria-label={`Remove ${agent.role}`}
                  title={draft.agents.length <= 1 ? 'A plan needs at least one agent' : `Remove ${agent.role}`}
                  disabled={busy || draft.agents.length <= 1}
                  onClick={() => removeAgent(index)}
                  className="shrink-0 rounded p-0.5 disabled:cursor-not-allowed disabled:opacity-35"
                  style={{ color: colors.quartzDim }}
                >
                  <IconUserMinus size={12} stroke={1.8} />
                </button>
              )}
            </div>
            <div className="mt-1 flex min-w-0 items-center gap-1.5">
              <span className="shrink-0 text-[8px] font-semibold uppercase tracking-wide" style={{ color: colors.quartzDim }}>
                Exact model
              </span>
              <input
                aria-label={`Agent model for ${agent.role}`}
                data-testid={`plan-agent-model-${agent.agentId}`}
                list={`plan-agent-models-${agent.agentId}`}
                value={agent.model ?? ''}
                placeholder="User default"
                disabled={busy || record.state !== 'PROPOSED'}
                onChange={(event) => editModel(index, event.target.value)}
                onBlur={() => saveModel(index)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') event.currentTarget.blur()
                }}
                className="min-w-0 flex-1 rounded-md border bg-black/10 px-1.5 py-0.5 font-mono text-[8.5px] outline-none focus:ring-1 disabled:opacity-50"
                style={{
                  borderColor: 'var(--color-line-strong)',
                  color: colors.quartz,
                  '--tw-ring-color': colors.bronze
                } as React.CSSProperties}
              />
              <datalist id={`plan-agent-models-${agent.agentId}`}>
                {PLANNER_MODEL_CATALOG[agent.cli].models.map((model) => (
                  <option key={model} value={model} />
                ))}
              </datalist>
            </div>
            <code className="mt-0.5 block truncate text-[9px]" style={{ color: colors.quartzDim }} title={agent.branch}>
              {agent.branch}
            </code>
            {mode !== 'manual' && suggestions.has(index) && (
              <div
                data-testid="route-chip"
                className="mt-1.5 flex items-center gap-1 rounded-md border px-2 py-1"
                style={{ borderColor: `${colors.bronze}66`, background: `${colors.bronze}0d` }}
              >
                <span className="min-w-0 flex-1 truncate text-[9px]" style={{ color: colors.bronzeHot }}>
                  {suggestions.get(index)!.rule.id === SAVED_DEFAULT_RULE_ID
                    ? `Use your ${ROUTE_LABEL[suggestions.get(index)!.target]} default for '${agent.role}'?`
                    : `Route '${agent.role}' to ${ROUTE_LABEL[suggestions.get(index)!.target]}?`}
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
          {/* w14/multi-agent-plan — re-plan the same goal keeping this team */}
          {onReplan && (
            <button
              type="button"
              aria-label="Re-plan with this team"
              title="Re-plan the same goal keeping this team size and model split"
              disabled={busy}
              onClick={replanWithTeam}
              className="flex items-center gap-1 rounded-md border px-2 py-1.5 text-[10px] disabled:opacity-50"
              style={{ borderColor: 'var(--color-line-strong)', color: colors.quartz }}
            >
              <IconRefresh size={11} stroke={1.8} />
              Re-plan
            </button>
          )}
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
