import { motion } from 'framer-motion'
import type { SpaceCli } from '@/store/spaceStore'
import { cliTint } from '@/lib/mock'
import { colors, statusColor } from '@/lib/tokens'
import { springs } from '@/lib/springs'
import { useLaneStore } from '@/store/laneStore'
import { selectActiveSpace, useSpaceStore } from '@/store/spaceStore'

interface ActiveAgent {
  id: string
  name: string
  cli: SpaceCli
  state: 'working' | 'done' | 'idle'
}

function pathKey(path: string): string {
  return path.replace(/[\\/]+$/, '').replace(/\\/g, '/').toLowerCase()
}

function sameRoot(left: string, right: string): boolean {
  return !!left && !!right && pathKey(left) === pathKey(right)
}

/** Active agents come only from real space worktrees and live Claude lanes. */
export function AgentPillBar(): JSX.Element {
  const space = useSpaceStore(selectActiveSpace)
  const gitByRoot = useSpaceStore((state) => state.gitByRoot)
  const lanes = useLaneStore((state) => state.lanes)
  const agents = new Map<string, ActiveAgent>()

  for (const agent of space?.agents ?? []) {
    const git = gitByRoot[agent.root]
    agents.set(agent.id, {
      id: agent.id,
      name: agent.name,
      cli: agent.cli,
      state: !git?.branch ? 'idle' : git.files.length > 0 ? 'working' : 'done'
    })
  }
  for (const lane of lanes) {
    if (!space || !sameRoot(space.root, lane.cwd)) continue
    agents.set(lane.agentId, {
      id: lane.agentId,
      name: 'Claude',
      cli: 'claude',
      state: 'working'
    })
  }
  const activeAgents = [...agents.values()]

  return (
    <div
      className="flex h-11 shrink-0 items-center gap-2 overflow-x-auto border-b px-3"
      style={{ background: colors.page, borderColor: 'var(--color-line)' }}
      role="tablist"
      aria-label="Active agents"
    >
      {activeAgents.length === 0 && (
        <span className="text-[10.5px]" style={{ color: colors.quartzDim }}>
          No active agents
        </span>
      )}
      {activeAgents.map((agent, index) => (
        <motion.button
          key={agent.id}
          role="tab"
          initial={{ opacity: 0, x: 24 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ ...springs.panel, delay: index * 0.05 }}
          whileHover={{ scale: 1.02 }}
          className="relative flex shrink-0 cursor-pointer items-center gap-2 rounded-full border py-1 pl-2 pr-3"
          style={{ background: colors.panel, borderColor: 'var(--color-line-strong)' }}
        >
          <span
            className="flex size-5 items-center justify-center rounded-full text-[9px] font-bold uppercase"
            style={{ background: `${cliTint[agent.cli]}22`, color: cliTint[agent.cli] }}
            aria-hidden
          >
            {agent.name.slice(0, 2)}
          </span>
          <span className="text-[11.5px] font-medium" style={{ fontFamily: 'var(--font-display)' }}>
            {agent.name}
          </span>
          <span className="size-1.5 rounded-full" style={{ background: statusColor[agent.state] }} />
        </motion.button>
      ))}

      <span className="ml-auto shrink-0 text-[10.5px]" style={{ color: colors.quartzDim }}>
        {activeAgents.length} active
      </span>
    </div>
  )
}
