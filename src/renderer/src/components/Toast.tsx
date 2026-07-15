import { useEffect } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { IconAlertCircle, IconX } from '@tabler/icons-react'
import { colors } from '@/lib/tokens'
import { springs } from '@/lib/springs'
import { useNotifyStore } from '@/store/notifyStore'

/** Error notices get a short, throttled toast; the durable copy remains in the Center. */
export function ToastHost(): JSX.Element {
  const toast = useNotifyStore((state) => state.toast)
  const clearToast = useNotifyStore((state) => state.clearToast)
  const runAction = useNotifyStore((state) => state.runAction)

  useEffect(() => {
    if (!toast) return
    const timer = window.setTimeout(clearToast, 8_000)
    return () => window.clearTimeout(timer)
  }, [clearToast, toast])

  const action = toast?.actions?.[0]
  return (
    <div className="pointer-events-none absolute bottom-10 right-3 z-50">
      <AnimatePresence>
        {toast && (
          <motion.div
            key={`${toast.id}:${toast.ts ?? 0}`}
            initial={{ opacity: 0, y: 24, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1, transition: springs.float }}
            exit={{ opacity: 0, scale: 0.95, transition: { duration: 0.15 } }}
            className="pointer-events-auto flex w-[320px] items-start gap-2.5 rounded-2xl border p-3 shadow-2xl"
            style={{ background: colors.panel, borderColor: `${colors.error}99` }}
            role="alert"
            aria-live="assertive"
          >
            <span
              className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg"
              style={{ background: `${colors.error}1f`, color: colors.error }}
            >
              <IconAlertCircle size={15} stroke={1.6} />
            </span>
            <span className="min-w-0 flex-1 text-xs leading-snug">
              <strong className="block" style={{ fontFamily: 'var(--font-display)' }}>
                {toast.title}
              </strong>
              {toast.detail && (
                <span className="mt-0.5 block" style={{ color: colors.quartzDim }}>
                  {toast.detail}
                </span>
              )}
              {action && (
                <button
                  type="button"
                  className="mt-2 rounded-lg border px-2.5 py-1 text-[10px] font-bold hover:brightness-125"
                  style={{ borderColor: `${colors.error}88`, color: colors.error }}
                  onClick={() => {
                    runAction(toast.id, action.id)
                    clearToast()
                  }}
                >
                  {action.label}
                </button>
              )}
            </span>
            <button
              type="button"
              onClick={clearToast}
              className="cursor-pointer rounded p-0.5 hover:bg-[#37332B]"
              aria-label="Dismiss error toast"
              style={{ color: colors.quartzDim }}
            >
              <IconX size={12} stroke={1.5} />
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
