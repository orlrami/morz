/*
 * Morz — Phase 0 coded prototype.
 * High-fidelity shell with the locked design language (graphite / quartz / bronze).
 * All data is mock (lib/mock.ts); PTY + orchestration wire in during Phase 1/2.
 */
import { Shell } from './components/Shell'

export default function App(): JSX.Element {
  return <Shell />
}
