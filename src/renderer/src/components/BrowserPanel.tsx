import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { motion } from 'framer-motion'
import {
  IconArrowLeft,
  IconArrowRight,
  IconCrosshair,
  IconLoader2,
  IconRefresh,
  IconSend,
  IconWorld
} from '@tabler/icons-react'
import { colors } from '@/lib/tokens'
import { cliTint } from '@/lib/cli'
import { springs } from '@/lib/springs'
import { openFile } from '@/lib/open-file'
import { useBrowserStore } from '@/store/browserStore'
import type { BrowserAgentKind, ElementContext } from '@shared/ipc'

function sourceLocation(value: string): { path: string; line?: number; col?: number } {
  const match = /^(.*?):(\d+)(?::(\d+))?$/.exec(value)
  if (!match) return { path: value }
  return {
    path: match[1],
    line: Number(match[2]),
    ...(match[3] ? { col: Number(match[3]) } : {})
  }
}

function isSafeRelativeSource(value: string): boolean {
  const { path } = sourceLocation(value)
  const normalized = path.replace(/\\/g, '/')
  return (
    normalized.length > 0 &&
    !normalized.startsWith('/') &&
    !/^[a-z]:/i.test(normalized) &&
    !/^[a-z][a-z\d+.-]*:/i.test(normalized) &&
    !/[\u0000-\u001f]/.test(normalized) &&
    !normalized.split('/').includes('..')
  )
}

function StyleSummary({ context }: { context: ElementContext }): JSX.Element {
  const styles = context.curatedStyles
  return (
    <div
      className="rounded-lg border p-2 font-mono text-[9.5px] leading-relaxed"
      style={{ borderColor: 'var(--color-line)', color: colors.quartzDim }}
    >
      <p>color: {styles.color || 'unset'}</p>
      <p>background: {styles.backgroundColor || 'unset'}</p>
      <p>font: {styles.fontWeight} {styles.fontSize} {styles.fontFamily}</p>
      <p>margin: {styles.margin}</p>
      <p>padding: {styles.padding}</p>
      <p>border: {styles.border || 'none'}</p>
      <p>
        crop {Math.round(context.boundingRect.width)}×{Math.round(context.boundingRect.height)}
      </p>
    </div>
  )
}

function PickedElementCard({ context }: { context: ElementContext }): JSX.Element {
  const sendPick = useBrowserStore((state) => state.sendPick)
  const [status, setStatus] = useState('')

  const send = async (target: BrowserAgentKind): Promise<void> => {
    setStatus('Sending…')
    const result = await sendPick(target)
    setStatus(
      result === 'handoff'
        ? 'Handoff posted for approval.'
        : result === 'clipboard'
          ? 'Context copied to clipboard.'
          : 'No element context available.'
    )
  }

  return (
    <motion.aside
      initial={{ x: 28, opacity: 0 }}
      animate={{ x: 0, opacity: 1, transition: springs.panel }}
      className="my-4 mr-4 flex w-[280px] shrink-0 flex-col overflow-hidden rounded-xl border"
      style={{
        background: colors.panel,
        borderColor: 'var(--color-line-strong)',
        boxShadow: '0 8px 32px rgba(0,0,0,0.24), inset 0 1px rgba(255,255,255,0.035)'
      }}
      aria-label="Picked element"
    >
      <img
        src={context.croppedScreenshotDataUrl}
        alt={`Crop of ${context.a11y.name || context.selector}`}
        className="h-24 w-full object-contain p-3"
        style={{ background: '#15130f' }}
      />
      <div className="flex min-h-0 flex-1 flex-col gap-2 p-3">
        <div>
          <p className="text-[9px] uppercase tracking-[0.14em]" style={{ color: colors.quartzDim }}>
            Picked element
          </p>
          <p className="mt-1 break-all font-mono text-[10.5px]" style={{ color: colors.bronzeHot }}>
            {context.selector}
          </p>
          <p className="mt-0.5 text-[9.5px]" style={{ color: colors.quartzDim }}>
            {context.a11y.role || 'element'} · {context.a11y.name || 'unnamed'}
          </p>
        </div>

        {context.sourceLoc && isSafeRelativeSource(context.sourceLoc) && (
          <button
            type="button"
            onClick={() => {
              const target = sourceLocation(context.sourceLoc!)
              void openFile(target.path, target.line)
            }}
            className="cursor-pointer truncate rounded-md border px-2 py-1 text-left font-mono text-[9.5px] transition-colors hover:bg-white/[0.04] focus-visible:outline-none focus-visible:ring-2"
            style={{ borderColor: 'var(--color-line)', color: colors.quartz }}
            title="Open source location"
          >
            {context.sourceLoc}
          </button>
        )}

        <StyleSummary context={context} />

        <div className="mt-1 space-y-1.5">
          <button
            type="button"
            onClick={() => void send('agy')}
            className="flex w-full cursor-pointer items-center gap-2 rounded-[10px] border px-2.5 py-2 text-left text-[10.5px] transition-[background,border-color,transform] hover:-translate-y-px hover:bg-white/[0.04] focus-visible:outline-none focus-visible:ring-2 active:translate-y-0"
            style={{ borderColor: 'var(--color-line-strong)', color: colors.quartz }}
          >
            <span className="size-1.5 rounded-full" style={{ background: cliTint.agy }} />
            <span>
              <span className="block font-semibold" style={{ fontFamily: 'var(--font-display)' }}>
                Send to design critique
              </span>
              <span className="block text-[9px]" style={{ color: colors.quartzDim }}>
                live agy lane or clipboard fallback
              </span>
            </span>
            <IconSend size={12} stroke={1.5} className="ml-auto" />
          </button>
          <button
            type="button"
            onClick={() => void send('claude')}
            className="flex w-full cursor-pointer items-center gap-2 rounded-[10px] border px-2.5 py-2 text-left text-[10.5px] transition-[background,border-color,transform] hover:-translate-y-px hover:bg-white/[0.04] focus-visible:outline-none focus-visible:ring-2 active:translate-y-0"
            style={{ borderColor: 'var(--color-line-strong)', color: colors.quartz }}
          >
            <span className="size-1.5 rounded-full" style={{ background: cliTint.claude }} />
            <span>
              <span className="block font-semibold" style={{ fontFamily: 'var(--font-display)' }}>
                Send to builder
              </span>
              <span className="block text-[9px]" style={{ color: colors.quartzDim }}>
                live claude lane or clipboard fallback
              </span>
            </span>
            <IconSend size={12} stroke={1.5} className="ml-auto" />
          </button>
        </div>
        <p className="min-h-4 text-[9px]" aria-live="polite" style={{ color: colors.quartzDim }}>
          {status}
        </p>
      </div>
    </motion.aside>
  )
}

