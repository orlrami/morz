import { create } from 'zustand'
import type { Task } from '@shared/bus'
import type {
  ReviewAuthor,
  ReviewFinding,
  ReviewerBridge,
  ReviewRunInput,
  ReviewRunResult
} from '@shared/ipc'
import type { MorzBusApi } from '@shared/bus-ipc'
import type { Space } from './spaceStore'

export interface ReviewCandidate extends ReviewRunInput {
  id: string
  taskId: string
  label: string
  branch: string
  authorAgent: string
}

interface ReviewState {
  candidates: ReviewCandidate[]
  selectedId: string | null
  result: ReviewRunResult | null
  loading: boolean
  error: string | null
  sentFinding: string | null
  start(spaces: Space[]): void
  select(id: string): void
  run(): Promise<void>
  sendToAgent(finding: ReviewFinding): Promise<void>
}

type ReviewerWindow = Window & {
  morzReviewer?: ReviewerBridge
  morz?: { bus?: MorzBusApi }
}

let reviewerSubscribed = false

function bridges(): { reviewer?: ReviewerBridge; bus?: MorzBusApi } {
  const current = window as ReviewerWindow
  return { reviewer: current.morzReviewer, bus: current.morz?.bus }
}

function candidatesFrom(tasks: Task[], spaces: Space[]): ReviewCandidate[] {
  const agents = new Map<string, { root: string; author: ReviewAuthor }>()
  for (const space of spaces) {
    for (const agent of space.agents) {
      if (agent.cli === 'claude' || agent.cli === 'codex') {
        agents.set(agent.id, { root: agent.root, author: agent.cli })
      }
    }
  }

  const candidates: ReviewCandidate[] = []
  for (const task of tasks) {
    for (const artifact of task.artifacts) {
      if (artifact.commits.length === 0) continue
      const agent = agents.get(artifact.producedBy)
      if (!agent) continue
      const first = artifact.commits[0]
      const last = artifact.commits[artifact.commits.length - 1]
      candidates.push({
        id: `${task.id}:${artifact.id}`,
        taskId: task.id,
        label: artifact.label || task.title,
        branch: last.branch,
        cwd: agent.root,
        baseRef: `${first.sha}^`,
        headRef: last.sha,
        author: agent.author,
        authorAgent: artifact.producedBy
      })
    }
  }
  return candidates.sort((a, b) => a.branch.localeCompare(b.branch) || a.label.localeCompare(b.label))
}

function findingKey(finding: ReviewFinding): string {
  return `${finding.file}:${finding.line}:${finding.title}`
}

export const useReviewStore = create<ReviewState>()((set, get) => ({
  candidates: [],
  selectedId: null,
  result: null,
  loading: false,
  error: null,
  sentFinding: null,
  start: (spaces) => {
    const { reviewer, bus } = bridges()
    if (reviewer && !reviewerSubscribed) {
      reviewerSubscribed = true
      reviewer.onChanged((result) => set({ result, loading: false, error: null }))
    }
    if (!bus) {
      set({ error: 'Reviewer bus bridge is unavailable.' })
      return
    }
    void bus
      .snapshot()
      .then((snapshot) => {
        const candidates = candidatesFrom(snapshot.tasks, spaces)
        const selected = get().selectedId
        set({
          candidates,
          selectedId: selected && candidates.some((item) => item.id === selected)
            ? selected
            : candidates[0]?.id ?? null,
          error: null
        })
      })
      .catch((error: unknown) =>
        set({ error: error instanceof Error ? error.message : String(error) })
      )
  },
  select: (selectedId) => set({ selectedId, result: null, error: null, sentFinding: null }),
  run: async () => {
    const state = get()
    const candidate = state.candidates.find((item) => item.id === state.selectedId)
    const reviewer = bridges().reviewer
    if (!candidate || !reviewer || state.loading) return
    set({ loading: true, result: null, error: null, sentFinding: null })
    try {
      const result = await reviewer.run({
        cwd: candidate.cwd,
        baseRef: candidate.baseRef,
        headRef: candidate.headRef,
        author: candidate.author
      })
      set({ result, loading: false })
    } catch (error) {
      set({
        loading: false,
        error: error instanceof Error ? error.message : String(error)
      })
    }
  },
  sendToAgent: async (finding) => {
    const state = get()
    const candidate = state.candidates.find((item) => item.id === state.selectedId)
    const bus = bridges().bus
    if (!candidate || !bus) return
    try {
      await bus.post({
        from: 'morz-reviewer',
        to: candidate.authorAgent,
        title: `Review finding: ${finding.title}`,
        text: [
          `${finding.severity.toUpperCase()} at ${finding.file}:${finding.line}`,
          finding.evidence,
          finding.suggestedFix ? `Suggested fix: ${finding.suggestedFix}` : null
        ]
          .filter(Boolean)
          .join('\n\n')
      })
      set({ sentFinding: findingKey(finding), error: null })
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) })
    }
  }
}))
