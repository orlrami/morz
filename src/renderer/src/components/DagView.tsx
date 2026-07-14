import { useEffect, useMemo } from 'react'
import { motion } from 'framer-motion'
import { IconLock } from '@tabler/icons-react'
import type { Task, TaskState } from '@shared/bus'
import { colors, statusColor } from '@/lib/tokens'
import { springs } from '@/lib/springs'
import { subscribeDag, useDagStore } from '@/store/dagStore'

const NODE_W = 220
const NODE_H = 82
const WAVE_GAP = 100
const ROW_GAP = 28
const PAD_X = 36
const PAD_TOP = 58

const STATE_COLOR: Record<TaskState, string> = {
  proposed: 'rgba(238,230,217,0.3)',
  accepted: 'rgba(238,230,217,0.45)',
  working: statusColor.working,
  blocked: statusColor.blocked,
  done: statusColor.done
}

interface PositionedTask {
  task: Task
  depth: number
  x: number
  y: number
  locked: boolean
}

function taskDepths(tasks: Task[]): Map<string, number> {
  const byId = new Map(tasks.map((task) => [task.id, task]))
  const depths = new Map<string, number>()
  const visiting = new Set<string>()

  const visit = (task: Task): number => {
    const known = depths.get(task.id)
    if (known !== undefined) return known
    if (visiting.has(task.id)) return 0
    visiting.add(task.id)
    const parentDepths = task.dependsOn.map((id) => {
      const parent = byId.get(id)
      return parent ? visit(parent) : 0
    })
    visiting.delete(task.id)
    const depth = parentDepths.length === 0 ? 0 : Math.max(...parentDepths) + 1
    depths.set(task.id, depth)
    return depth
  }

  for (const task of tasks) visit(task)
  return depths
}

function positionTasks(tasks: Task[]): PositionedTask[] {
  const depths = taskDepths(tasks)
  const byId = new Map(tasks.map((task) => [task.id, task]))
  const rowsByDepth = new Map<number, number>()

  return tasks.map((task) => {
    const depth = depths.get(task.id) ?? 0
    const row = rowsByDepth.get(depth) ?? 0
    rowsByDepth.set(depth, row + 1)
    return {
      task,
      depth,
      x: PAD_X + depth * (NODE_W + WAVE_GAP),
      y: PAD_TOP + row * (NODE_H + ROW_GAP),
      locked: task.dependsOn.some((id) => byId.get(id)?.state !== 'done')
    }
  })
}

function edgePath(source: PositionedTask, target: PositionedTask): string {
  const x1 = source.x + NODE_W
  const y1 = source.y + NODE_H / 2
  const x2 = target.x
  const y2 = target.y + NODE_H / 2
  const bend = Math.max(36, (x2 - x1) / 2)
  return `M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`
}

