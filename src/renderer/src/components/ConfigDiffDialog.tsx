import { useEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { IconAlertTriangle, IconCheck, IconFileDiff, IconX } from '@tabler/icons-react'
import type { ConfigWriterApplyResult, ConfigWriterProposal } from '@shared/ipc'
import { applyConfigProposals } from '@/lib/config-writer-events'
import { colors } from '@/lib/tokens'
import { springs } from '@/lib/springs'

interface ConfigDiffDialogProps {
  open: boolean
  proposals: ConfigWriterProposal[]
  onCancel(): void
  onApplied?(results: ConfigWriterApplyResult[]): void
}

const TARGET_LABEL: Record<ConfigWriterProposal['target'], string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  opencode: 'OpenCode'
}

export function ConfigDiffDialog({
  open,
  proposals,
  onCancel,
  onApplied
}: ConfigDiffDialogProps): JSX.Element {
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [activeId, setActiveId] = useState<string | null>(null)
  const [applying, setApplying] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const dialogRef = useRef<HTMLDivElement>(null)
  const previousFocus = useRef<HTMLElement | null>(null)

  useEffect(() => {
    if (!open) return
    setSelected(new Set(proposals.map((proposal) => proposal.proposalId)))
    setActiveId(proposals[0]?.proposalId ?? null)
    setError(null)
    previousFocus.current = document.activeElement as HTMLElement | null
    requestAnimationFrame(() => dialogRef.current?.focus())
    return () => previousFocus.current?.focus()
  }, [open, proposals])

  const active = useMemo(
    () => proposals.find((proposal) => proposal.proposalId === activeId) ?? proposals[0],
    [activeId, proposals]
  )

  const toggle = (proposalId: string): void => {
    setSelected((current) => {
      const next = new Set(current)
      if (next.has(proposalId)) next.delete(proposalId)
      else next.add(proposalId)
      return next
    })
  }

  const apply = async (): Promise<void> => {
    const approved = proposals.filter((proposal) => selected.has(proposal.proposalId))
    if (approved.length === 0 || applying) return
    setApplying(true)
    setError(null)
    try {
      onApplied?.(await applyConfigProposals(approved))
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'The config write failed. Re-propose before retrying.')
    } finally {
      setApplying(false)
    }
  }

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="absolute inset-0 z-[70] flex items-center justify-center p-6"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0, transition: { duration: 0.12 } }}
          style={{ background: 'rgba(13,12,9,0.72)', backdropFilter: 'blur(7px)' }}
          onMouseDown={(event) => event.target === event.currentTarget && !applying && onCancel()}
        >
          <motion.div
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="config-diff-title"
            tabIndex={-1}
            initial={{ opacity: 0, y: 18, scale: 0.985 }}
            animate={{ opacity: 1, y: 0, scale: 1, transition: springs.float }}
            exit={{ opacity: 0, y: 10, scale: 0.99, transition: { duration: 0.12 } }}
            onKeyDown={(event) => event.key === 'Escape' && !applying && onCancel()}
            className="flex max-h-[82vh] w-full max-w-[960px] flex-col overflow-hidden rounded-2xl border shadow-2xl outline-none"
            style={{ background: colors.panel, borderColor: 'var(--color-line-strong)' }}
          >
            <header className="flex items-start gap-3 border-b px-5 py-4" style={{ borderColor: 'var(--color-line)' }}>
              <span
                className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-[10px] border"
                style={{ color: colors.bronzeHot, borderColor: 'rgba(203,162,90,0.35)', background: 'rgba(203,162,90,0.08)' }}
              >
                <IconFileDiff size={19} stroke={1.6} />
              </span>
              <div className="min-w-0">
                <h2 id="config-diff-title" className="text-[15px] font-semibold" style={{ color: colors.quartz }}>
                  Review MCP config changes
                </h2>
                <p className="mt-0.5 text-[11px]" style={{ color: colors.quartzDim }}>
                  Only checked diffs are approved. Every write creates a timestamped backup beside the config.
                </p>
              </div>
              <button
                type="button"
                className="ml-auto flex size-9 cursor-pointer items-center justify-center rounded-[10px] hover:bg-[#37332B] disabled:cursor-not-allowed disabled:opacity-40"
                style={{ color: colors.quartzDim }}
                onClick={onCancel}
                disabled={applying}
                aria-label="Cancel config changes"
              >
                <IconX size={17} stroke={1.6} />
              </button>
            </header>

            <div className="flex min-h-0 flex-1">
              <aside className="w-[230px] shrink-0 overflow-y-auto border-r p-2" style={{ borderColor: 'var(--color-line)' }}>
                {proposals.map((proposal) => {
                  const isActive = active?.proposalId === proposal.proposalId
                  return (
                    <div
                      key={proposal.proposalId}
                      className="mb-1 flex items-center gap-2 rounded-[10px] border px-2 py-2"
                      style={{
                        borderColor: isActive ? 'rgba(203,162,90,0.45)' : 'transparent',
                        background: isActive ? 'rgba(203,162,90,0.08)' : 'transparent'
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={selected.has(proposal.proposalId)}
                        onChange={() => toggle(proposal.proposalId)}
                        aria-label={`Approve ${TARGET_LABEL[proposal.target]} config change`}
                        className="size-4 accent-[#CBA25A]"
                      />
                      <button
                        type="button"
                        onClick={() => setActiveId(proposal.proposalId)}
                        className="min-w-0 flex-1 cursor-pointer text-left"
                      >
                        <span className="block text-xs font-semibold" style={{ color: colors.quartz }}>
                          {TARGET_LABEL[proposal.target]}
                        </span>
                        <span className="block truncate font-mono text-[9px]" title={proposal.path} style={{ color: colors.quartzDim }}>
                          {proposal.path}
                        </span>
                      </button>
                    </div>
                  )
                })}
              </aside>

              <section className="flex min-w-0 flex-1 flex-col" aria-label="Selected config diff">
                {active ? (
                  <>
                    <div
                      className="flex items-center gap-2 border-b px-4 py-2 font-mono text-[10px]"
                      style={{ color: colors.quartzDim, borderColor: 'var(--color-line)' }}
                    >
                      <span style={{ color: colors.bronzeHot }}>{TARGET_LABEL[active.target]}</span>
                      <span className="truncate">{active.path}</span>
                      <span className="ml-auto shrink-0">hash {active.hash.slice(0, 10)}</span>
                    </div>
                    <pre
                      className="min-h-0 flex-1 overflow-auto p-4 font-mono text-[11px] leading-[1.55]"
                      style={{ color: colors.quartz }}
                    >
                      {active.unifiedDiff}
                    </pre>
                  </>
                ) : (
                  <div className="flex flex-1 items-center justify-center text-xs" style={{ color: colors.quartzDim }}>
                    No config changes were proposed.
                  </div>
                )}
              </section>
            </div>

            {error && (
              <div
                role="alert"
                className="flex items-center gap-2 border-t px-5 py-2 text-[11px]"
                style={{ color: colors.error, borderColor: 'rgba(239,68,68,0.25)', background: 'rgba(239,68,68,0.06)' }}
              >
                <IconAlertTriangle size={14} stroke={1.7} />
                {error}
              </div>
            )}

            <footer className="flex items-center justify-end gap-2 border-t px-5 py-3" style={{ borderColor: 'var(--color-line)' }}>
              <button
                type="button"
                onClick={onCancel}
                disabled={applying}
                className="min-h-10 cursor-pointer rounded-[10px] border px-4 text-xs font-semibold disabled:cursor-not-allowed disabled:opacity-40"
                style={{ color: colors.quartzDim, borderColor: 'var(--color-line-strong)' }}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void apply()}
                disabled={selected.size === 0 || applying}
                className="flex min-h-10 cursor-pointer items-center gap-2 rounded-[10px] px-4 text-xs font-semibold disabled:cursor-not-allowed disabled:opacity-40"
                style={{
                  color: '#241c0a',
                  background: `linear-gradient(180deg, ${colors.bronzeHot}, ${colors.bronze})`,
                  fontFamily: 'var(--font-display)'
                }}
              >
                <IconCheck size={14} stroke={2} />
                {applying ? 'Applying…' : `Apply ${selected.size} selected`}
              </button>
            </footer>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