export function BrowserPanel(): JSX.Element {
  const viewportRef = useRef<HTMLDivElement>(null)
  const {
    address,
    suggestions,
    context,
    canGoBack,
    canGoForward,
    loading,
    picking,
    error,
    ready,
    start,
    stop,
    setAddress,
    setBounds,
    navigate,
    back,
    forward,
    reload,
    togglePick
  } = useBrowserStore()

  const syncBounds = useCallback(() => {
    const viewport = viewportRef.current
    if (!viewport) return
    const rect = viewport.getBoundingClientRect()
    setBounds({ x: rect.left, y: rect.top, width: rect.width, height: rect.height })
  }, [setBounds])

  useEffect(() => {
    const viewport = viewportRef.current
    if (!viewport) return
    const observer = new ResizeObserver(syncBounds)
    observer.observe(viewport)
    window.addEventListener('resize', syncBounds)
    void start().then(() => requestAnimationFrame(syncBounds))
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', syncBounds)
      setBounds({ x: 0, y: 0, width: 0, height: 0 })
      void stop()
    }
  }, [setBounds, start, stop, syncBounds])

  useEffect(() => {
    requestAnimationFrame(syncBounds)
  }, [context, syncBounds])

  const submit = (event: FormEvent): void => {
    event.preventDefault()
    void navigate()
  }

  const iconButton =
    'flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-lg border transition-[background,color,transform] hover:bg-white/[0.05] focus-visible:outline-none focus-visible:ring-2 active:scale-[0.97] disabled:cursor-default disabled:opacity-35'

  return (
    <section
      className="flex min-w-0 flex-1 flex-col"
      style={{ background: colors.page }}
      aria-label="Browser"
    >
      <div
        className="flex items-center gap-1.5 border-b px-3 py-2"
        style={{ borderColor: 'var(--color-line)' }}
      >
        <button
          type="button"
          aria-label="Back"
          className={iconButton}
          style={{ borderColor: 'var(--color-line)', color: colors.quartzDim }}
          disabled={!canGoBack}
          onClick={() => void back()}
        >
          <IconArrowLeft size={14} stroke={1.7} />
        </button>
        <button
          type="button"
          aria-label="Forward"
          className={iconButton}
          style={{ borderColor: 'var(--color-line)', color: colors.quartzDim }}
          disabled={!canGoForward}
          onClick={() => void forward()}
        >
          <IconArrowRight size={14} stroke={1.7} />
        </button>
        <button
          type="button"
          aria-label="Reload"
          className={iconButton}
          style={{ borderColor: 'var(--color-line)', color: colors.quartzDim }}
          disabled={!address}
          onClick={() => void reload()}
        >
          <IconRefresh className={loading ? 'animate-spin' : ''} size={14} stroke={1.7} />
        </button>

        <form className="relative flex min-w-0 flex-1" onSubmit={submit}>
          <IconWorld
            size={13}
            stroke={1.5}
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2"
            style={{ color: colors.quartzDim }}
          />
          <input
            aria-label="Browser address"
            value={address}
            onChange={(event) => setAddress(event.currentTarget.value)}
            spellCheck={false}
            placeholder="localhost:5173 or https://…"
            className="h-8 min-w-0 flex-1 rounded-[10px] border bg-transparent pl-8 pr-20 font-mono text-[10.5px] outline-none transition-[border-color,box-shadow] focus:border-[#CBa25a]/50 focus:shadow-[0_0_0_2px_rgba(203,162,90,0.10)]"
            style={{ background: colors.panel, borderColor: 'var(--color-line-strong)', color: colors.quartz }}
          />
          <span
            className="pointer-events-none absolute right-3 top-1/2 flex -translate-y-1/2 items-center gap-1 text-[8.5px]"
            style={{ color: colors.quartzDim }}
          >
            {loading ? <IconLoader2 className="animate-spin" size={10} /> : ready ? 'HTTP(S)' : 'starting'}
          </span>
        </form>

        <button
          type="button"
          aria-pressed={picking}
          onClick={() => void togglePick()}
          disabled={!address || loading}
          className="flex h-8 shrink-0 cursor-pointer items-center gap-1.5 rounded-[10px] border px-2.5 text-[10.5px] font-semibold transition-[background,box-shadow,transform] focus-visible:outline-none focus-visible:ring-2 active:scale-[0.98] disabled:cursor-default disabled:opacity-40"
          style={{
            borderColor: picking ? 'rgba(203,162,90,0.65)' : 'var(--color-line-strong)',
            color: picking ? colors.bronzeHot : colors.quartz,
            background: picking ? 'rgba(203,162,90,0.14)' : 'rgba(255,255,255,0.025)',
            boxShadow: picking ? '0 0 18px rgba(203,162,90,0.12), inset 0 1px rgba(255,255,255,0.05)' : 'none',
            fontFamily: 'var(--font-display)'
          }}
        >
          <IconCrosshair size={13} stroke={2} />
          {picking ? 'Picking…' : 'Pick Element'}
        </button>
      </div>

      {(suggestions.length > 0 || error) && (
        <div
          className="flex min-h-8 items-center gap-2 border-b px-3 py-1"
          style={{ borderColor: 'var(--color-line)', background: colors.panel }}
        >
          {error ? (
            <p role="alert" className="truncate text-[9.5px]" style={{ color: '#ef8875' }}>
              {error}
            </p>
          ) : (
            <>
              <span className="text-[8.5px] uppercase tracking-wider" style={{ color: colors.quartzDim }}>
                Local dev server
              </span>
              {suggestions.map((url) => (
                <button
                  key={url}
                  type="button"
                  onClick={() => {
                    setAddress(url)
                    void navigate(url)
                  }}
                  className="cursor-pointer rounded-full border px-2 py-0.5 font-mono text-[9px] transition-colors hover:bg-white/[0.05] focus-visible:outline-none focus-visible:ring-2"
                  style={{ borderColor: 'rgba(34,197,94,0.28)', color: colors.done }}
                >
                  {url}
                </button>
              ))}
            </>
          )}
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        <div
          ref={viewportRef}
          data-testid="browser-viewport"
          className="relative m-4 min-w-0 flex-1 overflow-hidden rounded-xl border"
          style={{
            background: '#11100d',
            borderColor: 'var(--color-line-strong)',
            boxShadow: '0 10px 36px rgba(0,0,0,0.28), inset 0 1px rgba(255,255,255,0.035)'
          }}
        >
          {!address && (
            <div className="absolute inset-0 flex items-center justify-center p-8 text-center">
              <div>
                <IconWorld className="mx-auto" size={24} stroke={1.2} style={{ color: colors.bronzeHot }} />
                <p className="mt-3 text-xs font-semibold" style={{ color: colors.quartz }}>
                  Browse the app you are designing
                </p>
                <p className="mt-1 text-[9.5px]" style={{ color: colors.quartzDim }}>
                  Open an HTTP(S) page, then pick any element for a CDP-backed design handoff.
                </p>
              </div>
            </div>
          )}
        </div>

        {context && <PickedElementCard context={context} />}
      </div>
    </section>
  )
}
