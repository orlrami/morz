import { useState } from 'react'
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
import { fileTree, type TreeNode } from '@/lib/mock'
import { colors } from '@/lib/tokens'
import { springs } from '@/lib/springs'

const CHANGE_COLOR: Record<string, string> = {
  M: colors.warning,
  A: colors.done,
  D: colors.error
}

interface FileExplorerProps {
  open: boolean
  onClose: () => void
}

/*
 * Pop-in file explorer — slides in over the sidebar edge, pops back out.
 * Change badges (M/A/D) come from the watcher in Phase 1; "pop out" becomes
 * a real dockview popout window.
 */
export function FileExplorer({ open, onClose }: FileExplorerProps): JSX.Element {
  return (
    <AnimatePresence>
      {open && (
        <motion.aside
          initial={{ x: -280, opacity: 0 }}
          animate={{ x: 0, opacity: 1, transition: springs.panel }}
          exit={{ x: -280, opacity: 0, transition: { duration: 0.16 } }}
          className="absolute bottom-7 left-0 top-10 z-40 flex w-[264px] flex-col border-r shadow-2xl"
          style={{ background: colors.panel, borderColor: 'var(--color-line-strong)' }}
          aria-label="File explorer"
        >
          <div
            className="flex items-center gap-2 border-b px-3 py-2"
            style={{ borderColor: 'var(--color-line)' }}
          >
            <IconFolderOpen size={14} stroke={1.5} style={{ color: colors.bronzeHot }} />
            <span className="text-xs font-semibold" style={{ fontFamily: 'var(--font-display)' }}>
              morz-core
            </span>
            <span className="text-[10px]" style={{ color: colors.quartzDim }}>
              4 changed
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
            {fileTree.map((node) => (
              <TreeRow key={node.name} node={node} depth={0} />
            ))}
          </div>
        </motion.aside>
      )}
    </AnimatePresence>
  )
}

function TreeRow({ node, depth }: { node: TreeNode; depth: number }): JSX.Element {
  const [open, setOpen] = useState(depth === 0)
  const isDir = node.kind === 'dir'

  return (
    <div>
      <button
        onClick={() => isDir && setOpen((v) => !v)}
        className="flex w-full cursor-pointer items-center gap-1.5 rounded-md px-1.5 py-1 text-left transition-colors hover:bg-[#37332B]"
        style={{ paddingLeft: 6 + depth * 14, color: colors.quartz }}
      >
        {isDir ? (
          <>
            {open ? (
              <IconChevronDown size={11} stroke={1.5} style={{ color: colors.quartzDim }} />
            ) : (
              <IconChevronRight size={11} stroke={1.5} style={{ color: colors.quartzDim }} />
            )}
            <IconFolder size={13} stroke={1.5} style={{ color: colors.bronze }} />
          </>
        ) : (
          <IconFile size={13} stroke={1.5} style={{ color: colors.quartzDim, marginLeft: 13 }} />
        )}
        <span className="truncate">{node.name}</span>
        {node.change && (
          <span
            className="ml-auto rounded px-1 font-mono text-[9px] font-bold"
            style={{ color: CHANGE_COLOR[node.change] }}
          >
            {node.change}
          </span>
        )}
      </button>
      {isDir && open && node.children && (
        <div>
          {node.children.map((child) => (
            <TreeRow key={child.name} node={child} depth={depth + 1} />
          ))}
        </div>
      )}
    </div>
  )
}
