import { useEffect, useMemo, useRef, useState } from 'react'
import {
  IconAlertCircle,
  IconAlertTriangle,
  IconBell,
  IconCircleCheck,
  IconInfoCircle,
  IconX
} from '@tabler/icons-react'
import type { NotifyItem, NotifyLevel, NotifySource } from '@shared/notify'
import { colors } from '@/lib/tokens'
import { useNotifyStore } from '@/store/notifyStore'

const SOURCE_LABEL: Record<NotifySource, string> = {
  catalog: 'Catalog sync',
  pulse: 'Daily Pulse',
  dispatch: 'Dispatch',
  adapter: 'CLI adapters',
  assistant: 'Assistant',
  organizer: 'Organizer',
  app: 'Morz'
}

const LEVEL_COLOR: Record<NotifyLevel, string> = {
  info: colors.working,
  success: colors.done,
  warning: colors.warning,
  error: colors.error
}

function LevelIcon({ level }: { level: NotifyLevel }): JSX.Element {
  const props = { size: 14, stroke: 1.7, 'aria-hidden': true }
  if (level === 'error') return <IconAlertCircle {...props} />
  if (level === 'warning') return <IconAlertTriangle {...props} />
  if (level === 'success') return <IconCircleCheck {...props} />
  return <IconInfoCircle {...props} />
}

function formatNoticeTime(ts?: number): string {
  if (!ts) return 'now'
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function NoticeRow({ item }: { item: NotifyItem }): JSX.Element {
  const dismiss = useNotifyStore((state) => state.dismiss)
  const runAction = useNotifyStore((state) => state.runAction)
  const color = LEVEL_COLOR[item.level]

  return (
    <article
      className="relative border-l-2 px-3 py-2.5"
      style={{ borderColor: color, background: item.read ? 'transparent' : `${color}0c` }}
      data-notice-id={item.id}
    >
      <div className="flex items-start gap-2">
        <span className="mt-0.5 shrink-0" style={{ color }}>
          <LevelIcon level={item.level} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-start gap-2">
            <strong className="min-w-0 flex-1 text-[11px] leading-snug" style={{ color: colors.quartz }}>
              {item.title}
            </strong>
            <time className="shrink-0 font-mono text-[9px]" style={{ color: colors.quartzDim }}>
              {formatNoticeTime(item.ts)}
            </time>
          </div>
          {item.detail && (
            <p className="mt-1 text-[10px] leading-relaxed" style={{ color: colors.quartzDim }}>
              {item.detail}
            </p>
          )}
          {item.actions && item.actions.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {item.actions.map((action) => (
                <button
                  key={action.id}
                  type="button"
                  onClick={() => runAction(item.id, action.id)}
                  className="rounded-md border px-2 py-1 text-[9.5px] font-semibold hover:brightness-125"
                  style={{ borderColor: `${color}66`, color }}
                >
                  {action.label}
                </button>
              ))}
            </div>
          )}
        </div>
        <button
          type="button"
          onClick={() => dismiss(item.id)}
          aria-label={`Dismiss ${item.title}`}
          title="Dismiss"
          className="shrink-0 rounded p-0.5 hover:bg-[#37332B]"
          style={{ color: colors.quartzDim }}
        >
          <IconX size={11} stroke={1.6} />
        </button>
      </div>
    </article>
  )
}

