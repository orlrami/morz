/*
 * Slate → xterm ITheme mapping.
 * Every Morz theme gets a hand-tuned 16-color ANSI set; bg/fg/cursor/selection
 * derive from the MorzTheme surfaces so terminal + chrome share one palette.
 * Live-updates via subscribeXtermTheme (App also remounts on theme change).
 */
import type { ITheme } from '@xterm/xterm'
import { themes, useThemeStore, type MorzTheme } from './themes'

type Ansi16 = [
  string, string, string, string, string, string, string, string, // 0–7
  string, string, string, string, string, string, string, string // 8–15 bright
]

/* black red green yellow blue magenta cyan white, then brights. */
const ANSI: Record<string, Ansi16> = {
  // Morz-tuned: muted colors that sit on the gray, yellow = bronze.
  slate: [
    '#33363B', '#E2726E', '#8FBF7F', '#E2C687', '#7FA6D9', '#B58FC9', '#7FBFB8', '#D9D4CA',
    '#5A5F66', '#F08A86', '#A5D096', '#F0D9A0', '#9ABCE8', '#CCA8DE', '#99D4CD', '#EDE9E0'
  ],
  // Warm-shifted for the low-blue-light theme.
  graphite: [
    '#3A362E', '#D9776B', '#9CBF7F', '#E4BC77', '#8AA6C9', '#BC91BC', '#8FBFAF', '#DAD2C3',
    '#5E574A', '#E8907F', '#B2D096', '#F0D093', '#A3BCDE', '#CFA8CF', '#A5D4C4', '#EEE6D9'
  ],
  // Canonical community palettes below.
  catppuccin: [
    '#45475A', '#F38BA8', '#A6E3A1', '#F9E2AF', '#89B4FA', '#F5C2E7', '#94E2D5', '#BAC2DE',
    '#585B70', '#F38BA8', '#A6E3A1', '#F9E2AF', '#89B4FA', '#F5C2E7', '#94E2D5', '#A6ADC8'
  ],
  nord: [
    '#3B4252', '#BF616A', '#A3BE8C', '#EBCB8B', '#81A1C1', '#B48EAD', '#88C0D0', '#E5E9F0',
    '#4C566A', '#BF616A', '#A3BE8C', '#EBCB8B', '#81A1C1', '#B48EAD', '#8FBCBB', '#ECEFF4'
  ],
  tokyonight: [
    '#414868', '#F7768E', '#9ECE6A', '#E0AF68', '#7AA2F7', '#BB9AF7', '#7DCFFF', '#A9B1D6',
    '#565F89', '#F7768E', '#9ECE6A', '#E0AF68', '#7AA2F7', '#BB9AF7', '#7DCFFF', '#C0CAF5'
  ],
  dracula: [
    '#282A36', '#FF5555', '#50FA7B', '#F1FA8C', '#BD93F9', '#FF79C6', '#8BE9FD', '#F8F8F2',
    '#6272A4', '#FF6E6E', '#69FF94', '#FFFFA5', '#D6ACFF', '#FF92DF', '#A4FFFF', '#FFFFFF'
  ]
}

export function xtermTheme(theme: MorzTheme): ITheme {
  const a = ANSI[theme.id] ?? ANSI.slate
  return {
    background: theme.page,
    foreground: theme.quartz,
    cursor: theme.bronzeHot,
    cursorAccent: theme.page,
    selectionBackground: `${theme.bronze}4D`, // bronze @ ~30%
    selectionInactiveBackground: `${theme.bronze}26`,
    black: a[0],
    red: a[1],
    green: a[2],
    yellow: a[3],
    blue: a[4],
    magenta: a[5],
    cyan: a[6],
    white: a[7],
    brightBlack: a[8],
    brightRed: a[9],
    brightGreen: a[10],
    brightYellow: a[11],
    brightBlue: a[12],
    brightMagenta: a[13],
    brightCyan: a[14],
    brightWhite: a[15]
  }
}

export function activeXtermTheme(): ITheme {
  const id = useThemeStore.getState().themeId
  const theme = themes.find((t) => t.id === id) ?? themes[0]
  return xtermTheme(theme)
}

/** Subscribe to theme changes; returns unsubscribe. */
export function subscribeXtermTheme(cb: (t: ITheme) => void): () => void {
  let last = useThemeStore.getState().themeId
  return useThemeStore.subscribe((s) => {
    if (s.themeId === last) return
    last = s.themeId
    cb(activeXtermTheme())
  })
}
