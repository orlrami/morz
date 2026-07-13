import { motion } from 'framer-motion'
import { IconArrowRight, IconCheck, IconX } from '@tabler/icons-react'
import type { BusPendingApproval } from '@shared/bus-ipc'
import { colors } from '@/lib/tokens'
import { springs } from '@/lib/springs'

/*
 * Assisted approval chip (0.0.2, w4/handoff) — renders one pending
 * ApprovalRequestPart as a propose-then-approve card. EVERY dispatch in
 * Assisted passes through one of these ("assist, don't take over");
 * Deny leaves the task 'proposed'.
 */
export function ApprovalChip({
  approval,
  onRespond
}: {
  approval: BusPendingApproval
  onRespond(requestId: string, approved: boolean): void
}): JSX.Element {
  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0, transition: springs.float }}
      exit={{ opacity: 0, scale: 0.96, transition: { duration: 0.12 } }}
      className="rounded-xl border p-2.5"
      style={{ background: colors.card, borderColor: 'rgba(245,158,11,0.45)' }}
      role="group"
      aria-label="Handoff approval request"
      data-testid="approval-chip"
    >
      <div className="flex items-center gap-1.5 text-[10px]" style={{ color: colors.blocked }}>
        <span
          className="rounded px-1.5 py-px text-[8.5px] font-extrabold"
          style={{ background: 'rgba(245,158,11,0.16)' }}
        >
          HANDOFF
        </span>
        <span style={{ color: colors.quartzDim }}>{approval.from}</span>
        <IconArrowRight size={10} stroke={2} style={{ color: colors.quartzDim }} />
        <span style={{ color: colors.quartzDim }}>{approval.to}</span>
      </div>
      <p className="mt-1.5 text-xs leading-snug" style={{ color: colors.quartz }}>
        {approval.summary}
      </p>
      <div className="mt-2 flex justify-end gap-1.5">
        <button
          onClick={() => onRespond(approval.requestId, false)}
          className="flex cursor-pointer items-center gap-1 rounded-md border px-2.5 py-1 text-[11px]"
          style={{ borderColor: 'var(--color-line-strong)', color: colors.quartz }}
        >
          <IconX size={12} />
          Deny
        </button>
        <button
          onClick={() => onRespond(approval.requestId, true)}
          className="flex cursor-pointer items-center gap-1 rounded-md px-2.5 py-1 text-[11px] font-semibold"
          style={{
            background: `linear-gradient(180deg, ${colors.bronzeHot}, ${colors.bronze})`,
            color: '#241c0a'
          }}
        >
          <IconCheck size={12} />
          Approve
        </button>
      </div>
    </motion.div>
  )
}
