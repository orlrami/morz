import { useEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import {
  IconAlertTriangle,
  IconBrain,
  IconCheck,
  IconClock,
  IconFile,
  IconFilePlus,
  IconRefresh,
  IconShare3,
  IconStatusChange,
  IconX
} from '@tabler/icons-react'
import type {
  ContextFileState,
  ContextMemoryKind,
  ContextProposal,
  ContextSharedBlockInput,
  ContextSpaceInput,
  ContextTemplateInput
} from '@shared/context-hub'
import { emit } from '@/lib/app-events'
import { springs } from '@/lib/springs'
import { colors } from '@/lib/tokens'
import { useContextStore } from '@/store/contextStore'
import { pickAndAddSpace, useSpaceStore } from '@/store/spaceStore'

type EditorMode = 'block' | 'memory' | 'status' | null

const TEMPLATE_KINDS = new Set<ContextTemplateInput['kind']>(['claude', 'agents', 'status'])
const BLOCK_KINDS: Array<{ value: ContextSharedBlockInput['kind']; label: string }> = [
  { value: 'claude', label: 'CLAUDE.md' },
  { value: 'agents', label: 'AGENTS.md' },
  { value: 'gemini', label: 'GEMINI.md' },
  { value: 'status', label: 'STATUS.md' },
  { value: 'readme', label: 'README.md' }
]
// w17/context-blocks — the memory block reaches every CLI's context file, one
// diff per file. CLAUDE.md stays the default so existing exports are unchanged.
const MEMORY_KINDS: Array<{ value: ContextMemoryKind; label: string }> = [
  { value: 'claude', label: 'CLAUDE.md' },
  { value: 'agents', label: 'AGENTS.md' },
  { value: 'gemini', label: 'GEMINI.md' }
]

function formatTime(value: string | null): string {
  if (!value) return 'Never touched'
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric'
  }).format(new Date(value))
}

function templateKind(file: ContextFileState): ContextTemplateInput['kind'] | null {
  return TEMPLATE_KINDS.has(file.kind as ContextTemplateInput['kind'])
    ? file.kind as ContextTemplateInput['kind']
    : null
}

interface ProposalDialogProps {
  proposals: ContextProposal[]
  onCancel(): void
  onApplied(): Promise<void>
}

