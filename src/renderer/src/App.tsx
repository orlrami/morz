/*
 * Morz — v0.1 shell placeholder.
 *
 * This is intentionally minimal. The real UI (shell, spaces sidebar, terminal
 * panes, orchestrator panel, commit UX, mobile) is being designed in Figma and
 * built with a UI builder, then dropped into src/renderer/src/components/.
 * This screen just proves the app boots with the locked design tokens applied.
 */
export default function App(): JSX.Element {
  return (
    <div style={styles.app}>
      <div style={styles.titlebar}>
        <div style={styles.logo}>
          <span style={styles.mark}>M</span>
          <span style={styles.name}>Morz</span>
        </div>
        <span style={styles.tag}>v0.1 · shell</span>
      </div>

      <div style={styles.body}>
        <div style={styles.card}>
          <div style={styles.markLg}>M</div>
          <h1 style={styles.h1}>Morz</h1>
          <p style={styles.sub}>
            Windows-first AI terminal · lightweight IDE · opt-in multi-agent orchestration
          </p>
          <p style={styles.note}>
            Design tokens loaded (graphite · quartz · bronze). UI shell arrives next from
            Figma / the UI builder. Terminal + orchestration wired in Phase&nbsp;1.
          </p>
          <div style={styles.dots}>
            <i style={{ ...styles.dot, background: 'var(--status-working)' }} />
            <i style={{ ...styles.dot, background: 'var(--status-blocked)' }} />
            <i style={{ ...styles.dot, background: 'var(--status-done)' }} />
            <i style={{ ...styles.dot, background: 'var(--status-error)' }} />
          </div>
        </div>
      </div>
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  app: { height: '100%', display: 'flex', flexDirection: 'column' },
  titlebar: {
    height: 38,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '0 14px',
    background: 'var(--graphite-panel)',
    borderBottom: '1px solid var(--line)',
    WebkitAppRegion: 'drag'
  } as React.CSSProperties,
  logo: { display: 'flex', alignItems: 'center', gap: 8, fontWeight: 700 },
  mark: {
    width: 20,
    height: 20,
    borderRadius: 7,
    background: 'linear-gradient(135deg, var(--bronze-bright), #9a7226)',
    color: '#241c0a',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontWeight: 800,
    fontSize: 12
  },
  name: { fontSize: 13 },
  tag: { color: 'var(--quartz-faint)', fontSize: 11 },
  body: { flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' },
  card: {
    textAlign: 'center',
    maxWidth: 440,
    padding: 40,
    borderRadius: 'var(--radius-shell)',
    background: 'var(--graphite-panel)',
    border: '1px solid var(--line)'
  },
  markLg: {
    width: 56,
    height: 56,
    borderRadius: 16,
    margin: '0 auto 18px',
    background: 'linear-gradient(135deg, var(--bronze-bright), #9a7226)',
    color: '#241c0a',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontWeight: 800,
    fontSize: 28
  },
  h1: { fontSize: 26, fontWeight: 800, marginBottom: 8 },
  sub: { color: 'var(--quartz-dim)', fontSize: 13, lineHeight: 1.6, marginBottom: 16 },
  note: { color: 'var(--quartz-faint)', fontSize: 12, lineHeight: 1.6 },
  dots: { display: 'flex', gap: 8, justifyContent: 'center', marginTop: 20 },
  dot: { width: 9, height: 9, borderRadius: '50%', display: 'inline-block' }
}
