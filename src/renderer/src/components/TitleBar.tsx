import { useEffect, useRef } from 'react'
import { IconPlus, IconSearch, IconX } from '@tabler/icons-react'
import type { GitStatus } from '@shared/ipc'
import { colors } from '@/lib/tokens'
import { pickAndAddSpace, useSpaceStore, type Space } from '@/store/spaceStore'
import { MorzSignal, MorzWordmark } from './Brand'

interface TitleBarProps {
  onOpenPalette: () => void
}

const noDrag = { WebkitAppRegion: 'no-drag' } as React.CSSProperties

function removalPrompt(space: Space): string {
  return `Remove ${space.name} from Morz? This only removes the space; files on disk will not be changed.`
}

function spaceStatus(
  unavailable: boolean,
  git: GitStatus | undefined
): { color: string; label: string } {
  if (unavailable) return { color: colors.quartzFaint, label: 'unavailable' }
  if (!git) return { color: colors.quartzFaint, label: 'status unavailable' }
  if (git.files.length > 0) return { color: colors.working, label: 'dirty' }
  return { color: colors.done, label: 'clean' }
}

/* Custom Windows title bar: draggable chrome, live space tabs, palette hint. */
export function TitleBar({ onOpenPalette }: TitleBarProps): JSX.Element {
  const spaces = useSpaceStore((state) => state.spaces)
  const activeSpaceId = useSpaceStore((state) => state.activeSpaceId)
  const unavailableRoots = useSpaceStore((state) => state.unavailableRoots)
  const gitByRoot = useSpaceStore((state) => state.gitByRoot)
  const ready = useSpaceStore((state) => state.ready)
  const removeSpace = useSpaceStore((state) => state.removeSpace)
  const setActiveSpace = useSpaceStore((state) => state.setActiveSpace)

  const remove = (space: Space): void => {
    if (window.confirm(removalPrompt(space))) removeSpace(space.id)
  }

  const add = async (): Promise<void> => {
    try {
      await pickAndAddSpace()
    } catch {
      window.alert('Could not open the folder picker.')
    }
  }

  const navigateTabs = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
    const current = (event.target as HTMLElement).closest<HTMLButtonElement>('[role="tab"]')
    if (!current || !event.currentTarget.contains(current)) return
    const tabs = Array.from(
      event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]:not(:disabled)')
    )
    const currentIndex = tabs.indexOf(current)
    if (currentIndex < 0 || tabs.length === 0) return

    const nextIndex =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? tabs.length - 1
          : event.key === 'ArrowLeft'
            ? (currentIndex - 1 + tabs.length) % tabs.length
            : (currentIndex + 1) % tabs.length
    event.preventDefault()
    tabs[nextIndex].focus()
    tabs[nextIndex].click()
  }

  return (
    <header
      className="flex h-10 shrink-0 items-center gap-3 border-b px-3"
      style={{
        background: colors.panel,
        borderColor: 'var(--color-line)',
        WebkitAppRegion: 'drag'
      } as React.CSSProperties}
    >
      <div className="flex items-center gap-1.5" aria-label="Morz">
        <MorzSignal className="h-[22px] w-[30px] shrink-0" />
        <MorzWordmark className="text-[15px] leading-none" />
      </div>

      <nav className="min-w-0 flex-1 self-end overflow-hidden" aria-label="Space navigation" style={noDrag}>
        <div
          role="tablist"
          aria-label="Spaces"
          onKeyDown={navigateTabs}
          className="flex max-w-full items-end gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          style={noDrag}
        >
          {spaces.map((space) => (
            <SpaceTab
              key={space.id}
              space={space}
              active={activeSpaceId === space.id}
              unavailable={!!unavailableRoots[space.root]}
              ready={ready}
              git={gitByRoot[space.root]}
              onActivate={() => setActiveSpace(space.id)}
              onRemove={() => remove(space)}
            />
          ))}
          <button
            type="button"
            onClick={() => void add()}
            disabled={!ready}
            aria-label="Add space"
            title="Open a folder as a space"
            className="flex shrink-0 cursor-pointer items-center rounded-t-lg px-2 py-1.5 text-xs transition-colors hover:bg-[#37332B] focus-visible:outline focus-visible:outline-2 disabled:cursor-not-allowed disabled:opacity-40"
            style={{ color: colors.quartzDim, ...noDrag }}
          >
            <IconPlus size={14} stroke={1.7} />
          </button>
        </div>
      </nav>

      <button
        onClick={onOpenPalette}
        className="flex cursor-pointer items-center gap-2 rounded-[10px] border px-3 py-1.5 text-xs transition-colors hover:border-[rgba(238,230,217,0.25)]"
        style={
          {
            background: colors.page,
            borderColor: 'var(--color-line-strong)',
            color: colors.quartzDim,
            WebkitAppRegion: 'no-drag'
          } as React.CSSProperties
        }
        aria-label="Open command palette"
      >
        <IconSearch size={14} stroke={1.5} />
        Search agents, files, actions
        <span className="ml-2 flex gap-1">
          <kbd className="rounded border px-1 text-[10px]" style={{ borderColor: 'var(--color-line-strong)' }}>
            Ctrl
          </kbd>
          <kbd className="rounded border px-1 text-[10px]" style={{ borderColor: 'var(--color-line-strong)' }}>
            K
          </kbd>
        </span>
      </button>

      <div className="flex gap-2 pl-1" aria-hidden>
        <span className="size-3 rounded-full" style={{ background: colors.card }} />
        <span className="size-3 rounded-full" style={{ background: colors.card }} />
        <span className="size-3 rounded-full" style={{ background: colors.card }} />
      </div>
    </header>
  )
}