function ContextProposalDialog({
  proposals,
  onCancel,
  onApplied
}: ProposalDialogProps): JSX.Element {
  const applyOne = useContextStore((state) => state.applyOne)
  const [remaining, setRemaining] = useState(proposals)
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(proposals.map((proposal) => proposal.proposalId))
  )
  const [activeId, setActiveId] = useState(proposals[0]?.proposalId ?? '')
  const [appliedCount, setAppliedCount] = useState(0)
  const [applying, setApplying] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const dialogRef = useRef<HTMLDivElement>(null)
  const previousFocus = useRef<HTMLElement | null>(null)

  useEffect(() => {
    setRemaining(proposals)
    setSelected(new Set(proposals.map((proposal) => proposal.proposalId)))
    setActiveId(proposals[0]?.proposalId ?? '')
    setAppliedCount(0)
    setError(null)
    previousFocus.current = document.activeElement as HTMLElement | null
    requestAnimationFrame(() => dialogRef.current?.focus())
    return () => previousFocus.current?.focus()
  }, [proposals])

  const active =
    remaining.find((proposal) => proposal.proposalId === activeId) ?? remaining[0]

  const toggle = (proposalId: string): void => {
    setSelected((current) => {
      const next = new Set(current)
      if (next.has(proposalId)) next.delete(proposalId)
      else next.add(proposalId)
      return next
    })
  }

  const approve = async (): Promise<void> => {
    if (applying) return
    const approved = remaining.filter((proposal) => selected.has(proposal.proposalId))
    if (approved.length === 0) return
    setApplying(true)
    setError(null)
    try {
      for (const proposal of approved) {
        await applyOne(proposal)
        setRemaining((current) => {
          const next = current.filter(
            (candidate) => candidate.proposalId !== proposal.proposalId
          )
          setActiveId((activeProposalId) =>
            activeProposalId === proposal.proposalId
              ? (next[0]?.proposalId ?? '')
              : activeProposalId
          )
          return next
        })
        setSelected((current) => {
          const next = new Set(current)
          next.delete(proposal.proposalId)
          return next
        })
        setAppliedCount((count) => count + 1)
      }
      await onApplied()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'The context proposal could not be applied.')
    } finally {
      setApplying(false)
    }
  }

  return (
    <motion.div
      className="absolute inset-0 z-[70] flex items-center justify-center p-6"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      style={{ background: 'rgba(13,12,9,0.76)', backdropFilter: 'blur(8px)' }}
      onMouseDown={(event) => event.target === event.currentTarget && !applying && onCancel()}
    >
      <motion.div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="context-diff-title"
        data-testid="context-diff-dialog"
        tabIndex={-1}
        initial={{ opacity: 0, y: 16, scale: 0.99 }}
        animate={{ opacity: 1, y: 0, scale: 1, transition: springs.float }}
        exit={{ opacity: 0, y: 8, scale: 0.99 }}
        onKeyDown={(event) => event.key === 'Escape' && !applying && onCancel()}
        className="flex max-h-[84vh] w-full max-w-[980px] flex-col overflow-hidden rounded-2xl border shadow-2xl outline-none"
        style={{ background: colors.panel, borderColor: 'var(--color-line-strong)' }}
      >
        <header className="flex items-start gap-3 border-b px-5 py-4" style={{ borderColor: 'var(--color-line)' }}>
          <span
            className="flex size-9 shrink-0 items-center justify-center rounded-[10px] border"
            style={{ color: colors.bronzeHot, borderColor: 'rgba(203,162,90,0.35)', background: 'rgba(203,162,90,0.08)' }}
          >
            <IconFilePlus size={18} stroke={1.6} />
          </span>
          <div>
            <h2 id="context-diff-title" className="text-sm font-semibold" style={{ color: colors.quartz }}>
              Review context changes
            </h2>
            <p className="mt-1 text-[11px]" style={{ color: colors.quartzDim }}>
              Every checked file is approved and applied individually with concurrency protection.
            </p>
          </div>
          <button
            type="button"
            aria-label="Cancel context changes"
            className="ml-auto flex size-9 cursor-pointer items-center justify-center rounded-[10px] hover:bg-[#37332B]"
            style={{ color: colors.quartzDim }}
            onClick={onCancel}
            disabled={applying}
          >
            <IconX size={17} stroke={1.6} />
          </button>
        </header>

        <div className="flex min-h-0 flex-1">
          <aside className="w-[250px] shrink-0 overflow-y-auto border-r p-2" style={{ borderColor: 'var(--color-line)' }}>
            {remaining.map((proposal) => {
              const isActive = proposal.proposalId === active?.proposalId
              return (
                <div
                  key={proposal.proposalId}
                  data-testid="context-proposal-row"
                  className="mb-1 flex items-center gap-2 rounded-[10px] border px-2 py-2"
                  style={{
                    borderColor: isActive ? 'rgba(203,162,90,0.42)' : 'transparent',
                    background: isActive ? 'rgba(203,162,90,0.07)' : 'transparent'
                  }}
                >
                  <input
                    type="checkbox"
                    checked={selected.has(proposal.proposalId)}
                    onChange={() => toggle(proposal.proposalId)}
                    aria-label={`Approve ${proposal.spaceName} ${proposal.relativePath}`}
                    className="size-4 accent-[#CBA25A]"
                  />
                  <button
                    type="button"
                    onClick={() => setActiveId(proposal.proposalId)}
                    className="min-w-0 flex-1 cursor-pointer text-left"
                  >
                    <span className="block truncate text-xs font-semibold" style={{ color: colors.quartz }}>
                      {proposal.spaceName}
                    </span>
                    <span className="block truncate font-mono text-[9px]" style={{ color: colors.quartzDim }}>
                      {proposal.relativePath}
                    </span>
                  </button>
                </div>
              )
            })}
          </aside>

          <section className="flex min-w-0 flex-1 flex-col" aria-label="Selected context diff">
            {active && (
              <>
                <div
                  className="flex items-center gap-2 border-b px-4 py-2 font-mono text-[10px]"
                  style={{ borderColor: 'var(--color-line)', color: colors.quartzDim }}
                >
                  <span style={{ color: colors.bronzeHot }}>{active.spaceName}</span>
                  <span className="truncate">{active.path}</span>
                  <span className="ml-auto shrink-0">hash {active.hash.slice(0, 10)}</span>
                </div>
                <pre className="min-h-0 flex-1 overflow-auto p-4 font-mono text-[11px] leading-relaxed" style={{ color: colors.quartz }}>
                  {active.unifiedDiff}
                </pre>
              </>
            )}
          </section>
        </div>

        {error && (
          <div role="alert" className="flex items-center gap-2 border-t px-5 py-2 text-[11px]" style={{ color: colors.error, borderColor: 'rgba(239,68,68,0.25)' }}>
            <IconAlertTriangle size={14} />
            {error}
          </div>
        )}

        <footer className="flex items-center justify-end gap-2 border-t px-5 py-3" style={{ borderColor: 'var(--color-line)' }}>
          {appliedCount > 0 && (
            <span className="mr-auto text-[10px]" style={{ color: colors.done }}>
              {appliedCount} file{appliedCount === 1 ? '' : 's'} applied
            </span>
          )}
          <button
            type="button"
            onClick={onCancel}
            disabled={applying}
            className="min-h-10 cursor-pointer rounded-[10px] border px-4 text-xs font-semibold"
            style={{ color: colors.quartzDim, borderColor: 'var(--color-line-strong)' }}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void approve()}
            disabled={selected.size === 0 || applying}
            className="flex min-h-10 cursor-pointer items-center gap-2 rounded-[10px] px-4 text-xs font-semibold disabled:cursor-not-allowed disabled:opacity-40"
            style={{ color: '#241c0a', background: `linear-gradient(180deg, ${colors.bronzeHot}, ${colors.bronze})` }}
          >
            <IconCheck size={14} stroke={2} />
            {applying ? 'Applying…' : `Apply ${selected.size} selected`}
          </button>
        </footer>
      </motion.div>
    </motion.div>
  )
}

