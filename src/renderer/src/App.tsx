/* Morz renderer root — boot gate, launcher, and live shell surfaces. */
import { useEffect, useState } from 'react'
import type {
  OnLaunchPreference,
  SessionSnapshot,
  StartScreenBridge
} from '@shared/ipc'
import { Shell } from './components/Shell'
import { StartScreen } from './components/StartScreen'
import { useThemeStore } from './lib/themes'

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
  useThemeStore((state) => state.version)
  const [surface, setSurface] = useState<BootSurface>('loading')
  const [preference, setPreference] =
    useState<OnLaunchPreference>('straight-to-shell')

  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get('theme')
    if (id) useThemeStore.getState().setTheme(id)
  }, [])

  useEffect(() => {
    let cancelled = false
    const bridge = startScreenBridge()
    void Promise.all([
      window.morz.session.load().catch(() => null),
      bridge?.getPreference().catch(() => 'straight-to-shell' as const) ??
        Promise.resolve('straight-to-shell' as const)
    ]).then(([snapshot, storedPreference]) => {
      if (cancelled) return
      setPreference(storedPreference)
      // A non-empty saved layout always wins so the launcher never mounts
      // between a live/restorable PTY session and its shell surface.
      setSurface(hasRestorableSession(snapshot) ? 'shell' : 'start')
    })
    return () => {
      cancelled = true
    }
  }, [])

  const savePreference = async (next: OnLaunchPreference): Promise<void> => {
    const saved = (await startScreenBridge()?.setPreference(next)) ?? next
    setPreference(saved)
  }

  if (surface === 'loading') {
    return (
      <div
        className="flex h-full items-center justify-center font-mono text-[10px]"
        style={{
          color: 'var(--color-quartz-dim)',
          background: 'var(--color-page)'
        }}
        aria-label="Loading Morz"
      >
        MORZ / RESTORING STATE…
      </div>
    )
  }
  if (surface === 'start') {
    return (
      <StartScreen
        preference={preference}
        onPreferenceChange={savePreference}
        onEnterShell={() => setSurface('shell')}
      />
    )
  }
  return <Shell />
}
