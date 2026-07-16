import { useEffect, useMemo, useState } from 'react'
import { motion } from 'framer-motion'
import {
  IconAlertTriangle,
  IconChevronDown,
  IconGitBranch,
  IconLoader2,
  IconSend,
  IconShieldCheck,
  IconSparkles,
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
const SEVERITY_ORDER: ReviewSeverity[] = ['critical', 'high', 'medium', 'low', 'info']

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
  const activeSpaceId = useSpaceStore((state) => state.activeSpaceId)
  const gitByRoot = useSpaceStore((state) => state.gitByRoot)
  const {
    candidates,
    selectedId,
    result,
    loading,
    error,
    summary,
    summaryLoading,
    summaryError,
    sentFinding,
    start,
    select,
    run,
    sendToAgent
  } = useReviewStore()
  const [selectedFinding, setSelectedFinding] = useState(0)
  const [expanded, setExpanded] = useState<Record<ReviewSeverity, boolean>>({
    critical: true,
    high: true,
    medium: true,
    low: true,
    info: true
  })

  useEffect(
    () => start(spaces, activeSpaceId, gitByRoot),
    [activeSpaceId, gitByRoot, spaces, start]
  )
  useEffect(() => {
    setSelectedFinding(0)
    setExpanded({ critical: true, high: true, medium: true, low: true, info: true })
  }, [result?.id])

  const candidate = useMemo(
    () => candidates.find((item) => item.id === selectedId) ?? null,
    [candidates, selectedId]
  )
  const active = result?.findings[selectedFinding] ?? null
  const groups = useMemo(
    () =>
      SEVERITY_ORDER.map((severity) => ({
        severity,
        findings: (result?.findings ?? [])
          .map((finding, index) => ({ finding, index }))
          .filter((entry) => entry.finding.severity === severity)
      })).filter((group) => group.findings.length > 0),
    [result]
  )

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
            A non-author model challenges the selected diff
          </p>
        </div>
        <label className="min-w-[260px] flex-1">
          <span className="sr-only">Pick a branch or diff to review</span>
          <select
            aria-label="Review run"
            value={selectedId ?? ''}
            onChange={(event) => select(event.target.value)}
            disabled={loading || candidates.length === 0}
            className="w-full rounded-[8px] border px-3 py-2 font-mono text-[10.5px] outline-none focus:ring-2"
            style={{
              borderColor: 'var(--color-line-strong)',
              background: colors.card,
              color: colors.quartz
            }}
          >
            {candidates.length === 0 && <option value="">No Git branch or completed diff found</option>}
            {candidates.map((item) => (
              <option key={item.id} value={item.id}>
                {item.branch} — {item.label}{item.source === 'artifact' ? ` (${item.author})` : ''}
              </option>
            ))}
          </select>
        </label>
        <motion.button
          whileHover={candidate && !loading ? { scale: 1.02 } : undefined}
          transition={springs.snappy}
          onClick={() => void run()}
          disabled={!candidate || loading}
          className="flex min-h-9 cursor-pointer items-center gap-1.5 rounded-[8px] px-3.5 py-2 text-xs font-semibold shadow-[inset_0_1px_0_rgba(255,255,255,0.18)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 disabled:cursor-not-allowed disabled:opacity-40"
          style={{
            background: `linear-gradient(180deg, ${colors.bronzeHot}, ${colors.bronze})`,
            color: '#241c0a',
            fontFamily: 'var(--font-display)',
            outlineColor: colors.bronzeHot
          }}
        >
          {loading ? <IconLoader2 className="animate-spin" size={14} /> : <IconShieldCheck size={14} />}
          {loading ? 'Reviewing…' : 'Run review'}
        </motion.button>
      </header>

      {error && (
        <div
          role="alert"
          className="m-3 flex items-start gap-2 rounded-[9px] border px-3 py-3 text-xs"
          style={{ borderColor: `${colors.error}66`, background: `${colors.error}12`, color: colors.error }}
        >
          <IconAlertTriangle size={15} className="mt-px shrink-0" />
          <div>
            <p className="font-semibold">Review couldn’t start</p>
            <p className="mt-1 leading-relaxed" style={{ color: colors.quartz }}>
              {error}
            </p>
          </div>
        </div>
      )}

      {!result && !loading && !error && (
        <div className="flex flex-1 items-center justify-center p-8 text-center">
          <div className="max-w-md">
            {candidate ? (
              <IconGitBranch size={30} stroke={1.2} className="mx-auto" style={{ color: colors.bronzeHot }} />
            ) : (
              <IconShieldCheck size={30} stroke={1.2} className="mx-auto" style={{ color: colors.quartzDim }} />
            )}
            <h2 className="mt-3 text-sm font-semibold" style={{ fontFamily: 'var(--font-display)' }}>
              {candidate ? 'Ready to review this branch' : 'Nothing to review yet'}
            </h2>
            <p className="mt-1 text-[10.5px] leading-relaxed" style={{ color: colors.quartzDim }}>
              {candidate
                ? 'The active space’s current branch is selected against its base. You can also choose a completed task diff above, then run the review.'
                : 'Open a Git-backed space with a current branch, or complete a task with a commit artifact. It will appear here automatically.'}
            </p>
          </div>
        </div>
      )}

      {loading && (
        <div className="flex flex-1 items-center justify-center p-8 text-center">
          <div className="max-w-sm">
            <IconLoader2 className="mx-auto animate-spin" size={22} style={{ color: colors.bronzeHot }} />
            <p className="mt-3 text-xs font-semibold" style={{ color: colors.quartz }}>
              Challenging the diff…
            </p>
            <p className="mt-1 text-[10.5px] leading-relaxed" style={{ color: colors.quartzDim }}>
              The non-author model is checking evidence and trying to refute the change.
            </p>
          </div>
        </div>
      )}

      {result?.emptyDiff && !loading && (
        <div className="flex flex-1 items-center justify-center p-8 text-center">
          <div className="max-w-md">
            <IconGitBranch size={30} stroke={1.2} className="mx-auto" style={{ color: colors.quartzDim }} />
            <h2 className="mt-3 text-sm font-semibold" style={{ fontFamily: 'var(--font-display)' }}>
              Nothing to review yet
            </h2>
            <p className="mt-1 text-[10.5px] leading-relaxed" style={{ color: colors.quartzDim }}>
              This branch matches its base. Make a commit with changes or choose another completed diff, then run review again.
            </p>
          </div>
        </div>
      )}

      {result && !result.emptyDiff && result.findings.length === 0 && !loading && (
        <div className="flex flex-1 items-center justify-center p-8 text-center">
          <div className="max-w-md">
            <IconShieldCheck size={30} stroke={1.2} className="mx-auto" style={{ color: colors.done }} />
            <h2 className="mt-3 text-sm font-semibold" style={{ fontFamily: 'var(--font-display)' }}>
              No evidence-backed findings
            </h2>
            <p className="mt-1 text-[10.5px] leading-relaxed" style={{ color: colors.quartzDim }}>
              The non-author model challenged this diff and did not find a concrete bug.
            </p>
          </div>
        </div>
      )}

      {result && !result.emptyDiff && result.findings.length > 0 && !loading && (
        <div className="flex min-h-0 flex-1">
          <aside
            className="flex w-[340px] shrink-0 flex-col border-r"
            style={{ borderColor: 'var(--color-line)' }}
          >
            <div className="border-b px-3 py-2" style={{ borderColor: 'var(--color-line)' }}>
              <div className="flex items-center gap-2">
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
              {result.findingsTruncated && (
                <p className="mt-1 text-[9.5px] leading-relaxed" style={{ color: colors.warning }}>
                  Showing {result.findings.length} of {result.totalFindings} findings. The rest were capped to keep this review actionable.
                </p>
              )}
            </div>
            <div className="flex-1 overflow-y-auto p-2">
              {groups.map((group) => {
                const meta = SEVERITY[group.severity]
                const isExpanded = expanded[group.severity]
                return (
                  <section key={group.severity} className="mb-1">
                    <button
                      type="button"
                      aria-label={`${meta.label} severity, ${group.findings.length} ${group.findings.length === 1 ? 'finding' : 'findings'}`}
                      aria-expanded={isExpanded}
                      onClick={() =>
                        setExpanded((current) => ({
                          ...current,
                          [group.severity]: !current[group.severity]
                        }))
                      }
                      className="flex w-full cursor-pointer items-center gap-2 rounded-[7px] px-2 py-1.5 text-left focus-visible:outline focus-visible:outline-2"
                      style={{ color: meta.color, outlineColor: meta.color }}
                    >
                      <IconChevronDown
                        size={13}
                        className="transition-transform"
                        style={{ transform: isExpanded ? 'rotate(0deg)' : 'rotate(-90deg)' }}
                      />
                      <span className="text-[9px] font-bold uppercase tracking-[0.12em]">{meta.label}</span>
                      <span className="ml-auto font-mono text-[9px]">{group.findings.length}</span>
                    </button>
                    {isExpanded && (
                      <motion.ul variants={staggerContainer} initial="hidden" animate="show">
                        {group.findings.map(({ finding, index }) => (
                          <motion.li key={findingKey(finding)} variants={staggerItem}>
                            <button
                              data-testid="review-finding"
                              onClick={() => setSelectedFinding(index)}
                              className="mb-1 w-full cursor-pointer rounded-[9px] border p-2.5 text-left transition-colors focus-visible:outline focus-visible:outline-2"
                              style={{
                                borderColor: selectedFinding === index ? 'rgba(203,162,90,0.45)' : 'transparent',
                                background: selectedFinding === index ? colors.card : 'transparent',
                                outlineColor: colors.bronzeHot
                              }}
                            >
                              <div className="flex items-center gap-2">
                                <span
                                  data-testid="severity-chip"
                                  className="rounded-full px-1.5 py-px text-[8.5px] font-bold uppercase"
                                  style={{ background: `${meta.color}22`, color: meta.color }}
                                >
                                  {meta.label}
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
                  </section>
                )
              })}
            </div>
          </aside>

          <main className="min-w-0 flex-1 overflow-y-auto p-5">
            <div className="mx-auto max-w-3xl">
              <section
                aria-label="AI summary"
                className="mb-5 rounded-[12px] border p-4 shadow-[0_2px_20px_rgba(0,0,0,0.24),inset_0_1px_0_rgba(255,255,255,0.05)]"
                style={{ borderColor: `${colors.bronze}55`, background: `linear-gradient(145deg, ${colors.bronze}13, ${colors.panel})` }}
              >
                <div className="flex items-center gap-2">
                  <IconSparkles size={14} style={{ color: colors.bronzeHot }} />
                  <h2 className="text-[9px] font-bold uppercase tracking-[0.14em]" style={{ color: colors.bronzeHot }}>
                    AI summary
                  </h2>
                </div>
                {summaryLoading && (
                  <p role="status" className="mt-2 flex items-center gap-2 text-xs" style={{ color: colors.quartzDim }}>
                    <IconLoader2 className="animate-spin" size={13} />
                    Turning the findings into a priority brief…
                  </p>
                )}
                {summary && (
                  <p className="mt-2 whitespace-pre-wrap text-xs leading-relaxed" style={{ color: colors.quartz }}>
                    {summary}
                  </p>
                )}
                {summaryError && !summaryLoading && (
                  <p className="mt-2 text-xs leading-relaxed" style={{ color: colors.quartzDim }}>
                    {summaryError}
                  </p>
                )}
              </section>

              {active && (
                <article>
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
                      disabled={!candidate?.authorAgent}
                      className="flex min-h-9 cursor-pointer items-center gap-1.5 rounded-[8px] border px-3.5 py-2 text-xs font-medium disabled:cursor-not-allowed disabled:opacity-40"
                      style={{
                        borderColor: 'var(--color-line-strong)',
                        color: colors.quartzDim,
                        fontFamily: 'var(--font-display)'
                      }}
                      title={candidate?.authorAgent ? 'Post this finding to the author agent through the bus' : 'No author agent is attached to this branch'}
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
                </article>
              )}
            </div>
          </main>
        </div>
      )}
    </section>
  )
}
