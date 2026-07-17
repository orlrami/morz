import { useEffect, useMemo } from 'react'
import {
  IconAlertCircle,
  IconCheck,
  IconFileDiff,
  IconGitBranch,
  IconGitCommit,
  IconLoader2,
  IconMinus,
  IconPlus,
  IconRefresh,
  IconSparkles,
  IconTrash
} from '@tabler/icons-react'
import type { GitFile } from '@shared/ipc'
import { colors } from '@/lib/tokens'
import { useCommitStore } from '@/store/commitStore'
import { useModeStore } from '@/store/modeStore'
import { selectActiveSpaceRoot, useSpaceStore } from '@/store/spaceStore'

interface DiffHunk {
  heading: string
  lines: string[]
  patch: string
}

interface ParsedDiff {
  header: string[]
  hunks: DiffHunk[]
}

function parseDiff(diff: string): ParsedDiff {
  if (!diff) return { header: [], hunks: [] }
  const lines = diff.replace(/\r\n/g, '\n').split('\n')
  const firstHunk = lines.findIndex((line) => line.startsWith('@@'))
  if (firstHunk < 0) return { header: lines.filter(Boolean), hunks: [] }
  const header = lines.slice(0, firstHunk)
  const hunks: DiffHunk[] = []
  let cursor = firstHunk
  while (cursor < lines.length) {
    const next = lines.findIndex((line, index) => index > cursor && line.startsWith('@@'))
    const end = next < 0 ? lines.length : next
    const hunkLines = lines.slice(cursor, end)
    hunks.push({
      heading: hunkLines[0],
      lines: hunkLines.slice(1),
      patch: `${[...header, ...hunkLines].join('\n')}\n`
    })
    if (next < 0) break
    cursor = next
  }
  return { header, hunks }
}

function isStaged(file: GitFile): boolean {
  return file.index !== '.' && file.index !== '?'
}

function isUnstaged(file: GitFile): boolean {
  return file.worktree !== '.' || file.index === '?'
}

function statusCode(file: GitFile, staged: boolean): string {
  const code = staged ? file.index : file.worktree
  return code === '?' ? 'U' : code
}

function statusColor(code: string): string {
  if (code === 'A' || code === 'U') return colors.done
  if (code === 'D') return colors.error
  return colors.warning
}

