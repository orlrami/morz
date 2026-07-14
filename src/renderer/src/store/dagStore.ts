import { create } from 'zustand'
import type { Task } from '@shared/bus'

interface DagState {
  tasks: Task[]
  recentlyCompleted: string[]
  error: string | null
  ingest(tasks: Task[]): void
  setError(error: string | null): void
}

const pulseTimers = new Map<string, ReturnType<typeof setTimeout>>()

export const useDagStore = create<DagState>()((set, get) => ({
  tasks: [],
  recentlyCompleted: [],
  error: null,
  ingest: (tasks) => {
    const previous = new Map(get().tasks.map((task) => [task.id, task.state]))
    const completed = tasks
      .filter((task) => task.state === 'done' && previous.has(task.id) && previous.get(task.id) !== 'done')
      .map((task) => task.id)

    set((state) => ({
      tasks,
      recentlyCompleted: [...new Set([...state.recentlyCompleted, ...completed])],
      error: null
    }))

    for (const taskId of completed) {
      const prior = pulseTimers.get(taskId)
      if (prior) clearTimeout(prior)
      pulseTimers.set(
        taskId,
        setTimeout(() => {
          pulseTimers.delete(taskId)
          set((state) => ({
            recentlyCompleted: state.recentlyCompleted.filter((id) => id !== taskId)
          }))
        }, 4_000)
      )
    }
  },
  setError: (error) => set({ error })
}))

export function subscribeDag(): () => void {
  const bus = window.morz?.bus
  if (!bus) {
    useDagStore.getState().setError('Agent bus unavailable')
    return () => undefined
  }

  const refresh = (): void => {
    void bus
      .listTasks()
      .then((tasks) => useDagStore.getState().ingest(tasks))
      .catch((error: unknown) =>
        useDagStore
          .getState()
          .setError(error instanceof Error ? error.message : 'Unable to load dependency graph')
      )
  }

  refresh()
  return bus.onTasksChanged((tasks) => useDagStore.getState().ingest(tasks))
}
