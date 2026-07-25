/* Morz renderer root — boot gate, launcher, and live shell surfaces. */
import { useEffect, useState } from 'react'
import type {
  OnLaunchPreference,
  SessionSnapshot,
  StartScreenBridge
} from '@shared/ipc'
import { Shell } from './components/Shell'
import { OnboardingScreen } from './components/OnboardingScreen'
import { StartScreen } from './components/StartScreen'
import { useThemeStore } from './lib/themes'
import { colors } from './lib/tokens'
import { useOnboardingStore } from './store/onboardingStore'

type BootSurface = 'loading' | 'start' | 'shell'

function hasRestorableSession(snapshot: SessionSnapshot | null): boolean {
  if (!snapshot) return false
  const layout = snapshot.layout as { tree?: unknown; panes?: unknown } | null
  const validPane = (value: unknown): boolean => {
    const pane = value as { paneId?: unknown; kind?: unknown } | null
    return (
      Boolean(pane) &&
      typeof pane?.paneId === 'string' &&
      (pane.kind === 'terminal' || pane.kind === 'claude')
    )
  }
  const validNode = (value: unknown, depth = 0): boolean => {
    if (depth > 64 || !value || typeof value !== 'object') return false
    const node = value as { type?: unknown; pane?: unknown; a?: unknown; b?: unknown }
    if (node.type === 'leaf') return validPane(node.pane)
    if (node.type === 'split') {
      return validNode(node.a, depth + 1) && validNode(node.b, depth + 1)
    }
    return false
  }
  if (validNode(layout?.tree)) return true
  if (layout && Array.isArray(layout.panes) && layout.panes.some(validPane)) return true
  return Array.isArray(snapshot.panes) && snapshot.panes.some((pane) => Boolean(pane.paneId))
}

function startScreenBridge(): StartScreenBridge | undefined {
  return (window as unknown as { morzStartScreen?: StartScreenBridge }).morzStartScreen
}

export default function App(): JSX.Element {
  /* w11/settings-ux: rerender inline tokens without remounting Shell's view state. */
  useThemeStore((s) => s.version)
  // w15/onboarding — first-run gate
  const status = useOnboardingStore((state) => state.status)
  const snapshot = useOnboardingStore((state) => state.snapshot)
  const detections = useOnboardingStore((state) => state.detections)
  const setupOpen = useOnboardingStore((state) => state.setupOpen)
  const error = useOnboardingStore((state) => state.error)
  const hydrate = useOnboardingStore((state) => state.hydrate)
  const save = useOnboardingStore((state) => state.save)
  const skip = useOnboardingStore((state) => state.skip)
  // w15/start-screen — launcher gate (a restorable session always wins)
  const [surface, setSurface] = useState<BootSurface>('loading')
  const [preference, setPreference] = useState<OnLaunchPreference>('straight-to-shell')

  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get('theme')
    if (id) useThemeStore.getState().setTheme(id)
  }, [])

  useEffect(() => {
    void hydrate()
  }, [hydrate])

  useEffect(() => {
    let cancelled = false
    const bridge = startScreenBridge()
    void Promise.all([
      window.morz.session.load().catch(() => null),
      bridge?.getPreference().catch(() => 'straight-to-shell' as const) ??
        Promise.resolve('straight-to-shell' as const)
    ]).then(([saved, storedPreference]) => {
      if (cancelled) return
      setPreference(storedPreference)
      // A non-empty saved layout always wins so the launcher never mounts
      // between a live/restorable PTY session and its shell surface. With
      // nothing to restore there is no shell to go "straight" to, so both
      // preferences land on the launcher.
      const launcherDisabled = (window as unknown as { morzStartScreenDisabled?: boolean })
        .morzStartScreenDisabled
      setSurface(launcherDisabled || hasRestorableSession(saved) ? 'shell' : 'start')
    })
    return () => {
      cancelled = true
    }
  }, [])

  const savePreference = async (next: OnLaunchPreference): Promise<void> => {
    const saved = (await startScreenBridge()?.setPreference(next)) ?? next
    setPreference(saved)
  }

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

  // w15/onboarding — first run configures before anything else mounts.
  if (!snapshot.completed) {
    return <OnboardingScreen snapshot={snapshot} detections={detections} onSave={save} onSkip={skip} />
  }

  if (surface === 'loading') {
    return (
      <div
        className="flex h-full items-center justify-center font-mono text-[10px]"
        style={{ color: 'var(--color-quartz-dim)', background: 'var(--color-page)' }}
        aria-label="Loading Morz"
      >
        MORZ / RESTORING STATE…
      </div>
    )
  }

  // w15/start-screen — launcher when there is nothing to restore.
  if (surface === 'start') {
    return (
      <StartScreen
        preference={preference}
        onPreferenceChange={savePreference}
        onEnterShell={() => setSurface('shell')}
      />
    )
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
