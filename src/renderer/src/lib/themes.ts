/*
 * Morz themes — full app palettes (terminal + chrome share one).
 * "Slate" is the flagship: complete gray, Warp-like, quartz/bronze interactive.
 * "Graphite" (the original) stays as the warm low-blue-light theme.
 * Others are Morz-tuned takes on the most popular community palettes.
 */
import { create } from 'zustand'
import { colors } from './tokens'

export interface MorzTheme {
  id: string
  name: string
  note: string
  page: string
  panel: string
  card: string
  hover: string
  quartz: string
  quartzDim: string
  bronze: string
  bronzeHot: string
  line: string
  lineStrong: string
}

export const themes: MorzTheme[] = [
  {
    id: 'slate',
    name: 'Slate',
    note: 'complete gray · quartz buttons — flagship',
    page: '#1F2124',
    panel: '#26282C',
    card: '#2E3136',
    hover: '#383C42',
    quartz: '#EDE9E0',
    quartzDim: 'rgba(237,233,224,0.45)',
    bronze: '#C9A967',
    bronzeHot: '#E2C687',
    line: 'rgba(237,233,224,0.08)',
    lineStrong: 'rgba(237,233,224,0.14)'
  },
  {
    id: 'graphite',
    name: 'Graphite',
    note: 'warm dark · low blue light',
    page: '#26241E',
    panel: '#2E2B24',
    card: '#37332B',
    hover: '#423D33',
    quartz: '#EEE6D9',
    quartzDim: 'rgba(238,230,217,0.45)',
    bronze: '#CBA25A',
    bronzeHot: '#E4BC77',
    line: 'rgba(238,230,217,0.08)',
    lineStrong: 'rgba(238,230,217,0.14)'
  },
  {
    id: 'catppuccin',
    name: 'Catppuccin Mocha',
    note: 'soft pastel dark',
    page: '#1E1E2E',
    panel: '#26263A',
    card: '#313244',
    hover: '#3B3B54',
    quartz: '#CDD6F4',
    quartzDim: 'rgba(205,214,244,0.45)',
    bronze: '#F5C2E7',
    bronzeHot: '#F8D7EF',
    line: 'rgba(205,214,244,0.08)',
    lineStrong: 'rgba(205,214,244,0.14)'
  },
  {
    id: 'nord',
    name: 'Nord',
    note: 'arctic blue-gray',
    page: '#22262F',
    panel: '#2E3440',
    card: '#3B4252',
    hover: '#434C5E',
    quartz: '#ECEFF4',
    quartzDim: 'rgba(236,239,244,0.45)',
    bronze: '#88C0D0',
    bronzeHot: '#A3D3E0',
    line: 'rgba(236,239,244,0.08)',
    lineStrong: 'rgba(236,239,244,0.14)'
  },
  {
    id: 'tokyonight',
    name: 'Tokyo Night',
    note: 'deep indigo',
    page: '#16161E',
    panel: '#1A1B26',
    card: '#24283B',
    hover: '#2E3350',
    quartz: '#C0CAF5',
    quartzDim: 'rgba(192,202,245,0.45)',
    bronze: '#7AA2F7',
    bronzeHot: '#9BB8FA',
    line: 'rgba(192,202,245,0.08)',
    lineStrong: 'rgba(192,202,245,0.14)'
  },
  {
    id: 'dracula',
    name: 'Dracula',
    note: 'high-contrast violet',
    page: '#21222C',
    panel: '#282A36',
    card: '#343746',
    hover: '#3F4358',
    quartz: '#F8F8F2',
    quartzDim: 'rgba(248,248,242,0.45)',
    bronze: '#BD93F9',
    bronzeHot: '#D2B3FB',
    line: 'rgba(248,248,242,0.08)',
    lineStrong: 'rgba(248,248,242,0.14)'
  }
]

/* Apply: mutate the shared colors object + the CSS vars, then bump version to remount. */
export function applyTheme(theme: MorzTheme): void {
  Object.assign(colors, {
    page: theme.page,
    panel: theme.panel,
    card: theme.card,
    quartz: theme.quartz,
    quartzDim: theme.quartzDim,
    bronze: theme.bronze,
    bronzeHot: theme.bronzeHot
  })
  const root = document.documentElement.style
  root.setProperty('--color-page', theme.page)
  root.setProperty('--color-panel', theme.panel)
  root.setProperty('--color-card', theme.card)
  root.setProperty('--color-hover', theme.hover)
  root.setProperty('--color-quartz', theme.quartz)
  root.setProperty('--color-line', theme.line)
  root.setProperty('--color-line-strong', theme.lineStrong)
  document.body.style.background = theme.page
  document.body.style.color = theme.quartz
}

interface ThemeState {
  themeId: string
  version: number
  setTheme: (id: string) => void
}

export const useThemeStore = create<ThemeState>((set) => ({
  themeId: 'graphite',
  version: 0,
  setTheme: (id) => {
    const theme = themes.find((t) => t.id === id)
    if (!theme) return
    applyTheme(theme)
    set((s) => ({ themeId: id, version: s.version + 1 }))
  }
}))