export function DagView(): JSX.Element {
  const tasks = useDagStore((state) => state.tasks)
  const recentlyCompleted = useDagStore((state) => state.recentlyCompleted)
  const error = useDagStore((state) => state.error)

  useEffect(() => subscribeDag(), [])

  const nodes = useMemo(() => positionTasks(tasks), [tasks])
  const nodeById = useMemo(() => new Map(nodes.map((node) => [node.task.id, node])), [nodes])
  const maxDepth = Math.max(0, ...nodes.map((node) => node.depth))
  const maxRows = Math.max(
    1,
    ...Array.from({ length: maxDepth + 1 }, (_, depth) => nodes.filter((node) => node.depth === depth).length)
  )
  const width = PAD_X * 2 + (maxDepth + 1) * NODE_W + maxDepth * WAVE_GAP
  const height = PAD_TOP + maxRows * NODE_H + Math.max(0, maxRows - 1) * ROW_GAP + 32

  return (
    <section
      className="relative min-h-0 min-w-0 flex-1 overflow-auto"
      style={{ background: colors.page }}
      aria-label="Dependency graph"
    >
      {error && (
        <p className="p-6 text-xs" style={{ color: colors.error }} role="alert">
          {error}
        </p>
      )}
      {!error && tasks.length === 0 && (
        <p className="p-6 text-xs" style={{ color: colors.quartzDim }}>
          No board tasks yet.
        </p>
      )}
      {tasks.length > 0 && (
        <div className="relative" style={{ width, height }}>
          {Array.from({ length: maxDepth + 1 }, (_, depth) => (
            <div
              key={depth}
              className="pointer-events-none absolute top-3 font-mono text-[10px] uppercase tracking-[0.12em]"
              style={{ left: PAD_X + depth * (NODE_W + WAVE_GAP), color: colors.quartzDim }}
            >
              Wave {depth + 1}
            </div>
          ))}

          <svg className="pointer-events-none absolute inset-0" width={width} height={height} aria-hidden>
            {nodes.flatMap((target) =>
              target.task.dependsOn.map((sourceId) => {
                const source = nodeById.get(sourceId)
                if (!source) return null
                const path = edgePath(source, target)
                const pulse = recentlyCompleted.includes(sourceId)
                return (
                  <g
                    key={`${sourceId}-${target.task.id}`}
                    data-dag-edge-from={sourceId}
                    data-dag-edge-to={target.task.id}
                    data-pulse={String(pulse)}
                  >
                    <path
                      d={path}
                      fill="none"
                      stroke={source.task.state === 'done' ? 'rgba(34,197,94,0.48)' : 'rgba(238,230,217,0.18)'}
                      strokeWidth={1.5}
                      strokeDasharray={source.task.state === 'done' ? undefined : '4 5'}
                    />
                    {pulse && (
                      <circle r={3} fill={colors.bronzeHot}>
                        <animateMotion dur="1.4s" repeatCount="indefinite" path={path} />
                      </circle>
                    )}
                  </g>
                )
              })
            )}
          </svg>

          {nodes.map(({ task, x, y, locked }, index) => {
            const stateColor = STATE_COLOR[task.state]
            return (
              <motion.article
                key={task.id}
                initial={{ opacity: 0, scale: 0.94 }}
                animate={{ opacity: 1, scale: 1, transition: { ...springs.panel, delay: index * 0.025 } }}
                className="absolute rounded-xl border p-3"
                style={{
                  left: x,
                  top: y,
                  width: NODE_W,
                  height: NODE_H,
                  background: colors.panel,
                  borderColor:
                    task.state === 'working' || task.state === 'blocked' || task.state === 'done'
                      ? stateColor
                      : 'var(--color-line-strong)',
                  boxShadow: locked ? 'inset 0 0 0 1px rgba(245,158,11,0.18)' : undefined
                }}
                data-dag-task-id={task.id}
                data-task-state={task.state}
                data-locked={String(locked)}
                data-blocked-pulse={String(task.state === 'blocked')}
                aria-label={`${task.title}, ${task.state}${locked ? ', locked' : ''}`}
              >
                {task.state === 'blocked' && (
                  <motion.span
                    className="pointer-events-none absolute inset-0 rounded-xl border"
                    style={{ borderColor: statusColor.blocked }}
                    animate={{ opacity: [0.78, 0.2, 0.78] }}
                    transition={{ duration: 1.8, repeat: Infinity, ease: 'easeInOut' }}
                    aria-hidden
                  />
                )}
                <div className="flex min-w-0 items-center gap-2">
                  <span
                    data-state-dot
                    className="size-2 shrink-0 rounded-full"
                    style={{ backgroundColor: stateColor, boxShadow: `0 0 8px ${stateColor}66` }}
                  />
                  <h2
                    className="min-w-0 truncate text-[11.5px] font-semibold"
                    style={{ fontFamily: 'var(--font-display)' }}
                  >
                    {task.title}
                  </h2>
                  {locked && (
                    <span
                      className="ml-auto flex size-6 shrink-0 items-center justify-center rounded-md border"
                      style={{ color: statusColor.blocked, borderColor: 'rgba(245,158,11,0.35)' }}
                      title="Waiting for dependencies"
                    >
                      <IconLock size={12} stroke={1.8} aria-hidden />
                    </span>
                  )}
                </div>
                <p className="mt-2 truncate font-mono text-[9.5px]" style={{ color: colors.quartzDim }}>
                  {task.assignee ?? task.createdBy}
                </p>
                <p className="font-mono text-[9.5px] uppercase" style={{ color: stateColor }}>
                  {locked ? 'locked · ' : ''}{task.state}
                </p>
              </motion.article>
            )
          })}
        </div>
      )}
    </section>
  )
}
