import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import {
  IconChevronDown,
  IconChevronRight,
  IconFile,
  IconFolder,
  IconFolderOpen,
  IconX
} from '@tabler/icons-react'
import type { FsEntry, GitFile } from '@shared/ipc'
import { openFile as openFileThroughSlot } from '@/lib/open-file' // w15/integration-slots
import { springs } from '@/lib/springs'
import { colors } from '@/lib/tokens'
import { getMorz, selectActiveSpace, selectActiveSpaceRoot, useSpaceStore } from '@/store/spaceStore'

interface ExplorerPanelProps {
  open: boolean
  onClose: () => void
}

type GitBadge = 'M' | 'A' | '?'

function pathKey(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

function gitBadge(file: GitFile): GitBadge | null {
  if (file.index === '?' || file.worktree === '?') return '?'
  if (file.index === 'A' || file.worktree === 'A') return 'A'
  if (file.index !== '.' || file.worktree !== '.') return 'M'
  return null
}

function gitBadgesByAbsolutePath(root: string, files: GitFile[]): ReadonlyMap<string, GitBadge> {
  const badges = new Map<string, GitBadge>()
  const rootPath = root.replace(/[\\/]+$/, '')
  for (const file of files) {
    const badge = gitBadge(file)
    if (!badge) continue
    badges.set(pathKey(`${rootPath}/${file.path}`), badge)
  }
  return badges
}

function badgeForEntry(
  entry: FsEntry,
  badgesByPath: ReadonlyMap<string, GitBadge>
): GitBadge | null {
  const entryPath = pathKey(entry.path)
  const exact = badgesByPath.get(entryPath)
  if (exact || entry.kind === 'file') return exact ?? null

  let aggregate: GitBadge | null = null
  const prefix = `${entryPath}/`
  for (const [path, badge] of badgesByPath) {
    if (!path.startsWith(prefix)) continue
    if (badge === '?') return '?'
    if (badge === 'A') aggregate = 'A'
    else if (!aggregate) aggregate = 'M'
  }
  return aggregate
}

/**
 * Core file tree for the active space. Directory data comes from the existing
 * fs:list service and file activation stays on the shared open-file event.
 */
export function ExplorerPanel({ open, onClose }: ExplorerPanelProps): JSX.Element | null {
  const reduceMotion = useReducedMotion() // w16/polish-motion — IdePane pattern
  const space = useSpaceStore(selectActiveSpace)
  const root = useSpaceStore(selectActiveSpaceRoot)
  const git = useSpaceStore((state) => (root ? state.gitByRoot[root] : undefined))
  const [childrenByPath, setChildrenByPath] = useState<Record<string, FsEntry[]>>({})
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [error, setError] = useState<string | null>(null)
  const rootGenerationRef = useRef(0)

  const badgesByPath = useMemo(
    () => gitBadgesByAbsolutePath(root, git?.files ?? []),
    [git?.files, root]
  )

  const load = useCallback(async (dir: string): Promise<void> => {
    const generation = rootGenerationRef.current
    const morz = getMorz()
    if (!morz) {
      if (generation === rootGenerationRef.current) setError('backend bridge unavailable')
      return
    }
    try {
      const entries = await morz.fs.list(dir)
      if (generation !== rootGenerationRef.current) return
      setChildrenByPath((current) => ({ ...current, [dir]: entries }))
      setError(null)
    } catch {
      if (generation === rootGenerationRef.current) setError(`cannot list ${dir}`)
    }
  }, [])

  useEffect(() => {
    rootGenerationRef.current += 1
    setChildrenByPath({})
    setExpanded(new Set())
    setError(null)
  }, [root])

  useEffect(() => {
    if (open && root) void load(root)
  }, [load, open, root])

  const toggleDir = useCallback(
    (path: string): void => {
      setExpanded((current) => {
        const next = new Set(current)
        if (next.has(path)) {
          next.delete(path)
        } else {
          next.add(path)
          if (!childrenByPath[path]) void load(path)
        }
        return next
      })
    },
    [childrenByPath, load]
  )

  /* w15/integration-slots — the editor slot decides where a file opens: the
   * in-app IDE slide-over, or VS Code / Cursor via `-g file:line`. */
  const openFile = useCallback((path: string): void => {
    void openFileThroughSlot(path)
  }, [])

  const rootEntries = root ? childrenByPath[root] : undefined
  /* w16/polish-motion — the panel slides in from the right on a spring (it used
   * to pop). Transform-only so terminals re-layout once, never per frame; the
   * tree rows themselves deliberately do NOT animate. */
  return (
    <AnimatePresence>
      {open && (
        <motion.aside
          initial={{ x: 32, opacity: 0 }}
          animate={{ x: 0, opacity: 1, transition: reduceMotion ? { duration: 0 } : springs.panel }}
          exit={{ x: 24, opacity: 0, transition: { duration: reduceMotion ? 0 : 0.12 } }}
          className="flex w-[224px] shrink-0 flex-col overflow-hidden border-l"
          style={{ background: colors.panel, borderColor: 'var(--color-line)' }}
          aria-label="File explorer"
          data-testid="explorer-panel"
        >
      <div
        className="flex h-10 shrink-0 items-center gap-2 border-b px-3"
        style={{ borderColor: 'var(--color-line)' }}
      >
        <IconFolderOpen size={14} stroke={1.5} style={{ color: colors.bronzeHot }} />
        <h2
          className="truncate text-xs font-semibold"
          style={{ fontFamily: 'var(--font-display)', color: colors.quartz }}
          title={root}
        >
          {space?.name ?? 'Explorer'}
        </h2>
        <button
          type="button"
          onClick={onClose}
          className="ml-auto cursor-pointer rounded p-0.5 transition-colors hover:bg-hover"
          aria-label="Close explorer"
          style={{ color: colors.quartzDim }}
        >
          <IconX size={13} stroke={1.5} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-1.5 text-xs" role="tree">
        {error && (
          <div className="px-1.5 py-1" style={{ color: colors.error }}>
            {error}
          </div>
        )}
        {!root && (
          <div className="px-1.5 py-1" style={{ color: colors.quartzDim }}>
            Open a folder to browse files.
          </div>
        )}
        {root && !error && !rootEntries && (
          <div className="px-1.5 py-1" style={{ color: colors.quartzDim }}>
            loading…
          </div>
        )}
        {rootEntries?.map((entry) => (
          <TreeRow
            key={entry.path}
            entry={entry}
            depth={0}
            expanded={expanded}
            childrenByPath={childrenByPath}
            badgesByPath={badgesByPath}
            onToggleDir={toggleDir}
            onOpenFile={openFile}
          />
        ))}
      </div>
        </motion.aside>
      )}
    </AnimatePresence>
  )
}

interface TreeRowProps {
  entry: FsEntry
  depth: number
  expanded: Set<string>
  childrenByPath: Record<string, FsEntry[]>
  badgesByPath: ReadonlyMap<string, GitBadge>
  onToggleDir: (path: string) => void
  onOpenFile: (path: string) => void
}

function TreeRow({
  entry,
  depth,
  expanded,
  childrenByPath,
  badgesByPath,
  onToggleDir,
  onOpenFile
}: TreeRowProps): JSX.Element {
  const isDir = entry.kind === 'dir'
  const isOpen = isDir && expanded.has(entry.path)
  const children = isOpen ? childrenByPath[entry.path] : undefined
  const badge = badgeForEntry(entry, badgesByPath)
  const badgeColor = badge === 'A' ? colors.done : badge === 'M' ? colors.bronzeHot : colors.quartzDim

  return (
    <div role="treeitem" aria-expanded={isDir ? isOpen : undefined}>
      <button
        type="button"
        onClick={() => (isDir ? onToggleDir(entry.path) : onOpenFile(entry.path))}
        className="flex w-full cursor-pointer items-center gap-1.5 rounded-md px-1.5 py-1 text-left transition-colors hover:bg-hover"
        style={{ paddingLeft: 6 + depth * 14, color: colors.quartz }}
        title={entry.path}
      >
        {isDir ? (
          <>
            {isOpen ? (
              <IconChevronDown size={11} stroke={1.5} style={{ color: colors.quartzDim }} />
            ) : (
              <IconChevronRight size={11} stroke={1.5} style={{ color: colors.quartzDim }} />
            )}
            <IconFolder size={13} stroke={1.5} style={{ color: colors.bronze }} />
          </>
        ) : (
          <IconFile size={13} stroke={1.5} style={{ color: colors.quartzDim, marginLeft: 13 }} />
        )}
        <span className="min-w-0 flex-1 truncate">{entry.name}</span>
        {badge && (
          <span
            data-testid="explorer-git-badge"
            aria-label={`Git status ${badge}`}
            className="shrink-0 font-mono text-[10px] font-bold"
            style={{ color: badgeColor }}
          >
            {badge}
          </span>
        )}
      </button>
      {isOpen && (
        <div role="group">
          {children ? (
            children.map((child) => (
              <TreeRow
                key={child.path}
                entry={child}
                depth={depth + 1}
                expanded={expanded}
                childrenByPath={childrenByPath}
                badgesByPath={badgesByPath}
                onToggleDir={onToggleDir}
                onOpenFile={onOpenFile}
              />
            ))
          ) : (
            <div
              className="py-0.5"
              style={{ paddingLeft: 6 + (depth + 1) * 14, color: colors.quartzDim }}
            >
              …
            </div>
          )}
        </div>
      )}
    </div>
  )
}
