import { useEffect, useRef, useState } from 'react'
import {
  IconAlertTriangle,
  IconArrowRight,
  IconCheck,
  IconChevronDown,
  IconChevronRight,
  IconExternalLink,
  IconFileAnalytics,
  IconGitBranch,
  IconLoader2,
  IconPlayerPlay,
  IconSparkles
} from '@tabler/icons-react'
import type { OrganizerOperation, OrganizerViolation } from '@shared/ipc'
import { emit } from '@/lib/app-events'
import { colors } from '@/lib/tokens'
import { useOrganizerStore } from '@/store/organizerStore'
import { useSpaceStore } from '@/store/spaceStore'

function absolutePath(root: string, path: string): string {
  if (/^(?:[A-Za-z]:[\\/]|\/)/.test(path)) return path
  const separator = root.includes('\\') ? '\\' : '/'
  return `${root.replace(/[\\/]+$/, '')}${separator}${path.replace(/^[\\/]+/, '').replace(/[\\/]/g, separator)}`
}

function safeCite(cite: string): string | null {
  try {
    const url = new URL(cite)
    return url.protocol === 'https:' ? url.toString() : null
  } catch {
    return null
  }
}

function ActionButton({
  label,
  busy,
  disabled,
  onClick,
  primary = false,
  icon: Icon
}: {
  label: string
  busy: boolean
  disabled: boolean
  onClick(): void
  primary?: boolean
  icon: typeof IconPlayerPlay
}): JSX.Element {
  return (
    <button
      type="button"
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className="flex cursor-pointer items-center gap-1.5 rounded-lg border px-3 py-1.5 text-[10.5px] font-bold transition-colors disabled:cursor-not-allowed disabled:opacity-35"
      style={{
        background: primary ? `linear-gradient(180deg, ${colors.bronzeHot}, ${colors.bronze})` : colors.card,
        borderColor: primary ? 'rgba(228,188,119,0.55)' : 'var(--color-line-strong)',
        color: primary ? '#241c0a' : colors.quartz,
        fontFamily: 'var(--font-display)',
        boxShadow: primary ? 'inset 0 1px 0 rgba(255,255,255,.2), 0 4px 14px rgba(203,162,90,.12)' : undefined
      }}
    >
      {busy ? <IconLoader2 className="animate-spin" size={12} stroke={1.8} /> : <Icon size={12} stroke={1.8} />}
      {label}
    </button>
  )
}

function ViolationRow({ violation, root }: { violation: OrganizerViolation; root: string }): JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const explanation = useOrganizerStore((state) => state.explanations[violation.rule])
  const explaining = useOrganizerStore((state) => Boolean(state.explainingRules[violation.rule]))
  const explain = useOrganizerStore((state) => state.explain)
  const cite = safeCite(violation.cite)

  const toggleExplanation = (): void => {
    const next = !expanded
    setExpanded(next)
    if (next && !explanation) void explain(violation.rule)
  }

  return (
    <article className="rounded-xl border p-3" style={{ background: colors.panel, borderColor: 'var(--color-line)' }}>
      <div className="flex min-w-0 items-center gap-2">
        <button
          type="button"
          onClick={toggleExplanation}
          className="flex cursor-pointer items-center gap-1 rounded-md px-1 py-0.5 font-mono text-[9.5px]"
          style={{ color: colors.bronzeHot, background: 'rgba(203,162,90,.09)' }}
          aria-expanded={expanded}
        >
          {expanded ? <IconChevronDown size={10} /> : <IconChevronRight size={10} />}
          {violation.rule}
        </button>
        <button
          type="button"
          onClick={() => emit('open-file', { path: absolutePath(root, violation.path) })}
          className="min-w-0 cursor-pointer truncate font-mono text-[10px] hover:underline"
          style={{ color: colors.quartz }}
          title={`Open ${violation.path}`}
        >
          {violation.path}
        </button>
        {cite && (
          <a
            href={cite}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={`Citation for ${violation.rule}`}
            className="ml-auto shrink-0 rounded p-1 hover:bg-[#37332B]"
            style={{ color: colors.quartzDim }}
          >
            <IconExternalLink size={11} stroke={1.5} />
          </a>
        )}
      </div>
      <p className="mt-1.5 text-[10.5px] leading-relaxed" style={{ color: colors.quartzDim }}>
        {violation.detail}
      </p>
      {expanded && (
        <div className="mt-2 border-t pt-2 text-[10px] leading-relaxed" style={{ borderColor: 'var(--color-line)', color: colors.quartzDim }}>
          {explaining && !explanation ? 'Loading rule explanation…' : explanation?.explanation}
        </div>
      )}
    </article>
  )
}

