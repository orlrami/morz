import { useMemo } from 'react'
import { motion } from 'framer-motion'
import type { AgentRunState, PlannedCli } from '@shared/spawn-plan'
import { cliTint } from '@/lib/cli'
import { emit } from '@/lib/app-events'
import { colors } from '@/lib/tokens'
import { springs } from '@/lib/springs'
import { useLaneStore } from '@/store/laneStore'
import { useRunsStore } from '@/store/runsStore'

const RUN_STATE_COLOR: Record<AgentRunState, string> = {
  queued: colors.quartzDim,
  spawning: colors.bronze,
  running: colors.working,
  blocked: colors.blocked,
  'rate-limited': colors.warning,
  review: colors.bronzeHot,
  done: colors.done,
  failed: colors.error,
  cancelled: colors.quartzDim
}

interface AgentPill {
  key: string
  agentId: string
  paneId?: string
  cli?: PlannedCli
  state: AgentRunState | 'lane'
}

/* Active lane and dispatcher truth only; no Phase-0 agents are synthesized. */
export function AgentPillBar(): JSX.Element {
  const lanes = useLaneStore((state) => state.lanes)
  const statuses = useRunsStore((state) => state.statuses)

  const agents = useMemo<AgentPill[]>(() => {
    const laneIds = new Set(lanes.map((lane) => lane.agentId))
    const pills: AgentPill[] = lanes.map((lane) => ({
      key: `lane:${lane.agentId}`,
      agentId: lane.agentId,
      paneId: lane.paneId,
      cli: 'claude',
      state: 'lane'
    }))

    for (const status of Object.values(statuses)) {
      for (const [agentId, state] of Object.entries(status.agents)) {
        if (laneIds.has(agentId)) continue
        const detail = status.agentsDetail?.[agentId]
        pills.push({
          key: `${status.runId}:${agentId}`,
          agentId,
          paneId: detail?.paneId,
          cli: detail?.cli,
          state
        })
      }
    }
    return pills
  }, [lanes, statuses])

  if (agents.length === 0) {
    return (
      <div
        className="flex h-7 shrink-0 items-center border-b px-3 text-[10px]"
        style={{ background: colors.page, borderColor: 'var(--color-line)', color: colors.quartzDim }}
        role="status"
      >
        No active lanes or dispatched agents.
      </div>
    )
  }

  return (
    <div
      className="flex h-11 shrink-0 items-center gap-2 overflow-x-auto border-b px-3"
      style={{ background: colors.page, borderColor: 'var(--color-line)' }}
      role="tablist"
      aria-label="Active agents"
    >
      {agents.map((agent, index) => {
        const tint = agent.cli ? cliTint[agent.cli] : colors.quartzDim
        const stateColor = agent.state === 'lane' ? colors.bronzeHot : RUN_STATE_COLOR[agent.state]
        const focusable = Boolean(agent.paneId)
        return (
          <motion.button
            key={agent.key}
            type="button"
            role="tab"
            disabled={!focusable}
            title={focusable ? `Focus ${agent.agentId}` : `${agent.agentId} has no visible pane`}
            aria-label={`${agent.agentId}: ${agent.state}`}
            initial={{ opacity: 0, x: 18 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ ...springs.panel, delay: index * 0.035 }}
            whileHover={focusable ? { scale: 1.02 } : undefined}
            onClick={() => agent.paneId && emit('focus-pane', { paneId: agent.paneId })}
            className="flex shrink-0 items-center gap-2 rounded-full border py-1 pl-2 pr-3 disabled:cursor-default"
            style={{ background: colors.panel, borderColor: 'var(--color-line-strong)' }}
          >
            <span
              className="flex size-5 items-center justify-center rounded-full text-[9px] font-bold uppercase"
              style={{ background: `${tint}22`, color: tint }}
              aria-hidden
            >
              {agent.agentId.slice(0, 2)}
            </span>
            <span className="max-w-36 truncate text-[11.5px] font-medium" style={{ fontFamily: 'var(--font-display)' }}>
              {agent.agentId}
            </span>
            <span
              className="size-1.5 rounded-full"
              style={{ background: stateColor, boxShadow: `0 0 6px ${stateColor}66` }}
              title={agent.state === 'lane' ? 'active lane' : agent.state}
            />
          </motion.button>
        )
      })}
    </div>
  )
}