function SpaceTab({
  space,
  active,
  unavailable,
  ready,
  git,
  onActivate,
  onRemove
}: {
  space: Space
  active: boolean
  unavailable: boolean
  ready: boolean
  git: GitStatus | undefined
  onActivate(): void
  onRemove(): void
}): JSX.Element {
  const tabRef = useRef<HTMLButtonElement>(null)
  const status = spaceStatus(unavailable, git)

  useEffect(() => {
    if (!active) return
    const tab = tabRef.current
    const item = tab?.parentElement
    const scroller = item?.parentElement
    if (!tab || !item || !scroller) return

    const keepVisible = (): void => {
      const itemRect = item.getBoundingClientRect()
      const scrollerRect = scroller.getBoundingClientRect()
      if (itemRect.left < scrollerRect.left) scroller.scrollLeft -= scrollerRect.left - itemRect.left
      else if (itemRect.right > scrollerRect.right) scroller.scrollLeft += itemRect.right - scrollerRect.right
    }

    keepVisible()
    const resizeObserver = new ResizeObserver(keepVisible)
    resizeObserver.observe(scroller)
    resizeObserver.observe(item)
    const mutationObserver = new MutationObserver(keepVisible)
    mutationObserver.observe(scroller, { childList: true, subtree: true, characterData: true })
    window.addEventListener('resize', keepVisible)
    return () => {
      resizeObserver.disconnect()
      mutationObserver.disconnect()
      window.removeEventListener('resize', keepVisible)
    }
  }, [active])

  return (
    <div
      data-space-tab={space.name}
      data-active={active ? 'true' : 'false'}
      className="group flex shrink-0 items-center rounded-t-lg"
      style={{ background: active ? colors.card : 'transparent', ...noDrag }}
      onAuxClick={(event) => {
        if (event.button !== 1) return
        event.preventDefault()
        onRemove()
      }}
      onMouseDown={(event) => {
        if (event.button === 1) event.preventDefault()
      }}
      title={`${space.root} (${status.label})`}
    >
      <button
        ref={tabRef}
        type="button"
        role="tab"
        aria-label={`${space.name}, ${status.label}`}
        aria-selected={active}
        tabIndex={active ? 0 : -1}
        disabled={unavailable || !ready}
        onClick={onActivate}
        className="flex cursor-pointer items-center gap-2 py-1.5 pl-3 pr-1 text-xs opacity-60 transition-opacity hover:opacity-90 focus-visible:outline focus-visible:outline-2 disabled:cursor-not-allowed disabled:opacity-40"
        style={{
          color: active ? colors.quartz : colors.quartzDim,
          fontFamily: 'var(--font-display)',
          opacity: active ? 1 : undefined,
          ...noDrag
        }}
      >
        <span
          className="size-1.5 shrink-0 rounded-full"
          style={{ background: status.color }}
          aria-hidden="true"
        />
        <span className="max-w-[140px] truncate">{space.name}</span>
      </button>
      <button
        type="button"
        onClick={onRemove}
        disabled={!ready}
        aria-label={`Remove ${space.name}`}
        title={`Remove ${space.name}`}
        className="mr-1 flex cursor-pointer items-center rounded p-0.5 opacity-0 transition-opacity hover:bg-[#26241E] focus:opacity-100 focus-visible:outline focus-visible:outline-2 group-hover:opacity-100 disabled:cursor-not-allowed"
        style={{ color: colors.quartzFaint, ...noDrag }}
      >
        <IconX size={11} stroke={1.7} />
      </button>
    </div>
  )
}
