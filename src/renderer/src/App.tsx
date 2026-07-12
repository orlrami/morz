/*
 * Morz — Phase 0 coded prototype.
 * High-fidelity shell with the locked design language (graphite / quartz / bronze).
 * All data is mock (lib/mock.ts); PTY + orchestration wire in during Phase 1/2.
 */
import { useEffect } from 'react'
import { Shell } from './components/Shell'
import { useThemeStore } from './lib/themes'

export default function App(): JSX.Element {
  /* key remount on theme change so inline token colors re-read */
  const version = useThemeStore((s) => s.version)

  /* dev-only: ?theme=slate for screenshot verification */
  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get('theme')
    if (id) useThemeStore.getState().setTheme(id)
  }, [])

  return <Shell key={version} />
}
