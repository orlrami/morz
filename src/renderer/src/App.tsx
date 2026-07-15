/* Morz renderer root — live PTY, git, lane, run, cost, and settings surfaces. */
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
