import { useEffect, useState, type FormEvent } from 'react'
import {
  IconBrain,
  IconCheck,
  IconPencil,
  IconPlus,
  IconRestore,
  IconSearch,
  IconTrash,
  IconX
} from '@tabler/icons-react'
import type {
  MemoryBootstrapReview,
  MemoryEntry,
  MemoryOp,
  MemoryScope,
  MorzMemoryApi
} from '@shared/memory'
import { colors } from '@/lib/tokens'
import { useMemoryStore } from '@/store/memoryStore'
import { useSpaceStore } from '@/store/spaceStore'

const SCOPES: MemoryScope[] = ['global', 'project', 'space', 'agent']

/** w15/memory-opset — UPDATE/DELETE approval cards render the op diff. */
function OpDiff({ op }: { op: MemoryOp }): JSX.Element | null {
  if (op.kind !== 'update' && op.kind !== 'delete') return null
  return (
    <div
      className="mt-2 rounded-md border p-2 text-[10px] leading-relaxed"
      style={{ borderColor: 'var(--color-line-strong)' }}
      aria-label={`${op.kind} details`}
    >
      <p
        className="text-[9px] font-semibold uppercase tracking-[0.1em]"
        style={{ color: op.kind === 'delete' ? colors.error : colors.bronzeHot }}
      >
        {op.kind === 'delete' ? 'Delete existing memory' : 'Update existing memory'}
        {op.targetId && <span className="ml-1 normal-case tracking-normal" style={{ color: colors.quartzDim }}>#{op.targetId}</span>}
      </p>
      {op.old && (
        <p className="mt-1 line-through" style={{ color: colors.error }}>
          {op.old.title}
          {op.old.body ? ` — ${op.old.body.slice(0, 160)}` : ''}
        </p>
      )}
      {op.kind === 'update' && op.next && (
        <p className="mt-1" style={{ color: colors.done }}>
          {op.next.title}
          {op.next.body ? ` — ${op.next.body.slice(0, 160)}` : ''}
        </p>
      )}
      {op.reason && (
        <p className="mt-1 italic" style={{ color: colors.quartzDim }}>{op.reason}</p>
      )}
      <p className="mt-1 text-[9px]" style={{ color: colors.quartzDim }}>
        The old memory is kept expired and can be restored from this list.
      </p>
    </div>
  )
}

function EntryCard({ entry }: { entry: MemoryEntry }): JSX.Element {
  const busy = useMemoryStore((state) => state.busy)
  const save = useMemoryStore((state) => state.save)
  const remove = useMemoryStore((state) => state.remove)
  const setEnabled = useMemoryStore((state) => state.setEnabled)
  const restore = useMemoryStore((state) => state.restore)
  const [editing, setEditing] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [title, setTitle] = useState(entry.title)
  const [body, setBody] = useState(entry.body)
  const isBusy = busy?.endsWith(entry.id) ?? false

  const submitEdit = (event: FormEvent): void => {
    event.preventDefault()
    if (!title.trim()) return
    void save({ ...entry, title: title.trim(), body }).then(() => setEditing(false)).catch(() => undefined)
  }

  return (
    <article
      className="rounded-lg border px-3 py-2.5"
      style={{
        background: colors.card,
        borderColor: entry.enabled ? 'var(--color-line)' : 'rgba(238,230,217,0.08)',
        opacity: entry.enabled ? 1 : 0.68
      }}
      aria-label={`Memory ${entry.title}`}
    >
      {editing ? (
        <form onSubmit={submitEdit} className="space-y-2">
          <input
            aria-label={`Edit title for ${entry.title}`}
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            maxLength={240}
            className="w-full rounded-md border bg-transparent px-2 py-1.5 text-[11px] outline-none focus:border-[#CBA25A]"
            style={{ borderColor: 'var(--color-line-strong)', color: colors.quartz }}
          />
          <textarea
            aria-label={`Edit body for ${entry.title}`}
            value={body}
            onChange={(event) => setBody(event.target.value)}
            rows={3}
            className="w-full resize-y rounded-md border bg-transparent px-2 py-1.5 text-[10.5px] leading-relaxed outline-none focus:border-[#CBA25A]"
            style={{ borderColor: 'var(--color-line-strong)', color: colors.quartz }}
          />
          <div className="flex justify-end gap-1.5">
            <button
              type="button"
              onClick={() => {
                setTitle(entry.title)
                setBody(entry.body)
                setEditing(false)
              }}
              className="flex min-h-7 items-center gap-1 rounded-md border px-2 text-[10px]"
              style={{ borderColor: 'var(--color-line-strong)', color: colors.quartzDim }}
            >
              <IconX size={11} /> Cancel
            </button>
            <button
              type="submit"
              disabled={isBusy || !title.trim()}
              className="flex min-h-7 items-center gap-1 rounded-md px-2 text-[10px] font-semibold disabled:opacity-40"
              style={{ background: colors.bronze, color: colors.page }}
            >
              <IconCheck size={11} /> Save
            </button>
          </div>
        </form>
      ) : (
        <>
          <div className="flex items-start gap-2">
            <div className="min-w-0 flex-1">
              <p className="truncate text-[11px] font-semibold" style={{ fontFamily: 'var(--font-display)' }}>
                {entry.title}
              </p>
              <div className="mt-1 flex flex-wrap items-center gap-1 text-[9px] uppercase tracking-[0.08em]" style={{ color: colors.quartzDim }}>
                <span>{entry.kind}</span>
                <span aria-hidden="true">·</span>
                <span>{entry.origin}</span>
                <span aria-hidden="true">·</span>
                <span>{entry.scope}</span>
                {entry.scopeRef && <span className="max-w-44 truncate normal-case tracking-normal">{entry.scopeRef}</span>}
                {entry.expiredAt && (
                  <span
                    className="rounded-full border px-1.5 py-0.5"
                    style={{ borderColor: 'rgba(213,106,106,0.45)', color: colors.error }}
                  >
                    expired {entry.expiredAt.slice(0, 10)}
                  </span>
                )}
                {entry.readOnly && (
                  <span
                    className="rounded-full border px-1.5 py-0.5"
                    style={{ borderColor: 'rgba(203,162,90,0.45)', color: colors.bronzeHot }}
                  >
                    read-only
                  </span>
                )}
              </div>
            </div>
            {entry.expiredAt ? (
              <button
                type="button"
                aria-label={`Restore ${entry.title}`}
                disabled={isBusy}
                onClick={() => void restore(entry.id)}
                className="flex min-h-7 items-center gap-1 rounded-md border px-2 text-[9.5px] disabled:opacity-40"
                style={{ borderColor: 'var(--color-line-strong)', color: colors.bronzeHot }}
              >
                <IconRestore size={11} /> Restore
              </button>
            ) : (
              <label className="flex min-h-7 cursor-pointer items-center gap-1.5 text-[9.5px]" style={{ color: colors.quartzDim }}>
                <input
                  type="checkbox"
                  aria-label={`Enable ${entry.title}`}
                  checked={entry.enabled}
                  disabled={isBusy || entry.readOnly === true}
                  onChange={(event) => void setEnabled(entry.id, event.target.checked)}
                  className="size-3.5 accent-[#CBA25A]"
                />
                {entry.enabled ? 'On' : 'Off'}
              </label>
            )}
          </div>
          {entry.body && (
            <p className="mt-2 line-clamp-3 whitespace-pre-wrap text-[10px] leading-relaxed" style={{ color: colors.quartzDim }}>
              {entry.body}
            </p>
          )}
          <div className="mt-2 flex justify-end gap-1">
            {/* w17/context-blocks — a locked fact rejects writes in the store;
                unlocking is the one write it accepts, so the lock is reversible. */}
            {entry.readOnly ? (
              <button
                type="button"
                aria-label={`Unlock ${entry.title}`}
                disabled={isBusy}
                onClick={() => void save({ ...entry, readOnly: false })}
                className="rounded-md border px-2 py-1 text-[9.5px] disabled:opacity-40"
                style={{ borderColor: 'var(--color-line-strong)', color: colors.bronzeHot }}
              >
                Unlock to edit
              </button>
            ) : (
              <button
                type="button"
                aria-label={`Edit ${entry.title}`}
                onClick={() => setEditing(true)}
                className="rounded-md p-1.5"
                style={{ color: colors.quartzDim }}
              >
                <IconPencil size={12} stroke={1.5} />
              </button>
            )}
            {entry.readOnly ? null : confirmDelete ? (
              <button
                type="button"
                aria-label={`Confirm delete ${entry.title}`}
                disabled={isBusy}
                onBlur={() => setConfirmDelete(false)}
                onClick={() => void remove(entry.id)}
                className="rounded-md border px-2 py-1 text-[9.5px] disabled:opacity-40"
                style={{ borderColor: 'rgba(213,106,106,0.45)', color: colors.error }}
              >
                Confirm delete
              </button>
            ) : (
              <button
                type="button"
                aria-label={`Delete ${entry.title}`}
                onClick={() => setConfirmDelete(true)}
                className="rounded-md p-1.5"
                style={{ color: colors.quartzDim }}
              >
                <IconTrash size={12} stroke={1.5} />
              </button>
            )}
          </div>
        </>
      )}
    </article>
  )
}

export function MemorySettings(): JSX.Element {
  const scope = useMemoryStore((state) => state.scope)
  const scopeRef = useMemoryStore((state) => state.scopeRef)
  const entries = useMemoryStore((state) => state.entries)
  const proposals = useMemoryStore((state) => state.proposals)
  const searchResults = useMemoryStore((state) => state.searchResults)
  const loading = useMemoryStore((state) => state.loading)
  const busy = useMemoryStore((state) => state.busy)
  const error = useMemoryStore((state) => state.error)
  const start = useMemoryStore((state) => state.start)
  const setScope = useMemoryStore((state) => state.setScope)
  const setScopeRef = useMemoryStore((state) => state.setScopeRef)
  const search = useMemoryStore((state) => state.search)
  const addRule = useMemoryStore((state) => state.addRule)
  const resolveProposal = useMemoryStore((state) => state.resolveProposal)
  const spaces = useSpaceStore((state) => state.spaces)
  const [query, setQuery] = useState('')
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [bootstrapReview, setBootstrapReview] = useState<MemoryBootstrapReview | null>(null)
  const [bootstrapSelected, setBootstrapSelected] = useState<Set<string>>(new Set())
  const [bootstrapBusy, setBootstrapBusy] = useState<'scan' | 'apply' | null>(null)
  const [bootstrapStatus, setBootstrapStatus] = useState('')

  useEffect(() => start(), [start])
  useEffect(() => {
    const timer = window.setTimeout(() => void search(query), 250)
    return () => window.clearTimeout(timer)
  }, [query, search])

  const pending = proposals.filter((proposal) => proposal.state === 'pending')
  const visibleEntries = query.trim() ? searchResults : entries

  const memoryApi = (): MorzMemoryApi | undefined =>
    (window as unknown as { morz?: { memory?: MorzMemoryApi } }).morz?.memory

  const buildMemory = (): void => {
    const api = memoryApi()
    if (!api) return
    setBootstrapBusy('scan')
    setBootstrapStatus('')
    void api
      .bootstrap(spaces.map(({ id, name, root }) => ({ id, name, root })))
      .then((review) => {
        setBootstrapReview(review)
        setBootstrapSelected(new Set(
          review.groups
            .flatMap((group) => group.items)
            .filter((item) => item.proposal.op?.kind !== 'noop')
            .map((item) => item.id)
        ))
      })
      .catch((reason: unknown) => {
        setBootstrapStatus(reason instanceof Error ? reason.message : String(reason))
      })
      .finally(() => setBootstrapBusy(null))
  }

  const applyBootstrap = (): void => {
    const api = memoryApi()
    if (!api || !bootstrapReview) return
    setBootstrapBusy('apply')
    setBootstrapStatus('')
    void api
      .applyBootstrap(bootstrapReview.reviewId, [...bootstrapSelected])
      .then(async (result) => {
        setBootstrapStatus(
          `${result.applied} imported${result.skipped ? `, ${result.skipped} skipped` : ''}.`
        )
        setBootstrapReview(null)
        setBootstrapSelected(new Set())
        await useMemoryStore.getState().refresh()
      })
      .catch((reason: unknown) => {
        setBootstrapStatus(reason instanceof Error ? reason.message : String(reason))
      })
      .finally(() => setBootstrapBusy(null))
  }

  const submitRule = (event: FormEvent): void => {
    event.preventDefault()
    void addRule(title, body).then(() => {
      setTitle('')
      setBody('')
    }).catch(() => undefined)
  }

  return (
    <section
      className="mt-5 rounded-xl border p-3"
      style={{ background: colors.panel, borderColor: 'var(--color-line)' }}
      aria-label="Learning memory"
      role="region"
    >
      <div className="flex items-start gap-3">
        <span
          className="flex size-8 shrink-0 items-center justify-center rounded-lg border"
          style={{ borderColor: 'var(--color-line-strong)', color: colors.bronzeHot }}
        >
          <IconBrain size={16} stroke={1.6} />
        </span>
        <div>
          <h3 className="text-xs font-semibold" style={{ fontFamily: 'var(--font-display)' }}>
            Learning memory
          </h3>
          <p className="mt-0.5 text-[10.5px] leading-relaxed" style={{ color: colors.quartzDim }}>
            Local Markdown rules and context shared with agents. Learned changes always wait for approval.
          </p>
        </div>
        <span className="ml-auto rounded-full border px-2 py-1 text-[9.5px]" style={{ borderColor: 'var(--color-line-strong)', color: colors.quartzDim }}>
          {entries.length} in scope
        </span>
      </div>

      <div className="mt-3 rounded-lg border p-2.5" style={{ borderColor: 'var(--color-line)' }}>
        <div className="flex items-center justify-between gap-2">
          <div>
            <p className="text-[10px] font-semibold" style={{ color: colors.quartz }}>
              Build memory from existing guidance
            </p>
            <p className="mt-0.5 text-[9.5px] leading-relaxed" style={{ color: colors.quartzDim }}>
              Review Claude files and space docs together. Nothing is imported until Apply.
            </p>
          </div>
          <button
            type="button"
            onClick={buildMemory}
            disabled={bootstrapBusy !== null}
            className="min-h-7 shrink-0 rounded-md border px-2.5 text-[9.5px] font-semibold disabled:opacity-40"
            style={{ borderColor: 'var(--color-line-strong)', color: colors.bronzeHot }}
          >
            {bootstrapBusy === 'scan' ? 'Scanning…' : 'Build memory from my files…'}
          </button>
        </div>

        {bootstrapReview && (
          <section
            className="mt-2 rounded-md border p-2"
            style={{ background: colors.card, borderColor: 'var(--color-line-strong)' }}
            aria-label="Memory bootstrap review"
          >
            <p className="text-[10px]" data-testid="memory-bootstrap-counts" style={{ color: colors.quartz }}>
              {bootstrapReview.counts.filesScanned} files scanned
              {bootstrapReview.counts.filesRead !== bootstrapReview.counts.filesScanned
                ? ` (${bootstrapReview.counts.filesRead} read)`
                : ''}
              {`, ${bootstrapReview.counts.candidates} candidates, ${bootstrapReview.counts.adds} new / ${bootstrapReview.counts.updates} updates`}
              {bootstrapReview.counts.deletes ? ` / ${bootstrapReview.counts.deletes} deletes` : ''}
              {` / ${bootstrapReview.counts.noops} skipped`}
            </p>
            <div className="mt-2 flex gap-1.5">
              <button
                type="button"
                onClick={() => setBootstrapSelected(new Set(
                  bootstrapReview.groups
                    .flatMap((group) => group.items)
                    .filter((item) => item.proposal.op?.kind !== 'noop')
                    .map((item) => item.id)
                ))}
                className="min-h-7 rounded-md border px-2 text-[9.5px]"
                style={{ borderColor: 'var(--color-line-strong)', color: colors.quartzDim }}
              >
                Select all
              </button>
              <button
                type="button"
                onClick={() => setBootstrapSelected(new Set())}
                className="min-h-7 rounded-md border px-2 text-[9.5px]"
                style={{ borderColor: 'var(--color-line-strong)', color: colors.quartzDim }}
              >
                Select none
              </button>
            </div>
            <div className="mt-2 max-h-72 space-y-2 overflow-y-auto">
              {bootstrapReview.groups.map((group) => (
                <div key={group.source} className="rounded-md border p-2" style={{ borderColor: 'var(--color-line)' }}>
                  <p className="break-all text-[9px] font-semibold" style={{ color: colors.quartzDim }}>
                    {group.source}
                  </p>
                  <div className="mt-1.5 space-y-1">
                    {group.items.map((item) => {
                      const noop = item.proposal.op?.kind === 'noop'
                      return (
                        <label key={item.id} className="flex items-start gap-2 text-[9.5px]" style={{ color: colors.quartz }}>
                          <input
                            type="checkbox"
                            aria-label={`Select ${item.proposal.entry.title}`}
                            checked={bootstrapSelected.has(item.id)}
                            disabled={noop}
                            onChange={(event) => {
                              setBootstrapSelected((current) => {
                                const next = new Set(current)
                                if (event.target.checked) next.add(item.id)
                                else next.delete(item.id)
                                return next
                              })
                            }}
                            className="mt-0.5 size-3.5"
                            style={{ accentColor: colors.bronze }}
                          />
                          <span>
                            <span className="font-semibold">{item.proposal.entry.title}</span>
                            <span className="ml-1 uppercase" style={{ color: noop ? colors.quartzDim : colors.bronzeHot }}>
                              {noop ? 'skipped' : item.proposal.op?.kind ?? 'add'}
                            </span>
                            {item.proposal.entry.body && (
                              <span className="mt-0.5 block line-clamp-2" style={{ color: colors.quartzDim }}>
                                {item.proposal.entry.body}
                              </span>
                            )}
                          </span>
                        </label>
                      )
                    })}
                  </div>
                </div>
              ))}
            </div>
            {bootstrapReview.truncations.length > 0 && (
              <ul className="mt-2 space-y-0.5 text-[9px]" style={{ color: colors.quartzDim }}>
                {bootstrapReview.truncations.map((line) => <li key={line}>{line}</li>)}
              </ul>
            )}
            <button
              type="button"
              onClick={applyBootstrap}
              disabled={bootstrapBusy !== null || bootstrapSelected.size === 0}
              className="mt-2 min-h-7 rounded-md px-2.5 text-[9.5px] font-semibold disabled:opacity-40"
              style={{ background: colors.bronze, color: colors.page }}
            >
              {bootstrapBusy === 'apply' ? 'Applying…' : `Apply ${bootstrapSelected.size} selected`}
            </button>
          </section>
        )}
        {bootstrapStatus && (
          <p className="mt-2 text-[9.5px]" role="status" style={{ color: colors.quartzDim }}>
            {bootstrapStatus}
          </p>
        )}
      </div>

      <div className="mt-3 flex gap-1 border-t pt-3" style={{ borderColor: 'var(--color-line)' }} role="tablist" aria-label="Memory scope">
        {SCOPES.map((item) => (
          <button
            key={item}
            type="button"
            role="tab"
            aria-selected={scope === item}
            onClick={() => setScope(item)}
            className="min-h-7 flex-1 rounded-md border px-1.5 text-[9.5px] capitalize"
            style={{
              background: scope === item ? colors.card : 'transparent',
              borderColor: scope === item ? 'rgba(203,162,90,0.45)' : 'var(--color-line)',
              color: scope === item ? colors.bronzeHot : colors.quartzDim
            }}
          >
            {item}
          </button>
        ))}
      </div>

      {scope !== 'global' && (
        <div className="mt-2 flex gap-2">
          <input
            aria-label={`${scope} reference`}
            value={scopeRef}
            onChange={(event) => setScopeRef(event.target.value)}
            onBlur={() => void useMemoryStore.getState().refresh()}
            placeholder={scope === 'project' ? 'Project root' : `${scope} id`}
            className="min-h-8 min-w-0 flex-1 rounded-md border bg-transparent px-2 text-[10px] outline-none focus:border-[#CBA25A]"
            style={{ borderColor: 'var(--color-line-strong)', color: colors.quartz }}
          />
        </div>
      )}

      <label className="mt-2 flex min-h-8 items-center gap-2 rounded-md border px-2" style={{ borderColor: 'var(--color-line-strong)' }}>
        <IconSearch size={12} stroke={1.5} style={{ color: colors.quartzDim }} />
        <input
          type="search"
          aria-label="Search memory"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search titles and notes"
          className="min-w-0 flex-1 bg-transparent text-[10.5px] outline-none"
          style={{ color: colors.quartz }}
        />
      </label>

      <form onSubmit={submitRule} className="mt-3 rounded-lg border p-2.5" style={{ borderColor: 'var(--color-line)' }}>
        <p className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.08em]" style={{ color: colors.bronzeHot }}>
          <IconPlus size={11} /> Add rule
        </p>
        <input
          aria-label="Rule title"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          maxLength={240}
          placeholder="One-line preference"
          className="mt-2 min-h-8 w-full rounded-md border bg-transparent px-2 text-[10.5px] outline-none focus:border-[#CBA25A]"
          style={{ borderColor: 'var(--color-line-strong)', color: colors.quartz }}
        />
        <textarea
          aria-label="Rule details"
          value={body}
          onChange={(event) => setBody(event.target.value)}
          rows={2}
          placeholder="Why it matters and how to apply it"
          className="mt-2 w-full resize-y rounded-md border bg-transparent px-2 py-1.5 text-[10px] leading-relaxed outline-none focus:border-[#CBA25A]"
          style={{ borderColor: 'var(--color-line-strong)', color: colors.quartz }}
        />
        <button
          type="submit"
          disabled={!title.trim() || busy === 'add'}
          className="mt-2 flex min-h-7 items-center gap-1.5 rounded-md px-2.5 text-[10px] font-semibold disabled:opacity-40"
          style={{ background: colors.bronze, color: colors.page }}
        >
          <IconPlus size={11} /> Save rule
        </button>
      </form>

      <div className="mt-3 space-y-2" aria-live="polite">
        {loading && visibleEntries.length === 0 && <p className="text-[10px]" style={{ color: colors.quartzDim }}>Loading memory…</p>}
        {!loading && visibleEntries.length === 0 && (
          <p className="rounded-lg border border-dashed px-3 py-4 text-center text-[10px]" style={{ borderColor: 'var(--color-line)', color: colors.quartzDim }}>
            {query.trim() ? 'No matching memory.' : 'No memory saved in this scope yet.'}
          </p>
        )}
        {visibleEntries.map((entry) => <EntryCard key={entry.id} entry={entry} />)}
      </div>

      <div className="mt-4 border-t pt-3" style={{ borderColor: 'var(--color-line)' }}>
        <div className="flex items-center justify-between">
          <h4 className="text-[10px] font-semibold uppercase tracking-[0.1em]" style={{ color: colors.bronzeHot }}>
            Pending proposals
          </h4>
          <span className="text-[9.5px]" style={{ color: colors.quartzDim }}>{pending.length}</span>
        </div>
        {pending.length === 0 ? (
          <p className="mt-2 text-[10px]" style={{ color: colors.quartzDim }}>No learned changes are waiting.</p>
        ) : (
          <div className="mt-2 space-y-2">
            {pending.map((proposal) => (
              <article key={proposal.id} className="rounded-lg border p-2.5" style={{ background: colors.card, borderColor: 'rgba(203,162,90,0.35)' }}>
                <p className="text-[11px] font-semibold">
                  {proposal.op && proposal.op.kind !== 'add' && (
                    <span
                      className="mr-1.5 rounded-full border px-1.5 py-0.5 text-[8.5px] font-semibold uppercase tracking-[0.08em]"
                      style={{
                        borderColor: proposal.op.kind === 'delete' ? 'rgba(213,106,106,0.45)' : 'rgba(203,162,90,0.45)',
                        color: proposal.op.kind === 'delete' ? colors.error : colors.bronzeHot
                      }}
                    >
                      {proposal.op.kind}
                    </span>
                  )}
                  {proposal.entry.title}
                </p>
                {proposal.entry.body && <p className="mt-1 text-[10px] leading-relaxed" style={{ color: colors.quartzDim }}>{proposal.entry.body}</p>}
                {proposal.op && <OpDiff op={proposal.op} />}
                <ul className="mt-2 space-y-1 border-l pl-2 text-[9.5px] leading-relaxed" style={{ borderColor: 'var(--color-line-strong)', color: colors.quartzDim }}>
                  {proposal.evidence.map((line, index) => <li key={`${proposal.id}-${index}`}>{line}</li>)}
                </ul>
                <div className="mt-2 flex gap-1.5">
                  <button
                    type="button"
                    aria-label={`Approve ${proposal.entry.title}`}
                    disabled={busy === `proposal:${proposal.id}`}
                    onClick={() => void resolveProposal(proposal.id, true)}
                    className="flex min-h-7 items-center gap-1 rounded-md px-2 text-[9.5px] font-semibold disabled:opacity-40"
                    style={{ background: colors.bronze, color: colors.page }}
                  >
                    <IconCheck size={11} /> Approve
                  </button>
                  <button
                    type="button"
                    aria-label={`Reject ${proposal.entry.title}`}
                    disabled={busy === `proposal:${proposal.id}`}
                    onClick={() => void resolveProposal(proposal.id, false)}
                    className="flex min-h-7 items-center gap-1 rounded-md border px-2 text-[9.5px] disabled:opacity-40"
                    style={{ borderColor: 'var(--color-line-strong)', color: colors.quartzDim }}
                  >
                    <IconX size={11} /> Reject
                  </button>
                </div>
              </article>
            ))}
          </div>
        )}
      </div>

      {error && <p role="alert" className="mt-3 text-[10px] leading-relaxed" style={{ color: colors.error }}>{error}</p>}
    </section>
  )
}