function TreeColumn({ title, paths }: { title: string; paths: string[] }): JSX.Element {
  return (
    <section className="min-w-0 flex-1 rounded-xl border" style={{ background: colors.panel, borderColor: 'var(--color-line)' }}>
      <h3 className="border-b px-3 py-2 text-[10px] font-bold" style={{ borderColor: 'var(--color-line)', fontFamily: 'var(--font-display)' }}>
        {title}
        <span className="ml-1.5 font-mono font-normal" style={{ color: colors.quartzDim }}>{paths.length}</span>
      </h3>
      <ul className="max-h-48 overflow-auto px-3 py-2 font-mono text-[9.5px] leading-5" style={{ color: colors.quartzDim }}>
        {paths.map((path) => <li key={path} className="truncate" title={path}>{path}</li>)}
      </ul>
    </section>
  )
}

function OperationRow({ operation }: { operation: OrganizerOperation }): JSX.Element {
  return (
    <li className="flex min-w-0 items-center gap-2 rounded-lg border px-2.5 py-2 font-mono text-[9.5px]" style={{ background: colors.panel, borderColor: 'var(--color-line)' }}>
      <span className="rounded px-1.5 py-0.5 uppercase" style={{ color: operation.kind === 'move' ? colors.working : colors.done, background: colors.card }}>
        {operation.kind}
      </span>
      {operation.kind === 'move' && <><span className="truncate" title={operation.from}>{operation.from}</span><IconArrowRight className="shrink-0" size={10} /></>}
      <span className="truncate" title={operation.to}>{operation.to}</span>
    </li>
  )
}

