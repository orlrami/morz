import { useEffect, useMemo, useState } from 'react'
import { motion } from 'framer-motion'
import {
  IconAlertTriangle,
  IconLoader2,
  IconSend,
  IconShieldCheck,
  IconWand
} from '@tabler/icons-react'
import type { ReviewFinding, ReviewSeverity } from '@shared/ipc'
import { emit } from '@/lib/app-events'
import { colors } from '@/lib/tokens'
import { staggerContainer, staggerItem, springs } from '@/lib/springs'
import { useReviewStore } from '@/store/reviewStore'
import { useSpaceStore } from '@/store/spaceStore'

const SEVERITY: Record<ReviewSeverity, { color: string; label: string }> = {
  critical: { color: colors.error, label: 'critical' },
  high: { color: colors.error, label: 'high' },
  medium: { color: colors.warning, label: 'medium' },
  low: { color: colors.working, label: 'low' },
  info: { color: colors.quartzDim, label: 'info' }
}

function findingKey(finding: ReviewFinding): string {
  return `${finding.file}:${finding.line}:${finding.title}`
}

function absolutePath(cwd: string, file: string): string {
  if (/^(?:[A-Za-z]:[\\/]|\/)/.test(file)) return file
  const separator = cwd.includes('\\') ? '\\' : '/'
  return `${cwd.replace(/[\\/]+$/, '')}${separator}${file.replace(/^[\\/]+/, '').replace(/[\\/]/g, separator)}`
}