export function NotificationCenter(): JSX.Element {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const panelRef = useRef<HTMLElement>(null)
  const bellRef = useRef<HTMLButtonElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const items = useNotifyStore((state) => state.items)
  const start = useNotifyStore((state) => state.start)
  const markAllRead = useNotifyStore((state) => state.markAllRead)
  const unread = items.filter((item) => !item.read).length

  useEffect(() => start(), [start])
  useEffect(() => {
    if (!open) return
    window.requestAnimationFrame(() => closeRef.current?.focus())
    const close = (): void => {
      setOpen(false)
      window.requestAnimationFrame(() => bellRef.current?.focus())
    }
    const closeOnPointer = (event: MouseEvent): void => {
      if (!rootRef.current?.contains(event.target as Node)) close()
    }
    const closeOnKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        close()
        return
      }
      if (event.key !== 'Tab') return
      const focusable = panelRef.current?.querySelectorAll<HTMLElement>('button:not([disabled])')
      if (!focusable?.length) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('mousedown', closeOnPointer)
    document.addEventListener('keydown', closeOnKey)
    return () => {
      document.removeEventListener('mousedown', closeOnPointer)
      document.removeEventListener('keydown', closeOnKey)
    }
  }, [open])

  const groups = useMemo(() => {
    const grouped = new Map<NotifySource, NotifyItem[]>()
    for (const item of items) grouped.set(item.source, [...(grouped.get(item.source) ?? []), item])
    return [...grouped.entries()].sort((left, right) => (right[1][0]?.ts ?? 0) - (left[1][0]?.ts ?? 0))
  }, [items])

  const toggle = (): void => {
    setOpen((wasOpen) => {
      const next = !wasOpen
      if (next && unread > 0) markAllRead()
      return next
    })
  }

  return (
    <div ref={rootRef} className="relative">
      <button
        ref={bellRef}
        type="button"
        onClick={toggle}
        className="relative flex h-6 items-center gap-1 rounded-md px-1.5 hover:bg-[#37332B] focus-visible:outline focus-visible:outline-2"
        style={{ color: unread > 0 ? colors.bronzeHot : colors.quartzDim }}
        aria-label={`Notifications${unread > 0 ? `, ${unread} unread` : ''}`}
        aria-expanded={open}
        aria-haspopup="dialog"
      >
        <IconBell size={13} stroke={1.6} />
        {unread > 0 && (
          <span
            data-testid="notification-unread-count"
            className="min-w-4 rounded-full px-1 text-center font-mono text-[8.5px] font-bold leading-4"
            style={{ background: colors.error, color: '#fff' }}
          >
            {unread > 99 ? '99+' : unread}
          </span>
        )}
      </button>

      {open && (
        <section
          ref={panelRef}
          role="dialog"
          aria-label="Notification center"
          aria-modal="true"
          className="absolute bottom-8 right-0 z-[70] flex max-h-[min(520px,70vh)] w-[380px] flex-col overflow-hidden rounded-xl border shadow-2xl"
          style={{ background: colors.panel, borderColor: 'var(--color-line-strong)', color: colors.quartz }}
        >
          <header className="flex items-center border-b px-3 py-2.5" style={{ borderColor: 'var(--color-line)' }}>
            <strong className="text-xs" style={{ fontFamily: 'var(--font-display)' }}>Notification center</strong>
            <span className="ml-2 text-[9.5px]" style={{ color: colors.quartzDim }}>{items.length} notices</span>
            <button
              ref={closeRef}
              type="button"
              onClick={() => {
                setOpen(false)
                window.requestAnimationFrame(() => bellRef.current?.focus())
              }}
              className="ml-auto rounded p-1 hover:bg-[#37332B]"
              aria-label="Close notification center"
              style={{ color: colors.quartzDim }}
            >
              <IconX size={13} />
            </button>
          </header>
          <div className="min-h-0 overflow-y-auto">
            {groups.length === 0 ? (
              <p className="px-4 py-8 text-center text-[10.5px]" style={{ color: colors.quartzDim }}>
                No background notices.
              </p>
            ) : groups.map(([source, notices]) => (
              <section key={source} aria-label={SOURCE_LABEL[source]}>
                <h3
                  className="sticky top-0 z-10 border-y px-3 py-1.5 text-[9px] font-bold uppercase tracking-[0.12em]"
                  style={{ background: colors.card, borderColor: 'var(--color-line)', color: colors.quartzDim }}
                >
                  {SOURCE_LABEL[source]}
                </h3>
                {notices.map((item) => <NoticeRow key={item.id} item={item} />)}
              </section>
            ))}
          </div>
        </section>
      )}
    </div>
  )
}