export function CommitPanel(): JSX.Element {
  const root = useSpaceStore(selectActiveSpaceRoot)
  const mode = useModeStore((state) => state.mode)
  const {
    root: loadedRoot,
    files,
    selectedPath,
    diff,
    log,
    selectedCommitSha,
    lastCommitSha,
    summary,
    message,
    loading,
    busy,
    error,
    setMessage,
    refresh,
    selectFile,
    stageFile,
    unstageFile,
    stageHunk,
    discardFile,
    createCommit,
    suggestMessage,
    summarizeCommit,
    summarizeFile,
    summarizeBranch
  } = useCommitStore()

  useEffect(() => {
    void refresh(root)
  }, [refresh, root])

  const unstaged = useMemo(() => files.filter(isUnstaged), [files])
  const staged = useMemo(() => files.filter(isStaged), [files])
  const aiAllowed = mode !== 'manual'
  const interactive = !!root && loadedRoot === root && !loading
  const effectiveBusy = interactive ? busy : 'space-root'
  const working = !interactive || busy !== null
  const summaryBusy = summary?.status === 'loading'

  const confirmDiscard = (path: string): void => {
    if (!interactive) return
    if (!window.confirm(`Discard all unstaged changes in ${path}? This cannot be undone.`)) return
    void discardFile(root, path, true)
  }

  const commit = async (): Promise<void> => {
    if (!interactive) return
    const commitMessage = message.trim()
    const sha = await createCommit(root)
    if (!sha) return
    const shortSha = sha.slice(0, 7)
    window.morz.notify?.emit({
      id: `app:commit:${sha}`,
      level: 'success',
      source: 'app',
      title: `Committed ${shortSha}`,
      detail: commitMessage
    })
  }

  return (
    <section
      className="grid min-h-0 min-w-0 flex-1 grid-cols-[minmax(180px,0.85fr)_minmax(230px,1fr)_minmax(0,2fr)]"
      style={{ background: colors.page }}
      aria-label="Commit"
    >
      <FileColumn
        title="Unstaged"
        files={unstaged}
        staged={false}
        selectedPath={selectedPath}
        busy={effectiveBusy}
        onSelect={(path) => void selectFile(root, path)}
        onPrimary={(path) => void stageFile(root, path)}
        onDiscard={confirmDiscard}
      />

      <div className="flex min-h-0 flex-col border-r" style={{ borderColor: 'var(--color-line)' }}>
        <FileColumnContent
          title="Staged"
          files={staged}
          staged
          selectedPath={selectedPath}
          busy={effectiveBusy}
          onSelect={(path) => void selectFile(root, path)}
          onPrimary={(path) => void unstageFile(root, path)}
        />

        <div className="border-t p-3" style={{ borderColor: 'var(--color-line)' }}>
          <label
            htmlFor="commit-message"
            className="mb-1.5 block text-[9.5px] font-semibold uppercase tracking-[0.12em]"
            style={{ color: colors.quartzDim }}
          >
            Commit message
          </label>
          <textarea
            id="commit-message"
            value={message}
            onChange={(event) => setMessage(event.target.value)}
            placeholder="type(scope): summary"
            rows={3}
            className="w-full resize-none rounded-[10px] border bg-transparent p-2.5 text-xs outline-none transition-shadow focus:ring-2"
            style={{
              borderColor: 'var(--color-line-strong)',
              color: colors.quartz,
              background: colors.panel,
              ['--tw-ring-color' as string]: 'rgba(203,162,90,0.35)'
            }}
          />
          <div className="mt-2 flex gap-2">
            {aiAllowed && (
              <button
                type="button"
                onClick={() => void suggestMessage(root)}
                disabled={working || staged.length === 0}
                className="flex cursor-pointer items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-[10.5px] disabled:cursor-not-allowed disabled:opacity-40"
                style={{ borderColor: 'var(--color-line-strong)', color: colors.bronzeHot }}
                title="Suggest from the staged diff; you can edit it before committing"
              >
                {busy === 'suggest' ? (
                  <IconLoader2 className="animate-spin" size={13} />
                ) : (
                  <IconSparkles size={13} stroke={1.6} />
                )}
                Suggest message
              </button>
            )}
            <button
              type="button"
              onClick={() => void commit()}
              disabled={working || staged.length === 0 || !message.trim()}
              className="ml-auto flex cursor-pointer items-center gap-1.5 rounded-lg px-3 py-1.5 text-[10.5px] font-semibold disabled:cursor-not-allowed disabled:opacity-40"
              style={{ background: colors.bronze, color: colors.page }}
            >
              {busy === 'commit' ? (
                <IconLoader2 className="animate-spin" size={13} />
              ) : (
                <IconGitCommit size={13} stroke={2} />
              )}
              Commit
            </button>
          </div>
          {lastCommitSha && (
            <div
              role="status"
              aria-live="polite"
              className="mt-2 flex items-center gap-1.5 text-[10.5px]"
              style={{ color: colors.done }}
            >
              <IconCheck size={13} stroke={2} />
              Committed {lastCommitSha.slice(0, 7)}
            </div>
          )}
        </div>

        <div className="min-h-0 flex-1 border-t" style={{ borderColor: 'var(--color-line)' }}>
          <div className="flex items-center px-3 pb-1 pt-2 text-[9.5px] font-semibold uppercase tracking-[0.12em]" style={{ color: colors.quartzDim }}>
            <span>Recent commits</span>
            <button
              type="button"
              onClick={() => void summarizeBranch(root)}
              disabled={!interactive || summaryBusy}
              className="ml-auto flex cursor-pointer items-center gap-1 rounded px-1.5 py-1 normal-case tracking-normal disabled:cursor-not-allowed disabled:opacity-40"
              style={{ color: colors.bronzeHot }}
              aria-label="Summarize branch"
              title="Explain this branch compared with its base"
            >
              {summaryBusy && summary?.title.startsWith('Branch') ? (
                <IconLoader2 className="animate-spin" size={11} />
              ) : (
                <IconGitBranch size={11} stroke={1.7} />
              )}
              Branch summary
            </button>
          </div>
          <ol className="max-h-full overflow-y-auto px-2 pb-2">
            {log.map((entry) => (
              <li key={entry.sha}>
                <button
                  type="button"
                  onClick={() => void summarizeCommit(root, entry)}
                  disabled={!interactive || summaryBusy}
                  className="mb-0.5 flex w-full cursor-pointer items-center gap-2 rounded-md border px-1.5 py-1 text-left text-[10px] disabled:cursor-not-allowed disabled:opacity-55"
                  style={{
                    borderColor: selectedCommitSha === entry.sha ? 'rgba(203,162,90,0.42)' : 'transparent',
                    background: selectedCommitSha === entry.sha ? colors.card : 'transparent'
                  }}
                  aria-label={`Explain commit ${entry.shortSha}: ${entry.subject}`}
                  title={`${entry.author} · ${new Date(entry.date).toLocaleString()}`}
                >
                  <span className="shrink-0 font-mono" style={{ color: colors.bronzeHot }}>
                    {entry.shortSha}
                  </span>
                  <span className="min-w-0 flex-1 truncate" style={{ color: colors.quartzDim }}>
                    {entry.subject}
                  </span>
                </button>
              </li>
            ))}
          </ol>
        </div>
      </div>

      <div className="flex min-h-0 min-w-0 flex-col">
        <header
          className="flex h-9 shrink-0 items-center gap-2 border-b px-3"
          style={{ borderColor: 'var(--color-line)', color: colors.quartzDim }}
        >
          <IconFileDiff size={14} stroke={1.5} style={{ color: colors.bronzeHot }} />
          <span className="min-w-0 truncate font-mono text-[10.5px]">
            {selectedPath ?? 'Select a changed file'}
          </span>
          {selectedPath && (
            <button
              type="button"
              onClick={() => void summarizeFile(root, selectedPath)}
              disabled={!interactive || summaryBusy}
              className="ml-auto flex cursor-pointer items-center gap-1.5 rounded-md border px-2 py-1 text-[10px] disabled:cursor-not-allowed disabled:opacity-40"
              style={{ borderColor: 'var(--color-line-strong)', color: colors.bronzeHot }}
              title="Include this file's Git history and current diff"
            >
              {summaryBusy && summary?.title === `File ${selectedPath}` ? (
                <IconLoader2 className="animate-spin" size={11} />
              ) : (
                <IconSparkles size={11} stroke={1.7} />
              )}
              Explain this change
            </button>
          )}
          <button
            type="button"
            onClick={() => void refresh(root)}
            disabled={loading || working}
            className={`${selectedPath ? '' : 'ml-auto'} cursor-pointer rounded-md p-1 disabled:opacity-40`}
            aria-label="Refresh commit status"
            title="Refresh"
          >
            <IconRefresh className={loading ? 'animate-spin' : ''} size={13} />
          </button>
        </header>

        {error && (
          <div
            role="alert"
            className="m-3 flex items-start gap-2 rounded-lg border px-3 py-2 text-[10.5px]"
            style={{ borderColor: `${colors.error}66`, background: `${colors.error}12`, color: colors.error }}
          >
            <IconAlertCircle className="mt-px shrink-0" size={13} />
            <span>{error}</span>
          </div>
        )}

        <div className="min-h-0 flex-1 overflow-auto p-3 font-mono text-[11px] leading-[1.55]">
          {summary && <CommitSummaryCard summary={summary} />}
          {!diff && !loading && (
            <div className="flex h-full items-center justify-center text-xs" style={{ color: colors.quartzDim }}>
              No changed file selected
            </div>
          )}
          {diff && (
            <>
              <DiffSection title="Staged" diff={diff.staged} />
              <DiffSection
                title="Unstaged"
                diff={diff.unstaged}
                onStageHunk={(patch) => void stageHunk(root, patch)}
                disabled={working}
              />
              {!diff.staged && !diff.unstaged && (
                <div className="flex h-full items-center justify-center text-xs" style={{ color: colors.quartzDim }}>
                  No diff for this file
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </section>
  )
}

function CommitSummaryCard({ summary }: { summary: NonNullable<ReturnType<typeof useCommitStore.getState>['summary']> }): JSX.Element {
  const tone = summary.status === 'error' ? colors.error : summary.status === 'hint' ? colors.warning : colors.bronzeHot
  return (
    <section
      data-testid="commit-ai-summary"
      aria-live="polite"
      className="mb-4 rounded-lg border p-3 font-sans"
      style={{ borderColor: `${tone}55`, background: colors.panel }}
    >
      <div className="flex items-center gap-2 text-[9.5px] font-semibold uppercase tracking-[0.12em]" style={{ color: tone }}>
        {summary.status === 'loading' ? (
          <IconLoader2 className="animate-spin" size={12} />
        ) : (
          <IconSparkles size={12} stroke={1.7} />
        )}
        {summary.title}
      </div>
      <div className="mt-2 whitespace-pre-wrap text-[11px] leading-relaxed" style={{ color: colors.quartz }}>
        {summary.status === 'loading' ? 'Reading Git context and asking the report engine…' : summary.text}
      </div>
    </section>
  )
}

function FileColumn(props: Parameters<typeof FileColumnContent>[0]): JSX.Element {
  return (
    <div className="flex min-h-0 flex-col border-r" style={{ borderColor: 'var(--color-line)' }}>
      <FileColumnContent {...props} />
    </div>
  )
}

function FileColumnContent({
  title,
  files,
  staged,
  selectedPath,
  busy,
  onSelect,
  onPrimary,
  onDiscard
}: {
  title: string
  files: GitFile[]
  staged: boolean
  selectedPath: string | null
  busy: string | null
  onSelect(path: string): void
  onPrimary(path: string): void
  onDiscard?(path: string): void
}): JSX.Element {
  return (
    <div className="flex min-h-0 flex-col">
      <header
        className="flex h-9 shrink-0 items-center border-b px-3 text-[9.5px] font-semibold uppercase tracking-[0.12em]"
        style={{ borderColor: 'var(--color-line)', color: colors.quartzDim }}
      >
        {title}
        <span className="ml-auto rounded-full px-1.5 py-px text-[9px]" style={{ background: colors.card, color: colors.quartz }}>
          {files.length}
        </span>
      </header>
      <ul className="min-h-0 overflow-y-auto p-2">
        {files.map((file) => {
          const selected = selectedPath === file.path
          const code = statusCode(file, staged)
          const actionBusy = busy?.endsWith(`:${file.path}`) ?? false
          return (
            <li key={file.path}>
              <div
                className="mb-0.5 flex w-full items-center gap-1 rounded-lg border px-1 py-0.5"
                style={{
                  borderColor: selected ? 'rgba(203,162,90,0.42)' : 'transparent',
                  background: selected ? colors.card : 'transparent',
                  color: selected ? colors.quartz : colors.quartzDim
                }}
              >
                <button
                  type="button"
                  onClick={() => onSelect(file.path)}
                  className="flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 px-1 py-1 text-left"
                  title={file.path}
                >
                  <span className="w-3 shrink-0 text-center font-mono text-[9px] font-bold" style={{ color: statusColor(code) }}>
                    {code}
                  </span>
                  <span className="min-w-0 flex-1 truncate font-mono text-[10.5px]">{file.path}</span>
                </button>
                {onDiscard && (
                  <button
                    type="button"
                    disabled={busy !== null}
                    aria-label={`Discard ${file.path}`}
                    title={`Discard unstaged changes in ${file.path}`}
                    onClick={() => onDiscard(file.path)}
                    className="cursor-pointer rounded p-1 opacity-60 hover:opacity-100 focus:opacity-100 disabled:cursor-not-allowed disabled:opacity-30"
                    style={{ color: colors.error }}
                  >
                    <IconTrash size={11} stroke={1.7} />
                  </button>
                )}
                <button
                  type="button"
                  disabled={busy !== null}
                  aria-label={`${staged ? 'Unstage' : 'Stage'} ${file.path}`}
                  title={`${staged ? 'Unstage' : 'Stage'} ${file.path}`}
                  onClick={() => onPrimary(file.path)}
                  className="cursor-pointer rounded p-1 opacity-70 hover:opacity-100 focus:opacity-100 disabled:cursor-not-allowed disabled:opacity-30"
                  style={{ color: staged ? colors.quartzDim : colors.done }}
                >
                  {actionBusy ? (
                    <IconLoader2 className="animate-spin" size={11} />
                  ) : staged ? (
                    <IconMinus size={11} stroke={2} />
                  ) : (
                    <IconPlus size={11} stroke={2} />
                  )}
                </button>
              </div>
            </li>
          )
        })}
        {files.length === 0 && (
          <li className="px-2 py-5 text-center text-[10px]" style={{ color: colors.quartzDim }}>
            Nothing {staged ? 'staged' : 'unstaged'}
          </li>
        )}
      </ul>
    </div>
  )
}

function DiffSection({
  title,
  diff,
  onStageHunk,
  disabled = false
}: {
  title: string
  diff: string
  onStageHunk?(patch: string): void
  disabled?: boolean
}): JSX.Element | null {
  const parsed = useMemo(() => parseDiff(diff), [diff])
  if (!diff) return null
  return (
    <section className="mb-5" aria-label={`${title} diff`}>
      <div className="sticky top-0 z-10 mb-1 flex items-center gap-2 py-1" style={{ background: colors.page }}>
        <span className="text-[9.5px] font-semibold uppercase tracking-[0.12em]" style={{ color: colors.quartzDim }}>
          {title}
        </span>
        <span className="h-px flex-1" style={{ background: 'var(--color-line)' }} />
      </div>
      {parsed.header.map((line, index) => (
        <DiffLine key={`header-${index}`} line={line} />
      ))}
      {parsed.hunks.map((hunk, index) => (
        <div key={`${hunk.heading}-${index}`} className="mt-2">
          <div
            className="flex items-center rounded-md border px-2 py-1"
            style={{ borderColor: 'var(--color-line-strong)', background: colors.panel, color: colors.bronzeHot }}
          >
            <span className="truncate">{hunk.heading}</span>
            {onStageHunk && (
              <button
                type="button"
                disabled={disabled}
                onClick={() => onStageHunk(hunk.patch)}
                className="ml-auto flex cursor-pointer items-center gap-1 rounded px-1.5 py-0.5 text-[9px] disabled:cursor-not-allowed disabled:opacity-40"
                style={{ background: colors.card, color: colors.done }}
              >
                <IconPlus size={10} stroke={2} />
                Stage hunk
              </button>
            )}
          </div>
          <div className="mt-1 overflow-x-auto">
            {hunk.lines.map((line, lineIndex) => (
              <DiffLine key={lineIndex} line={line} />
            ))}
          </div>
        </div>
      ))}
    </section>
  )
}

function DiffLine({ line }: { line: string }): JSX.Element {
  const added = line.startsWith('+') && !line.startsWith('+++')
  const removed = line.startsWith('-') && !line.startsWith('---')
  return (
    <div
      className="min-w-max whitespace-pre px-2"
      style={{
        color: added ? colors.done : removed ? colors.error : colors.quartzDim,
        background: added ? 'rgba(34,197,94,0.07)' : removed ? 'rgba(239,68,68,0.07)' : 'transparent'
      }}
    >
      {line || ' '}
    </div>
  )
}
