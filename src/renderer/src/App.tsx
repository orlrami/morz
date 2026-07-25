/* Morz renderer root — live PTY, git, lane, run, cost, and settings surfaces. */
import { useEffect } from 'react'
import { Shell } from './components/Shell'
import { OnboardingScreen } from './components/OnboardingScreen'
import { useThemeStore } from './lib/themes'
import { colors } from './lib/tokens'
import { useOnboardingStore } from './store/onboardingStore'

export default function App(): JSX.Element {
  /* w11/settings-ux: rerender inline tokens without remounting Shell's view state. */
  useThemeStore((s) => s.version)
  const status = useOnboardingStore((state) => state.status)
  const snapshot = useOnboardingStore((state) => state.snapshot)
  const detections = useOnboardingStore((state) => state.detections)
  const setupOpen = useOnboardingStore((state) => state.setupOpen)
  const error = useOnboardingStore((state) => state.error)
  const hydrate = useOnboardingStore((state) => state.hydrate)
  const save = useOnboardingStore((state) => state.save)
  const skip = useOnboardingStore((state) => state.skip)

  /* dev-only: ?theme=slate for screenshot verification */
  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get('theme')
    if (id) useThemeStore.getState().setTheme(id)
  }, [])

  useEffect(() => {
    void hydrate()
  }, [hydrate])

  if (status === 'idle' || status === 'loading') {
    return (
      <main className="grid h-full place-items-center" style={{ background: colors.page }}>
        <p className="text-xs" style={{ color: colors.quartzDim }}>Preparing Morz…</p>
      </main>
    )
  }

  if (status === 'error') {
    return (
      <main className="grid h-full place-items-center p-8 text-center" style={{ background: colors.page }}>
        <div>
          <h1 className="text-base font-bold">Morz setup could not load</h1>
          <p className="mt-2 text-xs" style={{ color: colors.quartzDim }}>{error}</p>
        </div>
      </main>
    )
  }

  if (!snapshot.completed) {
    return <OnboardingScreen snapshot={snapshot} detections={detections} onSave={save} onSkip={skip} />
  }

  return (
    <>
      <Shell />
      {setupOpen && (
        <OnboardingScreen snapshot={snapshot} detections={detections} onSave={save} onSkip={skip} />
      )}
    </>
  )
}
