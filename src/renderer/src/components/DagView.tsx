import { motion } from 'framer-motion'
import { dagNodes, dagEdges, cliTint, cliLabel, type DagNode } from '@/lib/mock'
import { colors, statusColor } from '@/lib/tokens'
import { springs } from '@/lib/springs'

const NODE_W = 200
const NODE_H = 64
const WAVE_X: Record<1 | 2, number> = { 1: 40, 2: 340 }
const NODE_Y = (indexInWave: number): number => 48 + indexInWave * 96

function nodePos(node: DagNode): { x: number; y: number } {
  const wave = dagNodes.filter((n) => n.wave === node.wave)
  return { x: WAVE_X[node.wave], y: NODE_Y(wave.indexOf(node)) }
}

const NODE_STATUS: Record<DagNode['status'], string> = {
  done: statusColor.done,
  working: statusColor.working,
  blocked: statusColor.blocked,
  pending: 'rgba(238,230,217,0.25)'
}

/*
 * Dependency DAG — wave execution. Nodes carry agent tint + status ring +
 * a machine-checkable Definition of Done; a wave starts only when its
 * predecessors report verified-done.
 */
export function DagView(): JSX.Element {
  return (
    <section
      className="relative min-w-0 flex-1 overflow-auto"
      style={{ background: colors.page }}
      aria-label="Dependency graph"
    >
      {/* wave headers */}
      <div className="pointer-events-none absolute left-0 top-0 flex w-[620px] px-10 pt-3 text-[10px] uppercase tracking-wider">
        <span style={{ color: statusColor.done, width: 300 }}>Wave 1 — complete</span>
        <span style={{ color: colors.quartzDim }}>Wave 2 — running · gated on wave 1</span>
      </div>

      <svg className="absolute inset-0 h-[420px] w-[620px]" aria-hidden>
        {dagEdges.map(([from, to]) => {
          const a = dagNodes.find((n) => n.id === from)!
          const b = dagNodes.find((n) => n.id === to)!
          const pa = nodePos(a)
          const pb = nodePos(b)
          const x1 = pa.x + NODE_W
          const y1 = pa.y + NODE_H / 2
          const x2 = pb.x
          const y2 = pb.y + NODE_H / 2
          const done = a.status === 'done'
          return (
            <path
              key={`${from}-${to}`}
              d={`M ${x1} ${y1} C ${x1 + 50} ${y1}, ${x2 - 50} ${y2}, ${x2} ${y2}`}
              fill="none"
              stroke={done ? 'rgba(34,197,94,0.45)' : 'rgba(238,230,217,0.15)'}
              strokeWidth={1.5}
              strokeDasharray={done ? 'none' : '4 4'}
            />
          )
        })}
      </svg>

      {dagNodes.map((node, i) => {
        const pos = nodePos(node)
        return (
          <motion.div
            key={node.id}
            initial={{ opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1, transition: { ...springs.panel, delay: i * 0.03 } }}
            className="absolute rounded-xl border p-2.5"
            style={{
              left: pos.x,
              top: pos.y,
              width: NODE_W,
              height: NODE_H,
              background: colors.panel,
              borderColor:
                node.status === 'blocked' ? 'rgba(245,158,11,0.55)' : 'var(--color-line-strong)'
            }}
          >
            {node.status === 'blocked' && (
              <motion.span
                className="absolute inset-0 rounded-xl border"
                style={{ borderColor: statusColor.blocked }}
                animate={{ opacity: [0.7, 0.2, 0.7] }}
                transition={{ duration: 1.8, repeat: Infinity, ease: 'easeInOut' }}
                aria-hidden
              />
            )}
            <div className="flex items-center gap-1.5">
              <span className="size-2 rounded-full" style={{ background: NODE_STATUS[node.status] }} />
              <span className="truncate text-[11.5px] font-semibold" style={{ fontFamily: 'var(--font-display)' }}>
                {node.label}
              </span>
              <span className="ml-auto text-[9px] font-medium" style={{ color: cliTint[node.cli] }}>
                {cliLabel[node.cli]}
              </span>
            </div>
            <p className="mt-1 truncate text-[10px]" style={{ color: colors.quartzDim }}>
              DoD: {node.dod}
            </p>
            <p className="text-[9.5px]" style={{ color: NODE_STATUS[node.status] }}>
              {node.status}
            </p>
          </motion.div>
        )
      })}
    </section>
  )
}