export function ReviewerPanel(): JSX.Element {
  const spaces = useSpaceStore((state) => state.spaces)
  const {
    candidates,
    selectedId,
    result,
    loading,
    error,
    sentFinding,
    start,
    select,
    run,
    sendToAgent
  } = useReviewStore()
  const [selectedFinding, setSelectedFinding] = useState(0)

  useEffect(() => start(spaces), [spaces, start])
  useEffect(() => setSelectedFinding(0), [result?.id])

  const candidate = useMemo(
    () => candidates.find((item) => item.id === selectedId) ?? null,
    [candidates, selectedId]
  )
  const active = result?.findings[selectedFinding] ?? null

  const openFinding = (finding: ReviewFinding): void => {
    if (!result) return
    emit('open-file', {
      path: absolutePath(result.cwd, finding.file),
      line: finding.line
    })
  }

  return (
    <section
      className="flex min-w-0 flex-1 flex-col"
      style={{ background: colors.page }}
      aria-label="Review"
    >
      <header
        className="flex flex-wrap items-center gap-2 border-b px-4 py-3"
        style={{ borderColor: 'var(--color-line)', background: colors.panel }}
      >
        <IconShieldCheck size={16} stroke={1.5} style={{ color: colors.bronzeHot }} />
        <div className="mr-2 min-w-[150px]">
          <h1 className="text-xs font-semibold" style={{ fontFamily: 'var(--font-display)' }}>
            Cross-model review
          </h1>
          <p className="text-[9.5px]" style={{ color: colors.quartzDim }}>
            Non-author brain, refute-first
          </p>
        </div>
        <select
          aria-label="Review run"
          value={selectedId ?? ''}
          onChange={(event) => select(event.target.value)}
          disabled={loading || candidates.length === 0}
          className="min-w-[260px] flex-1 rounded-[8px] border px-3 py-2 font-mono text-[10.5px] outline-none"
          style={{
            borderColor: 'var(--color-line-strong)',
            background: colors.card,
            color: colors.quartz
          }}
        >
          {candidates.length === 0 && <option value="">No completed commit artifacts</option>}
          {candidates.map((item) => (
            <option key={item.id} value={item.id}>
              {item.branch} — {item.label} ({item.author})
            </option>
          ))}
        </select>
        <motion.button
          whileHover={candidate && !loading ? { scale: 1.02 } : undefined}
          transition={springs.snappy}
          onClick={() => void run()}
          disabled={!candidate || loading}
          className="flex min-h-9 cursor-pointer items-center gap-1.5 rounded-[8px] px-3.5 py-2 text-xs font-semibold disabled:cursor-not-allowed disabled:opacity-40"
          style={{
            background: `linear-gradient(180deg, ${colors.bronzeHot}, ${colors.bronze})`,
            color: '#241c0a',
            fontFamily: 'var(--font-display)'
          }}
        >
          {loading ? <IconLoader2 className="animate-spin" size={14} /> : <IconShieldCheck size={14} />}
          {loading ? 'Reviewing…' : 'Run review'}
        </motion.button>
      </header>

      {error && (
        <div
          role="alert"
          className="m-3 flex items-start gap-2 rounded-[8px] border px-3 py-2 text-xs"
          style={{ borderColor: `${colors.error}66`, background: `${colors.error}12`, color: colors.error }}
        >
          <IconAlertTriangle size={14} className="mt-px shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {!result && !loading && !error && (
        <div className="flex flex-1 items-center justify-center p-8 text-center">
          <div className="max-w-sm">
            <IconShieldCheck size={28} stroke={1.2} className="mx-auto" style={{ color: colors.quartzDim }} />
            <p className="mt-3 text-sm" style={{ color: colors.quartz }}>
              {candidate ? 'Ready to challenge this commit artifact.' : 'No reviewable run found.'}
            </p>
            <p className="mt-1 text-[10.5px] leading-relaxed" style={{ color: colors.quartzDim }}>
              Completed task artifacts appear here when their author agent and worktree are known.
            </p>
          </div>
        </div>
      )}

      {loading && (
        <div className="flex flex-1 items-center justify-center gap-2 text-xs" style={{ color: colors.quartzDim }}>
          <IconLoader2 className="animate-spin" size={16} />
          Refuting the diff with the non-author model…
        </div>
      )}

      {result && (
        <div className="flex min-h-0 flex-1">
          <aside
            className="flex w-[320px] shrink-0 flex-col border-r"
            style={{ borderColor: 'var(--color-line)' }}
          >
            <div className="flex items-center gap-2 border-b px-3 py-2" style={{ borderColor: 'var(--color-line)' }}>
              <span className="text-[10px]" style={{ color: colors.quartzDim }}>
                {result.findings.length} {result.findings.length === 1 ? 'finding' : 'findings'} · {result.reviewer}
              </span>
              {result.sameModelReview && (
                <span
                  className="ml-auto rounded-full px-2 py-0.5 text-[8.5px] font-bold uppercase"
                  style={{ background: `${colors.warning}1f`, color: colors.warning }}
                >
                  same-model review
                </span>
              )}
            </div>
            {result.findings.length === 0 ? (
              <p className="p-4 text-xs leading-relaxed" style={{ color: colors.quartzDim }}>
                No evidence-backed bugs found in this diff.
              </p>
            ) : (
              <motion.ul
                variants={staggerContainer}
                initial="hidden"
                animate="show"
                className="flex-1 overflow-y-auto p-2"
              >
                {result.findings.map((finding, index) => (
                  <motion.li key={findingKey(finding)} variants={staggerItem}>
                    <button
                      data-testid="review-finding"
                      onClick={() => setSelectedFinding(index)}
                      className="mb-1 w-full cursor-pointer rounded-[9px] border p-2.5 text-left transition-colors"
                      style={{
                        borderColor: selectedFinding === index ? 'rgba(203,162,90,0.45)' : 'transparent',
                        background: selectedFinding === index ? colors.card : 'transparent'
                      }}
                    >
                      <div className="flex items-center gap-2">
                        <span
                          data-testid="severity-chip"
                          className="rounded-full px-1.5 py-px text-[8.5px] font-bold uppercase"
                          style={{
                            background: `${SEVERITY[finding.severity].color}22`,
                            color: SEVERITY[finding.severity].color
                          }}
                        >
                          {SEVERITY[finding.severity].label}
                        </span>
                        <span className="truncate font-mono text-[10px]" style={{ color: colors.quartzDim }}>
                          {finding.file}:{finding.line}
                        </span>
                      </div>
                      <p className="mt-1 text-xs" style={{ color: colors.quartz }}>
                        {finding.title}
                      </p>
                    </button>
                  </motion.li>
                ))}
              </motion.ul>
            )}
          </aside>

          <main className="min-w-0 flex-1 overflow-y-auto p-5">
            {active ? (
              <div className="mx-auto max-w-3xl">
                <div className="flex items-center gap-2">
                  <span
                    className="rounded-full px-2 py-0.5 text-[9.5px] font-bold uppercase"
                    style={{
                      background: `${SEVERITY[active.severity].color}22`,
                      color: SEVERITY[active.severity].color
                    }}
                  >
                    {active.severity}
                  </span>
                  <h2 className="text-sm font-semibold" style={{ fontFamily: 'var(--font-display)' }}>
                    {active.title}
                  </h2>
                </div>
                <p className="mt-1 font-mono text-[10.5px]" style={{ color: colors.quartzDim }}>
                  {active.file}:{active.line} · refuted by {result.reviewer}
                </p>
                <div
                  className="mt-4 rounded-[9px] border p-4 text-xs leading-relaxed"
                  style={{ borderColor: 'var(--color-line)', background: colors.panel, color: colors.quartz }}
                >
                  <p className="mb-1 text-[9px] font-bold uppercase tracking-[0.12em]" style={{ color: colors.quartzDim }}>
                    Evidence
                  </p>
                  {active.evidence}
                </div>
                {active.suggestedFix && (
                  <div
                    className="mt-3 rounded-[9px] border p-4 text-xs leading-relaxed"
                    style={{ borderColor: `${colors.bronze}55`, background: `${colors.bronze}0d`, color: colors.quartz }}
                  >
                    <p className="mb-1 text-[9px] font-bold uppercase tracking-[0.12em]" style={{ color: colors.bronzeHot }}>
                      Suggested fix
                    </p>
                    {active.suggestedFix}
                  </div>
                )}
                <div className="mt-4 flex flex-wrap items-center gap-2">
                  <motion.button
                    whileHover={{ scale: 1.02 }}
                    transition={springs.snappy}
                    onClick={() => openFinding(active)}
                    className="flex min-h-9 cursor-pointer items-center gap-1.5 rounded-[8px] px-3.5 py-2 text-xs font-semibold"
                    style={{
                      background: `linear-gradient(180deg, ${colors.bronzeHot}, ${colors.bronze})`,
                      color: '#241c0a',
                      fontFamily: 'var(--font-display)'
                    }}
                  >
                    <IconWand size={13} stroke={2} />
                    Apply fix
                  </motion.button>
                  <button
                    onClick={() => void sendToAgent(active)}
                    className="flex min-h-9 cursor-pointer items-center gap-1.5 rounded-[8px] border px-3.5 py-2 text-xs font-medium"
                    style={{
                      borderColor: 'var(--color-line-strong)',
                      color: colors.quartzDim,
                      fontFamily: 'var(--font-display)'
                    }}
                    title="Post this finding to the author agent through the bus"
                  >
                    <IconSend size={13} stroke={1.5} />
                    Send to agent
                  </button>
                  {sentFinding === findingKey(active) && (
                    <span role="status" className="text-[10px]" style={{ color: colors.done }}>
                      Handoff posted
                    </span>
                  )}
                </div>
              </div>
            ) : (
              <div className="flex h-full items-center justify-center text-xs" style={{ color: colors.quartzDim }}>
                Review passed with no findings.
              </div>
            )}
          </main>
        </div>
      )}
    </section>
  )
}
