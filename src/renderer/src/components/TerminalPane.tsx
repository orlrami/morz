import { useEffect, useState, type ReactNode } from 'react'
import { motion } from 'framer-motion'
import {
  IconClipboard,
  IconCopy,
  IconFolder,
  IconLayoutColumns,
  IconLayoutRows,
  IconX
} from '@tabler/icons-react'
import type { MockAgent, MockBlock } from '@/lib/mock'
import { colors, statusColor } from '@/lib/tokens'
import { useTerminal, copyTerminalSelection, pasteIntoTerminal } from '@/hooks/useTerminal'
import { emit } from '@/lib/app-events'

interface TerminalPaneProps {
  agent: MockAgent
  blocks: MockBlock[]
  /** Live tail under the blocks: what the agent is doing right now. */
  tail?: 'cursor' | 'approval'
}

/*
 * Terminal pane — real xterm.js bound to the PTY-host (0.0.1 Slice 1).
 * One continuous buffer; OSC-133 command blocks render as marker-anchored
 * decorations (terminal-blocks.ts); ctrl/shift-click links emit 'open-file'
 * (terminal-links.ts). Micro-UX: copy-on-select + zoom live in useTerminal;
 * this file adds header split/close buttons (emit-only — the shell owns
 * layout) and the right-click context menu.
 * blocks/tail props kept for Shell.tsx compatibility; the mock stream is gone.
 */

function HeaderButton({
  title,
  onClick,
  children
}: {
  title: string
  onClick: () => void
  children: ReactNode
}): JSX.Element {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      onClick={onClick}
      className="rounded p-0.5 transition-colors hover:bg-white/10"
      style={{ color: colors.quartzDim }}
    >
      {children}
    </button>
  )
}

function MenuItem({
  label,
  icon,
  onClick
}: {
  label: string
  icon?: ReactNode
  onClick: () => void
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs transition-colors hover:bg-white/10"
      style={{ color: colors.quartz }}
    >
      {icon}
      {label}
    </button>
  )
}

/*
 * Right-click context menu + its open/close state, reusable by any pane host
 * (TerminalPane here, ShellTerminalPane in Shell.tsx). Attach `onContextMenu`
 * to the xterm mount and render `element` inside a relative container.
 */
export function useTerminalContextMenu(paneId: string): {
  onContextMenu: (ev: React.MouseEvent) => void
  element: ReactNode
} {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)

  useEffect(() => {
    if (!menu) return
    const onKey = (ev: KeyboardEvent): void => {
      if (ev.key === 'Escape') setMenu(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [menu])

  const closeMenu = (): void => setMenu(null)
  const menuAction = (fn: () => void) => () => {
    fn()
    closeMenu()
  }

  const element: ReactNode = menu ? (
    <div
      className="fixed inset-0 z-50"
      onClick={closeMenu}
      onContextMenu={(ev) => {
        ev.preventDefault()
        closeMenu()
      }}
    >
      <div
        className="absolute min-w-[170px] rounded-md border py-1 shadow-lg"
        style={{
          left: Math.min(menu.x, window.innerWidth - 190),
          top: Math.min(menu.y, window.innerHeight - 190),
          background: colors.panel,
          borderColor: 'var(--color-line)'
        }}
        onClick={(ev) => ev.stopPropagation()}
      >
        <MenuItem
          label="Copy"
          icon={<IconCopy size={13} stroke={1.5} />}
          onClick={menuAction(() => copyTerminalSelection(paneId))}
        />
        <MenuItem
          label="Paste"
          icon={<IconClipboard size={13} stroke={1.5} />}
          onClick={menuAction(() => pasteIntoTerminal(paneId))}
        />
        <div className="my-1 border-t" style={{ borderColor: 'var(--color-line)' }} />
        <MenuItem
          label="Split right"
          icon={<IconLayoutColumns size={13} stroke={1.5} />}
          onClick={menuAction(() => emit('split-pane', { paneId, dir: 'right' }))}
        />
        <MenuItem
          label="Split down"
          icon={<IconLayoutRows size={13} stroke={1.5} />}
          onClick={menuAction(() => emit('split-pane', { paneId, dir: 'down' }))}
        />
        <div className="my-1 border-t" style={{ borderColor: 'var(--color-line)' }} />
        <MenuItem
          label="Close pane"
          icon={<IconX size={13} stroke={1.5} />}
          onClick={menuAction(() => emit('close-pane', { paneId }))}
        />
      </div>
    </div>
  ) : null

  return {
    onContextMenu: (ev: React.MouseEvent) => {
      ev.preventDefault()
      setMenu({ x: ev.clientX, y: ev.clientY })
    },
    element
  }
}

export function TerminalPane({ agent }: TerminalPaneProps): JSX.Element {
  const blocked = agent.status === 'blocked'
  const paneId = agent.id
  const { containerRef } = useTerminal(paneId)
  const ctxMenu = useTerminalContextMenu(paneId)

  return (
    <section
      className="relative flex min-w-0 flex-1 flex-col overflow-hidden"
      style={{ background: colors.page }}
      aria-label={`Terminal — ${agent.name}`}
    >
      {blocked && (
        <motion.div
          className="pointer-events-none absolute inset-0 z-10 rounded-none border-[1.5px]"
          style={{ borderColor: statusColor.blocked }}
          animate={{ opacity: [0.85, 0.35, 0.85] }}
          transition={{ duration: 1.8, repeat: Infinity, ease: 'easeInOut' }}
          aria-hidden
        />
      )}

      {/* pane header */}
      <div
        className="flex shrink-0 items-center gap-2 border-b px-3 py-2"
        style={{ background: colors.panel, borderColor: 'var(--color-line)' }}
      >
        <span className="size-2 rounded-full" style={{ background: statusColor[agent.status] }} />
        <span className="text-xs font-semibold" style={{ fontFamily: 'var(--font-display)' }}>
          {agent.name}
        </span>
        <span
          className="rounded-full px-2 py-px text-[9.5px] font-semibold"
          style={{
            background: `${statusColor[agent.status]}26`,
            color: statusColor[agent.status]
          }}
        >
          {blocked ? 'blocked · needs you' : agent.status}
        </span>
        <span className="ml-auto flex items-center gap-1 font-mono text-[10px]" style={{ color: colors.quartzDim }}>
          <IconFolder size={11} stroke={1.5} />
          {agent.worktree}
        </span>
        <span className="flex items-center gap-0.5">
          <HeaderButton
            title="Split right"
            onClick={() => emit('split-pane', { paneId, dir: 'right' })}
          >
            <IconLayoutColumns size={13} stroke={1.5} />
          </HeaderButton>
          <HeaderButton
            title="Split down"
            onClick={() => emit('split-pane', { paneId, dir: 'down' })}
          >
            <IconLayoutRows size={13} stroke={1.5} />
          </HeaderButton>
          <HeaderButton title="Close pane" onClick={() => emit('close-pane', { paneId })}>
            <IconX size={13} stroke={1.5} />
          </HeaderButton>
        </span>
      </div>

      {/* xterm mount — pl-3 leaves room for the block accent strips */}
      <div
        ref={containerRef}
        className="min-h-0 flex-1 py-2 pl-3 pr-1"
        style={{ background: colors.page }}
        onContextMenu={ctxMenu.onContextMenu}
      />

      {/* right-click context menu */}
      {ctxMenu.element}
    </section>
  )
}