export function OrganizerPanel(): JSX.Element {
  const activeRoot = useSpaceStore((state) => state.spaces[0]?.root ?? '')
  const previousActiveRoot = useRef(activeRoot)
  const {
    root,
    violations,
    plan,
    result,
    busy,
    audited,
    error,
    setRoot,
    audit,
    propose,
    apply
  } = useOrganizerStore()

  useEffect(() => {
    if (busy) return
    const previous = previousActiveRoot.current
    const activeChanged = activeRoot !== previous
    previousActiveRoot.current = activeRoot
    if (activeRoot && (!root || (activeChanged && root === previous))) setRoot(activeRoot)
  }, [activeRoot, busy, root, setRoot])

  return (
    <section className="flex min-w-0 flex-1 flex-col" style={{ background: colors.page }} aria-label="Organizer">
      <header className="flex flex-wrap items-center gap-2 border-b px-4 py-3" style={{ background: colors.panel, borderColor: 'var(--color-line)' }}>
        <IconFileAnalytics size={16} stroke={1.5} style={{ color: colors.bronzeHot }} />
        <div className="mr-2">
          <h1 className="text-xs font-bold" style={{ fontFamily: 'var(--font-display)' }}>Organizer</h1>
          <p className="text-[9.5px]" style={{ color: colors.quartzDim }}>audit → propose → sandbox apply</p>
        </div>
        <label className="flex min-w-[260px] flex-1 items-center gap-2 rounded-lg border px-3 py-1.5" style={{ background: colors.card, borderColor: 'var(--color-line-strong)' }}>
          <span className="shrink-0 text-[9px] uppercase tracking-wide" style={{ color: colors.quartzDim }}>Root</span>
          <input
            type="text"
            aria-label="Repository root"
            value={root}
            onChange={(event) => setRoot(event.target.value)}
            disabled={busy !== null}
            className="min-w-0 flex-1 bg-transparent font-mono text-[10px] outline-none"
            style={{ color: colors.quartz }}
          />
        </label>
        <ActionButton label="Audit repository" busy={busy === 'audit'} disabled={!root.trim() || busy !== null} onClick={() => void audit()} icon={IconFileAnalytics} />
        <ActionButton label="Propose plan" busy={busy === 'propose'} disabled={!audited || busy !== null} onClick={() => void propose()} icon={IconSparkles} />
        <ActionButton label="Apply plan in sandbox" busy={busy === 'apply'} disabled={!plan || plan.operations.length === 0 || Boolean(result) || busy !== null} onClick={() => void apply()} icon={IconPlayerPlay} primary />
      </header>

      {error && (
        <div role="alert" className="flex items-center gap-2 border-b px-4 py-2 text-[10.5px]" style={{ borderColor: 'rgba(239,68,68,.35)', color: colors.error, background: 'rgba(239,68,68,.07)' }}>
          <IconAlertTriangle size={12} />{error}
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-auto p-4">
        {!audited && !plan && !result && !busy && (
          <div className="flex h-full min-h-44 items-center justify-center rounded-2xl border border-dashed text-center" style={{ borderColor: 'var(--color-line-strong)', color: colors.quartzDim }}>
            <div><IconFileAnalytics className="mx-auto mb-2" size={24} stroke={1.2} /><p className="text-xs">Choose a repository root, then run an audit.</p><p className="mt-1 text-[9.5px]">The live tree is read-only throughout this workflow.</p></div>
          </div>
        )}

        {audited && (
          <section aria-label="Organizer violations">
            <div className="mb-2 flex items-center gap-2"><h2 className="text-xs font-bold" style={{ fontFamily: 'var(--font-display)' }}>Violations</h2><span className="rounded-full px-2 py-0.5 font-mono text-[9px]" style={{ background: colors.card, color: colors.quartzDim }}>{violations.length}</span></div>
            {violations.length === 0 ? <p className="rounded-xl border p-4 text-[10.5px]" style={{ borderColor: 'var(--color-line)', color: colors.done }}><IconCheck className="mr-1 inline" size={12} />No enabled Organizer rules were violated.</p> : <div className="grid gap-2 xl:grid-cols-2">{violations.map((violation, index) => <ViolationRow key={`${violation.rule}:${violation.path}:${index}`} violation={violation} root={root} />)}</div>}
          </section>
        )}

        {plan && (
          <section className="mt-5" aria-label="Organizer plan">
            <div className="mb-2 flex items-center gap-2"><h2 className="text-xs font-bold" style={{ fontFamily: 'var(--font-display)' }}>Hash-gated plan</h2><span className="text-[9px]" style={{ color: colors.quartzDim }}>{plan.operations.length} operations</span></div>
            <div className="rounded-xl border px-3 py-2" style={{ background: colors.panel, borderColor: 'rgba(203,162,90,.3)' }}><span className="text-[9px] uppercase tracking-wide" style={{ color: colors.quartzDim }}>Plan hash</span><div data-testid="organizer-plan-hash" className="mt-1 break-all font-mono text-[9.5px]" style={{ color: colors.bronzeHot }}>{plan.planHash}</div></div>
            <div className="mt-2 flex min-w-0 gap-2"><TreeColumn title="Before tree" paths={plan.beforeTree} /><TreeColumn title="After tree" paths={plan.afterTree} /></div>
            <h3 className="mb-2 mt-3 text-[10px] font-bold" style={{ fontFamily: 'var(--font-display)' }}>Operations</h3>
            {plan.operations.length === 0 ? (
              <p className="rounded-xl border p-3 text-[10.5px]" style={{ borderColor: 'var(--color-line)', color: colors.quartzDim }}>
                No automatically applicable operations. Review the audit findings and resolve them manually.
              </p>
            ) : (
              <ul className="grid gap-1.5 xl:grid-cols-2">{plan.operations.map((operation, index) => <OperationRow key={`${operation.kind}:${operation.to}:${index}`} operation={operation} />)}</ul>
            )}
          </section>
        )}

        {result && (
          <section className="mt-5 rounded-2xl border p-4" aria-label="Organizer apply result" style={{ background: colors.panel, borderColor: 'rgba(34,197,94,.28)' }}>
            <div className="flex items-center gap-2"><span className="flex size-7 items-center justify-center rounded-lg" style={{ background: 'rgba(34,197,94,.12)', color: colors.done }}><IconCheck size={14} /></span><div><h2 className="text-xs font-bold" style={{ fontFamily: 'var(--font-display)' }}>Sandbox worktree ready</h2><p className="text-[9.5px]" style={{ color: colors.quartzDim }}>The live tree remains unchanged. Review this diff, then fast-forward the branch yourself.</p></div></div>
            <dl className="mt-3 grid gap-2 text-[9.5px] md:grid-cols-2">
              <div className="rounded-lg border p-2" style={{ borderColor: 'var(--color-line)' }}><dt style={{ color: colors.quartzDim }}>Sandbox worktree</dt><dd data-testid="organizer-worktree-path" className="mt-1 break-all font-mono" style={{ color: colors.quartz }}>{result.worktreePath}</dd></div>
              <div className="rounded-lg border p-2" style={{ borderColor: 'var(--color-line)' }}><dt className="flex items-center gap-1" style={{ color: colors.quartzDim }}><IconGitBranch size={10} />Branch</dt><dd data-testid="organizer-worktree-branch" className="mt-1 break-all font-mono" style={{ color: colors.quartz }}>{result.branch}</dd></div>
            </dl>
            <h3 className="mb-1.5 mt-3 text-[10px] font-bold" style={{ fontFamily: 'var(--font-display)' }}>Resulting diff</h3>
            <pre className="max-h-72 overflow-auto whitespace-pre rounded-xl border p-3 font-mono text-[9px] leading-relaxed" style={{ background: colors.page, borderColor: 'var(--color-line)', color: colors.quartzDim }}>{result.diff || 'No textual diff was produced.'}</pre>
          </section>
        )}
      </div>
    </section>
  )
}