export function ContextHubPanel(): JSX.Element {
  const allSpaces = useSpaceStore((state) => state.spaces)
  const unavailableRoots = useSpaceStore((state) => state.unavailableRoots)
  const matrix = useContextStore((state) => state.matrix)
  const loading = useContextStore((state) => state.loading)
  const error = useContextStore((state) => state.error)
  const scan = useContextStore((state) => state.scan)
  const proposeTemplate = useContextStore((state) => state.proposeTemplate)
  const proposeSharedBlock = useContextStore((state) => state.proposeSharedBlock)
  const proposeMemoryBlock = useContextStore((state) => state.proposeMemoryBlock)
  const proposeStatusBlock = useContextStore((state) => state.proposeStatusBlock)
  const opened = useRef(false)
  const [proposals, setProposals] = useState<ContextProposal[]>([])
  const [editor, setEditor] = useState<EditorMode>(null)
  const [selectedSpaces, setSelectedSpaces] = useState<Set<string>>(new Set())
  const [blockName, setBlockName] = useState('')
  const [blockContent, setBlockContent] = useState('')
  const [blockKind, setBlockKind] = useState<ContextSharedBlockInput['kind']>('claude')
  const [memoryKinds, setMemoryKinds] = useState<Set<ContextMemoryKind>>(new Set(['claude']))

  const spaces = useMemo<ContextSpaceInput[]>(
    () => allSpaces
      .filter((space) => !unavailableRoots[space.root])
      .map(({ id, name, root }) => ({ id, name, root })),
    [allSpaces, unavailableRoots]
  )

  const refresh = async (): Promise<void> => {
    await scan(spaces)
  }

  useEffect(() => {
    if (opened.current) return
    opened.current = true
    void refresh().catch(() => undefined)
  }, [])

  const openEditor = (mode: Exclude<EditorMode, null>): void => {
    setEditor((current) => current === mode ? null : mode)
    setSelectedSpaces(new Set(spaces.map((space) => space.id)))
  }

  const toggleSpace = (spaceId: string): void => {
    setSelectedSpaces((current) => {
      const next = new Set(current)
      if (next.has(spaceId)) next.delete(spaceId)
      else next.add(spaceId)
      return next
    })
  }

  const reviewTemplate = async (spaceId: string, kind: ContextTemplateInput['kind']): Promise<void> => {
    setProposals([await proposeTemplate({ spaceId, kind })])
  }

  const reviewBlock = async (): Promise<void> => {
    const next = await proposeSharedBlock({
      name: blockName,
      content: blockContent,
      spaceIds: [...selectedSpaces],
      kind: blockKind
    })
    setEditor(null)
    setProposals(next)
  }

  const toggleMemoryKind = (kind: ContextMemoryKind): void => {
    setMemoryKinds((current) => {
      const next = new Set(current)
      if (next.has(kind)) next.delete(kind)
      else next.add(kind)
      return next
    })
  }

  const reviewMemory = async (): Promise<void> => {
    const next = await proposeMemoryBlock({
      spaceIds: [...selectedSpaces],
      kinds: [...memoryKinds]
    })
    setEditor(null)
    setProposals(next)
  }

  const reviewStatus = async (): Promise<void> => {
    const next = await proposeStatusBlock({ spaceIds: [...selectedSpaces] })
    setEditor(null)
    setProposals(next)
  }

  return (
    <section className="relative flex min-h-0 flex-1 flex-col overflow-hidden" style={{ background: colors.page }}>
      <header className="flex items-start gap-4 border-b px-6 py-5" style={{ borderColor: 'var(--color-line)' }}>
        <div className="min-w-0">
          <p className="font-mono text-[9px] uppercase tracking-[0.2em]" style={{ color: colors.bronzeHot }}>
            Context control plane
          </p>
          <h1 className="mt-1 text-xl font-semibold tracking-tight" style={{ color: colors.quartz }}>
            Keep every CLI in context
          </h1>
          <p className="mt-1 max-w-2xl text-xs leading-relaxed" style={{ color: colors.quartzDim }}>
            Known project instructions, status, and CLI configuration across every Space. Changes remain proposal-only until approved.
          </p>
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-2">
          <button
            type="button"
            aria-label="Shared block"
            onClick={() => openEditor('block')}
            className="flex min-h-9 cursor-pointer items-center gap-2 rounded-[10px] border px-3 text-[11px] font-semibold hover:bg-white/[0.03]"
            style={{ color: colors.quartz, borderColor: 'var(--color-line-strong)' }}
          >
            <IconShare3 size={14} />
            Shared block
          </button>
          <button
            type="button"
            aria-label="Update status"
            onClick={() => openEditor('status')}
            className="flex min-h-9 cursor-pointer items-center gap-2 rounded-[10px] border px-3 text-[11px] font-semibold hover:bg-white/[0.03]"
            style={{ color: colors.quartz, borderColor: 'var(--color-line-strong)' }}
          >
            <IconStatusChange size={14} />
            Update status
          </button>
          <button
            type="button"
            aria-label="Export memory"
            onClick={() => openEditor('memory')}
            className="flex min-h-9 cursor-pointer items-center gap-2 rounded-[10px] border px-3 text-[11px] font-semibold hover:bg-white/[0.03]"
            style={{ color: colors.quartz, borderColor: 'var(--color-line-strong)' }}
          >
            <IconBrain size={14} />
            Export memory
          </button>
          <button
            type="button"
            aria-label="Refresh context matrix"
            onClick={() => void refresh()}
            disabled={loading}
            className="flex size-9 cursor-pointer items-center justify-center rounded-[10px] border disabled:cursor-wait disabled:opacity-50"
            style={{ color: colors.bronzeHot, borderColor: 'rgba(203,162,90,0.35)', background: 'rgba(203,162,90,0.07)' }}
          >
            <IconRefresh size={15} className={loading ? 'animate-spin' : ''} />
          </button>
        </div>
      </header>

      <AnimatePresence initial={false}>
        {editor && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            className="overflow-hidden border-b"
            style={{ borderColor: 'var(--color-line)', background: colors.panel }}
          >
            <div className="grid grid-cols-[minmax(0,1fr)_minmax(280px,0.7fr)] gap-5 px-6 py-4">
              <div>
                {editor === 'block' ? (
                  <div className="grid gap-3">
                    <div className="grid grid-cols-[1fr_180px] gap-3">
                      <label className="grid gap-1 text-[10px]" style={{ color: colors.quartzDim }}>
                        Block name
                        <input
                          aria-label="Block name"
                          value={blockName}
                          onChange={(event) => setBlockName(event.target.value)}
                          placeholder="quality-gate"
                          className="min-h-9 rounded-[9px] border bg-transparent px-3 font-mono text-xs outline-none focus:border-[#CBA25A]"
                          style={{ color: colors.quartz, borderColor: 'var(--color-line-strong)' }}
                        />
                      </label>
                      <label className="grid gap-1 text-[10px]" style={{ color: colors.quartzDim }}>
                        Target file
                        <select
                          aria-label="Target file"
                          value={blockKind}
                          onChange={(event) => setBlockKind(event.target.value as ContextSharedBlockInput['kind'])}
                          className="min-h-9 rounded-[9px] border bg-[#232019] px-3 text-xs outline-none"
                          style={{ color: colors.quartz, borderColor: 'var(--color-line-strong)' }}
                        >
                          {BLOCK_KINDS.map((kind) => <option key={kind.value} value={kind.value}>{kind.label}</option>)}
                        </select>
                      </label>
                    </div>
                    <label className="grid gap-1 text-[10px]" style={{ color: colors.quartzDim }}>
                      Block content
                      <textarea
                        aria-label="Block content"
                        value={blockContent}
                        onChange={(event) => setBlockContent(event.target.value)}
                        rows={4}
                        className="resize-y rounded-[9px] border bg-transparent p-3 font-mono text-xs leading-relaxed outline-none focus:border-[#CBA25A]"
                        style={{ color: colors.quartz, borderColor: 'var(--color-line-strong)' }}
                      />
                    </label>
                  </div>
                ) : editor === 'memory' ? (
                  <div className="rounded-xl border p-4" style={{ borderColor: 'var(--color-line-strong)', background: 'rgba(203,162,90,0.04)' }}>
                    <div className="flex items-center gap-2 text-sm font-semibold" style={{ color: colors.quartz }}>
                      <IconBrain size={16} style={{ color: colors.bronzeHot }} />
                      Managed memory block
                    </div>
                    <p className="mt-2 text-[11px] leading-relaxed" style={{ color: colors.quartzDim }}>
                      Enabled, approved memories are rendered into one deterministic <code className="font-mono">&lt;!-- morz:memory --&gt;</code> block per selected file — the same content in every CLI&apos;s context file.
                    </p>
                    <div className="mt-3 flex flex-wrap gap-2">
                      {MEMORY_KINDS.map((kind) => (
                        <label
                          key={kind.value}
                          className="flex cursor-pointer items-center gap-2 rounded-lg border px-2.5 py-1.5 text-[11px]"
                          style={{ color: colors.quartz, borderColor: 'var(--color-line-strong)' }}
                        >
                          <input
                            type="checkbox"
                            aria-label={`Write ${kind.label}`}
                            checked={memoryKinds.has(kind.value)}
                            onChange={() => toggleMemoryKind(kind.value)}
                            className="size-4 accent-[#CBA25A]"
                          />
                          <span className="font-mono">{kind.label}</span>
                        </label>
                      ))}
                    </div>
                  </div>
                ) : (
                  <div className="rounded-xl border p-4" style={{ borderColor: 'var(--color-line-strong)', background: 'rgba(203,162,90,0.04)' }}>
                    <div className="flex items-center gap-2 text-sm font-semibold" style={{ color: colors.quartz }}>
                      <IconStatusChange size={16} style={{ color: colors.bronzeHot }} />
                      Managed STATUS.md snapshot
                    </div>
                    <p className="mt-2 text-[11px] leading-relaxed" style={{ color: colors.quartzDim }}>
                      Propose one managed section per selected Space from its current branch, recent Morz runs, and latest recorded E2E run state.
                    </p>
                  </div>
                )}
              </div>

              <div className="flex flex-col">
                <p className="text-[10px] font-semibold uppercase tracking-[0.16em]" style={{ color: colors.quartzDim }}>
                  Selected Spaces
                </p>
                <div className="mt-2 grid max-h-28 gap-1 overflow-y-auto">
                  {spaces.map((space) => (
                    <label key={space.id} className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-xs hover:bg-white/[0.03]" style={{ color: colors.quartz }}>
                      <input
                        type="checkbox"
                        aria-label={`Include ${space.name}`}
                        checked={selectedSpaces.has(space.id)}
                        onChange={() => toggleSpace(space.id)}
                        className="size-4 accent-[#CBA25A]"
                      />
                      <span className="truncate">{space.name}</span>
                    </label>
                  ))}
                </div>
                <button
                  type="button"
                  onClick={() => void (
                    editor === 'block'
                      ? reviewBlock()
                      : editor === 'memory'
                        ? reviewMemory()
                        : reviewStatus()
                  // a refused proposal (e.g. a read-only block) is reported on
                  // the error banner; it must not surface as an unhandled reject
                  ).catch(() => undefined)}
                  disabled={
                    selectedSpaces.size === 0 ||
                    (editor === 'block' && (!blockName.trim() || !blockContent.trim())) ||
                    (editor === 'memory' && memoryKinds.size === 0)
                  }
                  className="mt-auto min-h-9 cursor-pointer rounded-[9px] px-3 text-xs font-semibold disabled:cursor-not-allowed disabled:opacity-40"
                  style={{ color: '#241c0a', background: `linear-gradient(180deg, ${colors.bronzeHot}, ${colors.bronze})` }}
                >
                  {editor === 'block'
                    ? `Review ${selectedSpaces.size} block diff${selectedSpaces.size === 1 ? '' : 's'}`
                    : editor === 'memory'
                      ? `Review ${selectedSpaces.size * memoryKinds.size} memory diff${selectedSpaces.size * memoryKinds.size === 1 ? '' : 's'}`
                      : `Review ${selectedSpaces.size} status diff${selectedSpaces.size === 1 ? '' : 's'}`}
                </button>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {error && (
        <div role="alert" className="flex items-center gap-2 border-b px-6 py-2 text-[11px]" style={{ color: colors.error, borderColor: 'rgba(239,68,68,0.22)' }}>
          <IconAlertTriangle size={14} />
          {error}
          {error.includes('not authorized') && (
            <button
              type="button"
              onClick={() => void pickAndAddSpace().then(() => refresh())}
              className="ml-auto min-h-8 cursor-pointer rounded-lg border px-3 font-semibold"
              style={{ color: colors.quartz, borderColor: 'var(--color-line-strong)' }}
            >
              Authorize Space folder
            </button>
          )}
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-auto p-5">
        <div
          data-testid="context-matrix"
          className="min-w-[1260px] overflow-hidden rounded-2xl border shadow-[0_12px_36px_rgba(0,0,0,0.18)]"
          style={{ borderColor: 'var(--color-line-strong)', background: colors.panel }}
        >
          <table className="w-full border-collapse text-left">
            <thead>
              <tr className="border-b" style={{ borderColor: 'var(--color-line)' }}>
                <th className="sticky left-0 z-10 w-44 px-4 py-3 text-[10px] font-semibold uppercase tracking-[0.15em]" style={{ color: colors.quartzDim, background: colors.panel }}>
                  Space
                </th>
                {(matrix?.spaces[0]?.files ?? []).map((file) => (
                  <th key={file.kind} className="min-w-[118px] px-3 py-3 font-mono text-[9px] font-medium" style={{ color: colors.quartzDim }}>
                    {file.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {matrix?.spaces.map((space) => (
                <tr key={space.id} className="border-b last:border-b-0" style={{ borderColor: 'var(--color-line)' }}>
                  <th className="sticky left-0 z-10 px-4 py-3" style={{ background: colors.panel }}>
                    <span className="block truncate text-xs font-semibold" style={{ color: colors.quartz }}>{space.name}</span>
                    <span className="mt-1 block font-mono text-[9px]" style={{ color: colors.quartzDim }}>{space.projectType}</span>
                  </th>
                  {space.files.map((file) => {
                    const kind = templateKind(file)
                    const stateColor = file.state === 'stale'
                      ? colors.warning
                      : file.state === 'present'
                        ? colors.done
                        : colors.quartzDim
                    return (
                      <td
                        key={file.kind}
                        data-testid={`context-cell-${space.id}-${file.kind}`}
                        className="px-2 py-2 align-top"
                      >
                        <div
                          className="min-h-[66px] rounded-[10px] border p-2"
                          style={{
                            borderColor: file.state === 'stale' ? 'rgba(234,179,8,0.3)' : 'var(--color-line)',
                            background: file.state === 'stale' ? 'rgba(234,179,8,0.055)' : 'rgba(255,255,255,0.012)'
                          }}
                        >
                          <div className="flex items-center gap-1.5 text-[10px] font-semibold" style={{ color: stateColor }}>
                            {file.state === 'stale' ? <IconClock size={12} /> : <IconFile size={12} />}
                            {file.state[0].toUpperCase() + file.state.slice(1)}
                          </div>
                          {file.state === 'missing' && kind ? (
                            <button
                              type="button"
                              aria-label={`Create ${file.label} from template`}
                              onClick={() => void reviewTemplate(space.id, kind)}
                              className="mt-2 cursor-pointer text-left text-[9px] font-semibold underline decoration-dotted underline-offset-2"
                              style={{ color: colors.bronzeHot }}
                            >
                              Create from template
                            </button>
                          ) : file.state !== 'missing' ? (
                            <button
                              type="button"
                              aria-label={`Open ${file.label} for ${space.name}`}
                              onClick={() => emit('open-file', { path: file.path })}
                              className="mt-2 block w-full cursor-pointer truncate text-left font-mono text-[8px] hover:underline"
                              title={`${file.relativePath} · ${formatTime(file.lastTouchedAt)}`}
                              style={{ color: colors.quartzDim }}
                            >
                              {formatTime(file.lastTouchedAt)}
                            </button>
                          ) : (
                            <span className="mt-2 block text-[9px]" style={{ color: colors.quartzDim }}>Not found</span>
                          )}
                        </div>
                      </td>
                    )
                  })}
                </tr>
              ))}
            </tbody>
          </table>
          {!loading && (matrix?.spaces.length ?? 0) === 0 && (
            <div className="flex min-h-44 items-center justify-center text-xs" style={{ color: colors.quartzDim }}>
              Add a Space to scan its context files.
            </div>
          )}
          {loading && !matrix && (
            <div className="flex min-h-44 items-center justify-center gap-2 text-xs" style={{ color: colors.quartzDim }}>
              <IconRefresh size={14} className="animate-spin" />
              Scanning known context locations…
            </div>
          )}
        </div>
      </div>

      <AnimatePresence>
        {proposals.length > 0 && (
          <ContextProposalDialog
            proposals={proposals}
            onCancel={() => setProposals([])}
            onApplied={async () => {
              setProposals([])
              await refresh()
            }}
          />
        )}
      </AnimatePresence>
    </section>
  )
}
