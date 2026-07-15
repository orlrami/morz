import { IconSearch } from '@tabler/icons-react'
import { colors } from '@/lib/tokens'
import { MorzSignal, MorzWordmark } from './Brand'

interface TitleBarProps {
  onOpenPalette: () => void
}

/* Custom Windows title bar: draggable chrome, workspace tabs, palette hint. */
export function TitleBar({ onOpenPalette }: TitleBarProps): JSX.Element {
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

      <nav className="flex items-end gap-1 self-end" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
        <button
          className="flex cursor-pointer items-center gap-2 rounded-t-lg px-3 py-1.5 text-xs"
          style={{ background: colors.card, color: colors.quartz, fontFamily: 'var(--font-display)' }}
        >
          <span className="size-1.5 rounded-full" style={{ background: colors.done }} />
          morz-core
        </button>
        <button
          className="flex cursor-pointer items-center gap-2 rounded-t-lg px-3 py-1.5 text-xs opacity-60 hover:opacity-90"
          style={{ color: colors.quartzDim, fontFamily: 'var(--font-display)' }}
        >
          <span className="size-1.5 rounded-full" style={{ background: colors.working }} />
          api-service
        </button>
      </nav>

      <div className="flex-1" />

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
