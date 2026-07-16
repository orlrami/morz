import { useEffect, useMemo, useState } from 'react'
import { motion } from 'framer-motion'
import { cliOfExecutable, type CliId } from '@shared/connections'
import type { PaneInfo, PaneInfoBridge } from '@shared/ipc'
import type { AgentRunState } from '@shared/spawn-plan'
import { cliLabel, cliTint } from '@/lib/cli'
import { emit } from '@/lib/app-events'
import { colors } from '@/lib/tokens'
import { springs } from '@/lib/springs'
import { useLaneStore } from '@/store/laneStore'
import { subscribeRuns, useRunsStore } from '@/store/runsStore'

const ACTIVE_RUN_STATES = new Set<AgentRunState>([
  'queued',
  'spawning',
  'running',
  'blocked',
  'rate-limited',
  'review'
])
const PANE_INFO_POLL_MS = 1_000

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
  cli?: CliId
  state: AgentRunState | 'lane' | 'pane'
}

function paneInfoApi(): PaneInfoBridge | undefined {
  return (window as unknown as { morzPaneInfo?: PaneInfoBridge }).morzPaneInfo
}

function detectedCli(info: PaneInfo): CliId | null {
  for (const candidate of [info.foreground, info.shell, ...info.argv]) {
    if (!candidate) continue
    const cli = cliOfExecutable(candidate.trim().replace(/^['"]|['"]$/g, ''))
    if (cli) return cli
  }
  return null
}

/* w11/lanes-runs — active lanes, dispatched agents, and detected CLI panes. */
export function AgentPillBar(): JSX.Element {
  const lanes = useLaneStore((state) => state.lanes)
  const statuses = useRunsStore((state) => state.statuses)
  const [paneInfo, setPaneInfo] = useState<PaneInfo[]>([])

  useEffect(() => subscribeRuns(), [])
  useEffect(() => {
    const api = paneInfoApi()
    if (!api) return
    let disposed = false
    let loading = false
    const refresh = async (): Promise<void> => {
      if (loading) return
      loading = true
      try {
        const next = await api.list()
        if (!disposed) setPaneInfo(next)
      } catch {
        // A host restart can reject one poll; retain the last honest snapshot.
      } finally {
        loading = false
      }
    }
    void refresh()
    const timer = window.setInterval(() => void refresh(), PANE_INFO_POLL_MS)
    return () => {
      disposed = true
      window.clearInterval(timer)
    }
  }, [])

  const agents = useMemo<AgentPill[]>(() => {
    const agentIds = new Set<string>()
    const paneIds = new Set<string>()
    const pills: AgentPill[] = lanes.map((lane) => ({
      key: `lane:${lane.agentId}`,
      agentId: lane.agentId,
      paneId: lane.paneId,
      cli: 'claude',
      state: 'lane'
    }))
    for (const lane of lanes) {
      agentIds.add(lane.agentId)
      paneIds.add(lane.paneId)
    }

    for (const status of Object.values(statuses)) {
      for (const [agentId, state] of Object.entries(status.agents)) {
        if (!ACTIVE_RUN_STATES.has(state) || agentIds.has(agentId)) continue
        const detail = status.agentsDetail?.[agentId]
        pills.push({
          key: `${status.runId}:${agentId}`,
          agentId,
          paneId: detail?.paneId,
          cli: detail?.cli,
          state
        })
        agentIds.add(agentId)
        if (detail?.paneId) paneIds.add(detail.paneId)
      }
    }

    for (const info of paneInfo) {
      if (paneIds.has(info.paneId)) continue
      const cli = detectedCli(info)
      if (!cli) continue
      pills.push({
        key: `pane:${info.paneId}`,
        agentId: info.paneId,
        paneId: info.paneId,
        cli,
        state: 'pane'
      })
      paneIds.add(info.paneId)
      agentIds.add(info.paneId)
    }
    return pills
  }, [lanes, paneInfo, statuses])

  if (agents.length === 0) {
    return (
      <div
        className="flex h-7 shrink-0 items-center border-b px-3 text-[10px]"
        style={{ background: colors.page, borderColor: 'var(--color-line)', color: colors.quartzDim }}
        role="status"
      >
        No active agents.
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
        const stateColor =
          agent.state === 'lane'
            ? colors.bronzeHot
            : agent.state === 'pane'
              ? colors.working
              : RUN_STATE_COLOR[agent.state]
        const focusable = Boolean(agent.paneId)
        const model = agent.cli ? cliLabel[agent.cli] : 'Agent'
        return (
          <motion.button
            key={agent.key}
            type="button"
            role="tab"
            disabled={!focusable}
            title={focusable ? `Focus ${agent.agentId}` : `${agent.agentId} has no visible pane`}
            aria-label={`${agent.agentId}: ${model}, ${agent.state}`}
            data-testid="agent-pill"
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
            {agent.cli && (
              <span
                className="rounded-md border px-1.5 py-px font-mono text-[8px] font-medium"
                style={{ borderColor: `${tint}55`, color: tint }}
              >
                {cliLabel[agent.cli]}
              </span>
            )}
            <span
              className="size-1.5 rounded-full"
              style={{ background: stateColor, boxShadow: `0 0 6px ${stateColor}66` }}
              title={agent.state === 'lane' ? 'active lane' : agent.state === 'pane' ? 'live CLI pane' : agent.state}
            />
          </motion.button>
        )
      })}
    </div>
  )
}
