import { useMemo } from 'react'
import { create } from 'zustand'
import type { MorzRunApi, RunSummary } from '@shared/ipc'
import type { RunStatus } from '@shared/spawn-plan'
import { selectActiveSpaceRoot, useSpaceStore } from './spaceStore'

const LIVE_RUN_STATES = new Set<RunSummary['state']>(['dispatching', 'running', 'merging'])

interface RunsState {
  available: boolean
  loading: boolean
  error: string | null
  runs: RunSummary[]
  statuses: Record<string, RunStatus>
  selectedRunId: string | null
  ingest(status: RunStatus): void
  selectRun(runId: string): void
  setError(error: string | null): void
}

function message(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback
}

/** The optional wave-5 bridge; renderer-only/dev builds may not expose it. */
export function getRunApi(): MorzRunApi | undefined {
  const run = window.morz?.run
  return run && typeof run.listRuns === 'function' && typeof run.onRunChanged === 'function'
    ? run
    : undefined
}

async function loadStatus(runId: string): Promise<void> {
  const api = getRunApi()
  if (!api) return
  try {
    const status = await api.runStatus(runId)
    if (status) useRunsStore.getState().ingest(status)
  } catch (error) {
    useRunsStore.getState().setError(message(error, 'Unable to load run status'))
  }
}

export const useRunsStore = create<RunsState>()((set) => ({
  available: true,
  loading: true,
  error: null,
  runs: [],
  statuses: {},
  selectedRunId: null,
  ingest: (status) =>
    set((state) => ({
      statuses: { ...state.statuses, [status.runId]: status },
      runs: state.runs.map((run) =>
        run.runId === status.runId ? { ...run, state: status.state } : run
      ),
      error: null
    })),
  selectRun: (runId) => {
    set({ selectedRunId: runId, error: null })
    void loadStatus(runId)
  },
  setError: (error) => set({ error })
}))

/** Pull summaries newest-first, select the newest run, and hydrate its detail. */
export async function hydrateRuns(): Promise<void> {
  const api = getRunApi()
  if (!api) {
    useRunsStore.setState({ available: false, loading: false, error: null, runs: [] })
    return
  }

  useRunsStore.setState({ available: true, loading: true, error: null })
  try {
    const runs = (await api.listRuns()).sort(
      (a, b) => b.createdAt.localeCompare(a.createdAt) || b.runId.localeCompare(a.runId)
    )
    const selected = useRunsStore.getState().selectedRunId
    const selectedRunId = selected && runs.some((run) => run.runId === selected)
      ? selected
      : runs[0]?.runId ?? null
    useRunsStore.setState({ runs, selectedRunId, loading: false })
    // w11/lanes-runs — pill-bar truth includes every live run, not only the
    // Runs panel's selected row. Keep the selected historical run hydrated too.
    const statusIds = new Set(
      runs.filter((run) => LIVE_RUN_STATES.has(run.state)).map((run) => run.runId)
    )
    if (selectedRunId) statusIds.add(selectedRunId)
    await Promise.all([...statusIds].map((runId) => loadStatus(runId)))
  } catch (error) {
    useRunsStore.setState({
      loading: false,
      error: message(error, 'Unable to load orchestration runs')
    })
  }
}

// w14/orch-scoped — the orchestrator panel sees ONLY the active space's runs.
// The full ledger stays in `runs` (the pill bar and sidebar heuristics remain
// cross-space); scoping happens at the consumer through this hook. Runs
// without a spaceRoot (renderer-only builds) stay visible everywhere.
export function scopeRuns(runs: RunSummary[], spaceRoot: string): RunSummary[] {
  if (!spaceRoot) return runs
  return runs.filter((run) => !run.spaceRoot || run.spaceRoot === spaceRoot)
}

export function useSpaceRuns(): RunSummary[] {
  const runs = useRunsStore((state) => state.runs)
  const spaceRoot = useSpaceStore(selectActiveSpaceRoot)
  return useMemo(() => scopeRuns(runs, spaceRoot), [runs, spaceRoot])
}
// end w14/orch-scoped

let liveSubscription: { refs: number; unsubscribe: () => void } | null = null

/** Subscribe before hydrating so a dispatch cannot slip between the two. */
export function subscribeRuns(): () => void {
  const api = getRunApi()
  if (!api) {
    useRunsStore.setState({ available: false, loading: false, error: null, runs: [] })
    return () => undefined
  }

  // w11/lanes-runs — AgentPillBar, RunsPanel, sidebar, and status bar share one
  // listener. Ref-counting prevents duplicate events without letting one
  // component's cleanup silently unsubscribe the others.
  if (!liveSubscription) {
    const unsubscribe = api.onRunChanged((status) => {
      const known = useRunsStore.getState().runs.some((run) => run.runId === status.runId)
      useRunsStore.getState().ingest(status)
      if (!known) void hydrateRuns()
    })
    liveSubscription = { refs: 0, unsubscribe }
    void hydrateRuns()
  }
  liveSubscription.refs++
  let released = false
  return () => {
    if (released || !liveSubscription) return
    released = true
    liveSubscription.refs--
    if (liveSubscription.refs === 0) {
      liveSubscription.unsubscribe()
      liveSubscription = null
    }
  }
}
