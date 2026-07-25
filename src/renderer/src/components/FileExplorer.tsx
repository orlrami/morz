import { useCallback, useEffect, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import {
  IconChevronDown,
  IconChevronRight,
  IconFile,
  IconFolder,
  IconFolderOpen,
  IconX,
  IconExternalLink
} from '@tabler/icons-react'
import type { FsEntry } from '@shared/ipc'
import { emit } from '@/lib/app-events'
import { useSpaceStore, getMorz, selectActiveSpace, selectActiveSpaceRoot } from '@/store/spaceStore'
import { colors } from '@/lib/tokens'
import { springs } from '@/lib/springs'

interface FileExplorerProps {
  open: boolean
  onClose: () => void
}

/*
 * Pop-in file explorer — slides in over the sidebar edge, pops back out.
 * Real directory tree of the active space root via window.morz.fs.list:
 * lazy listing on expand, node_modules/.git filtered in main. Clicking a
 * file emits 'open-file' → IDE pane. "Pop out" becomes a real dockview
 * popout window in Phase 1.
 */
export function FileExplorer({ open, onClose }: FileExplorerProps): JSX.Element {
  const space = useSpaceStore(selectActiveSpace)
  const root = useSpaceStore(selectActiveSpaceRoot)

  const [childrenByPath, setChildrenByPath] = useState<Record<string, FsEntry[]>>({})
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async (dir: string): Promise<void> => {
    const morz = getMorz()
    if (!morz) {
      setError('backend bridge unavailable')
      return
    }
    try {
      const entries = await morz.fs.list(dir)
      setChildrenByPath((m) => ({ ...m, [dir]: entries }))
      setError(null)
    } catch {
      setError(`cannot list ${dir}`)
    }
  }, [])

  useEffect(() => {
    setChildrenByPath({})
    setExpanded(new Set())
    setError(null)
  }, [root])

  // (re)load the root whenever the explorer opens on a space
  useEffect(() => {
    if (open && root) void load(root)
  }, [open, root, load])

  const toggleDir = useCallback(
    (path: string): void => {
      setExpanded((prev) => {
        const next = new Set(prev)
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

  const openFile = useCallback((path: string): void => {
    emit('open-file', { path })
  }, [])

  const rootEntries = root ? childrenByPath[root] : undefined

  return (
    <AnimatePresence>
      {open && (
        <motion.aside
          initial={{ x: 240, opacity: 0 }}
          animate={{ x: 0, opacity: 1, transition: springs.panel }}
          exit={{ x: 240, opacity: 0, transition: { duration: 0.16 } }}
          /* w15/shell-layout — Explorer mount slot: static 224px panel between
           * the stage and the orchestrator dock (Agent 3 replaces internals). */
          className="flex w-[224px] shrink-0 flex-col border-l"
          style={{ background: colors.panel, borderColor: 'var(--color-line)' }}
          aria-label="File explorer"
          data-testid="explorer-slot"
        >
          <div
            className="flex items-center gap-2 border-b px-3 py-2"
            style={{ borderColor: 'var(--color-line)' }}
          >
            <IconFolderOpen size={14} stroke={1.5} style={{ color: colors.bronzeHot }} />
            <span
              className="truncate text-xs font-semibold"
              style={{ fontFamily: 'var(--font-display)' }}
              title={root}
            >
              {space?.name ?? 'no space'}
            </span>
            <button
              className="ml-auto cursor-pointer rounded p-0.5 hover:bg-[#37332B]"
              title="Pop out to its own window"
              aria-label="Pop out explorer"
              style={{ color: colors.quartzDim }}
            >
              <IconExternalLink size={13} stroke={1.5} />
            </button>
            <button
              onClick={onClose}
              className="cursor-pointer rounded p-0.5 hover:bg-[#37332B]"
              aria-label="Close explorer"
              style={{ color: colors.quartzDim }}
            >
              <IconX size={13} stroke={1.5} />
            </button>
          </div>

          <div className="flex-1 overflow-y-auto p-1.5 text-xs">
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
  onToggleDir: (path: string) => void
  onOpenFile: (path: string) => void
}

function TreeRow({ entry, depth, expanded, childrenByPath, onToggleDir, onOpenFile }: TreeRowProps): JSX.Element {
  const isDir = entry.kind === 'dir'
  const isOpen = isDir && expanded.has(entry.path)
  const children = isOpen ? childrenByPath[entry.path] : undefined

  return (
    <div>
      <button
        onClick={() => (isDir ? onToggleDir(entry.path) : onOpenFile(entry.path))}
        className="flex w-full cursor-pointer items-center gap-1.5 rounded-md px-1.5 py-1 text-left transition-colors hover:bg-[#37332B]"
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
        <span className="truncate">{entry.name}</span>
      </button>
      {isOpen && (
        <div>
          {children ? (
            children.map((child) => (
              <TreeRow
                key={child.path}
                entry={child}
                depth={depth + 1}
                expanded={expanded}
                childrenByPath={childrenByPath}
                onToggleDir={onToggleDir}
                onOpenFile={onOpenFile}
              />
            ))
          ) : (
            <div className="py-0.5" style={{ paddingLeft: 6 + (depth + 1) * 14, color: colors.quartzDim }}>
              …
            </div>
          )}
        </div>
      )}
    </div>
  )
}
