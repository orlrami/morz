import { useMemo } from 'react'
import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { MorzRunApi, RunHistoryPolicy, RunSummary } from '@shared/ipc'
import type { RunStatus } from '@shared/spawn-plan'
import { useModulesStore } from './modulesStore' // w15/modules-core
import { selectActiveSpaceRoot, useSpaceStore } from './spaceStore'

export type { RunHistoryPolicy } from '@shared/ipc'

const LIVE_RUN_STATES = new Set<RunSummary['state']>(['dispatching', 'running', 'merging'])
const RUNS_SETTINGS_KEY = 'morz.runs.settings.v1'
const LEGACY_HISTORY_POLICY_KEY = 'morz.runs.history-policy.v1'

export const RUN_HISTORY_POLICIES: readonly {
  value: RunHistoryPolicy
  label: string
}[] = [
  { value: 'forever', label: 'Keep forever' },
  { value: 'launch', label: 'Clear on launch' },
  { value: 'last-5', label: 'Keep last 5' }
]

function isRunHistoryPolicy(value: unknown): value is RunHistoryPolicy {
  return RUN_HISTORY_POLICIES.some((policy) => policy.value === value)
}

function migrateLegacyHistoryPolicy(): RunHistoryPolicy {
  if (typeof window === 'undefined') return 'forever'
  try {
    if (window.localStorage.getItem(RUNS_SETTINGS_KEY) !== null) return 'forever'
    const legacy = window.localStorage.getItem(LEGACY_HISTORY_POLICY_KEY)
    if (!isRunHistoryPolicy(legacy)) return 'forever'
    window.localStorage.setItem(
      RUNS_SETTINGS_KEY,
      JSON.stringify({ state: { historyPolicy: legacy }, version: 1 })
    )
    window.localStorage.removeItem(LEGACY_HISTORY_POLICY_KEY)
    return legacy
  } catch {
    // Storage can be unavailable in hardened renderer contexts; fail to the safest retention policy.
    return 'forever'
  }
}

interface RunsState {
  available: boolean
  loading: boolean
  error: string | null
  runs: RunSummary[]
  statuses: Record<string, RunStatus>
  selectedRunId: string | null
  historyPolicy: RunHistoryPolicy
  ingest(status: RunStatus): void
  selectRun(runId: string): void
  evictRuns(runIds: readonly string[]): void
  setHistoryPolicy(policy: RunHistoryPolicy): void
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

const evictedRunIds = new Set<string>()

export const useRunsStore = create<RunsState>()(
  persist(
    (set) => ({
      available: true,
      loading: true,
      error: null,
      runs: [],
      statuses: {},
      selectedRunId: null,
      historyPolicy: migrateLegacyHistoryPolicy(),
      ingest: (status) =>
        set((state) => {
          if (evictedRunIds.has(status.runId)) return state
          return {
            statuses: { ...state.statuses, [status.runId]: status },
            runs: state.runs.map((run) =>
              run.runId === status.runId ? { ...run, state: status.state } : run
            ),
            error: null
          }
        }),
      selectRun: (runId) => {
        set({ selectedRunId: runId, error: null })
        void loadStatus(runId)
      },
      evictRuns: (runIds) =>
        set((state) => {
          if (runIds.length === 0) return state
          for (const id of runIds) evictedRunIds.add(id)
          const cleared = new Set(runIds)
          const runs = state.runs.filter((run) => !cleared.has(run.runId))
          const statuses = { ...state.statuses }
          for (const runId of cleared) delete statuses[runId]
          return {
            runs,
            statuses,
            selectedRunId:
              state.selectedRunId && !cleared.has(state.selectedRunId)
                ? state.selectedRunId
                : (runs[0]?.runId ?? null)
          }
        }),
      setHistoryPolicy: (historyPolicy) => {
        if (isRunHistoryPolicy(historyPolicy)) set({ historyPolicy })
      },
      setError: (error) => set({ error })
    }),
    {
      name: RUNS_SETTINGS_KEY,
      version: 1,
      partialize: (state) => ({ historyPolicy: state.historyPolicy }),
      merge: (persisted, current) => {
        const stored = persisted as Partial<RunsState> | undefined
        return {
          ...current,
          historyPolicy: isRunHistoryPolicy(stored?.historyPolicy)
            ? stored.historyPolicy
            : current.historyPolicy
        }
      }
    }
  )
)

// Snapshot after synchronous persistence hydration. Changes made during this
// session take effect on the next renderer launch, matching the control copy.
const launchHistoryPolicy = useRunsStore.getState().historyPolicy

export function getLaunchRunHistoryPolicy(): RunHistoryPolicy {
  return launchHistoryPolicy
}

/** Pull summaries newest-first, select the newest run, and hydrate its detail. */
export async function hydrateRuns(): Promise<void> {
  // w15/modules-core — run sync belongs to the orchestration module
  if (!useModulesStore.getState().enabled.orchestration) return
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
      // w15/modules-core — pushes for a disabled orchestration module are dropped
      if (!useModulesStore.getState().enabled.orchestration) return
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

// w15/modules-core — enabling orchestration at runtime hydrates without a restart.
useModulesStore.subscribe((state, previous) => {
  if (state.enabled.orchestration && !previous.enabled.orchestration) void hydrateRuns()
})
