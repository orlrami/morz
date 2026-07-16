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
import type { MorzReportApi } from '@shared/report'
import type { GitStatus } from '@shared/ipc'
import type { Space } from './spaceStore'

const AUTO_BASE_REF = 'MORZ_BASE'

export type ReviewResult = ReviewRunResult & {
  emptyDiff?: boolean
  findingsTruncated?: boolean
  totalFindings?: number
}

export interface ReviewCandidate extends ReviewRunInput {
  id: string
  taskId: string
  label: string
  branch: string
  authorAgent: string
  source: 'space' | 'artifact'
}

interface ReviewState {
  candidates: ReviewCandidate[]
  selectedId: string | null
  result: ReviewResult | null
  loading: boolean
  error: string | null
  summary: string | null
  summaryLoading: boolean
  summaryError: string | null
  sentFinding: string | null
  selectionTouched: boolean
  start(spaces: Space[], activeSpaceId: string | null, gitByRoot: Record<string, GitStatus>): void
  select(id: string): void
  run(): Promise<void>
  sendToAgent(finding: ReviewFinding): Promise<void>
}

type ReviewerWindow = Window & {
  morzReviewer?: ReviewerBridge
  morzReport?: MorzReportApi
  morz?: { bus?: MorzBusApi; report?: MorzReportApi }
}

let reviewerSubscribed = false
let candidateLoadSequence = 0
let lastActiveSpaceId: string | null | undefined

function bridges(): { reviewer?: ReviewerBridge; bus?: MorzBusApi; report?: MorzReportApi } {
  const current = window as ReviewerWindow
  return {
    reviewer: current.morzReviewer,
    bus: current.morz?.bus,
    report: current.morz?.report ?? current.morzReport
  }
}

function activeSpaceCandidate(
  spaces: Space[],
  activeSpaceId: string | null,
  gitByRoot: Record<string, GitStatus>
): ReviewCandidate | null {
  const space = spaces.find((item) => item.id === activeSpaceId)
  if (!space) return null
  const branch = gitByRoot[space.root]?.branch
  if (!branch || branch === '(detached)') return null
  const authorAgent = space.agents.find((agent) => agent.cli === 'claude')?.id ?? ''
  return {
    id: `space:${space.id}:${branch}`,
    taskId: '',
    label: 'Current branch vs base',
    branch,
    cwd: space.root,
    baseRef: AUTO_BASE_REF,
    headRef: branch,
    author: 'claude',
    authorAgent,
    source: 'space'
  }
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
        authorAgent: artifact.producedBy,
        source: 'artifact'
      })
    }
  }
  return candidates.sort((a, b) => a.branch.localeCompare(b.branch) || a.label.localeCompare(b.label))
}

function findingKey(finding: ReviewFinding): string {
  return `${finding.file}:${finding.line}:${finding.title}`
}

function humanError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.replace(/^Error invoking remote method '[^']+':\s*/, '').replace(/^\[reviewer\]\s*/, '')
}

function reviewSummaryContext(result: ReviewResult): string {
  const total = result.totalFindings ?? result.findings.length
  return [
    `Review target: ${result.headRef} vs ${result.baseRef}`,
    `Reviewer: ${result.reviewer}`,
    `Findings: ${result.findings.length} shown of ${total} total`,
    '',
    ...result.findings.map(
      (finding, index) =>
        `${index + 1}. [${finding.severity.toUpperCase()}] ${finding.title}\n` +
        `${finding.file}:${finding.line}\n${finding.evidence}`
    ),
    '',
    'Write a concise human-readable review summary. Lead with the three things that matter most, ordered by impact.'
  ].join('\n')
}

export const useReviewStore = create<ReviewState>()((set, get) => ({
  candidates: [],
  selectedId: null,
  result: null,
  loading: false,
  error: null,
  summary: null,
  summaryLoading: false,
  summaryError: null,
  sentFinding: null,
  selectionTouched: false,
  start: (spaces, activeSpaceId, gitByRoot) => {
    const loadSequence = ++candidateLoadSequence
    const { reviewer, bus } = bridges()
    if (reviewer && !reviewerSubscribed) {
      reviewerSubscribed = true
      reviewer.onChanged((result) =>
        set({
          result: result as ReviewResult,
          loading: false,
          error: null,
          summary: null,
          summaryLoading: false,
          summaryError: 'Run review in this window to generate an AI priority brief.'
        })
      )
    }
    const activeCandidate = activeSpaceCandidate(spaces, activeSpaceId, gitByRoot)
    const activeSpaceChanged =
      lastActiveSpaceId !== undefined && lastActiveSpaceId !== activeSpaceId
    lastActiveSpaceId = activeSpaceId
    if (activeSpaceChanged) {
      set({
        selectedId: activeCandidate?.id ?? null,
        selectionTouched: false,
        result: null,
        error: null,
        summary: null,
        summaryLoading: false,
        summaryError: null,
        sentFinding: null
      })
    }
    if (!bus) {
      const candidates = activeCandidate ? [activeCandidate] : []
      set({
        candidates,
        selectedId: candidates[0]?.id ?? null,
        error: reviewer ? null : 'The review bridge is unavailable. Restart Morz and try again.'
      })
      return
    }
    void bus
      .snapshot()
      .then((snapshot) => {
        if (loadSequence !== candidateLoadSequence) return
        const artifacts = candidatesFrom(snapshot.tasks, spaces)
        const candidates = activeCandidate ? [activeCandidate, ...artifacts] : artifacts
        const current = get()
        const selected = current.selectedId
        set({
          candidates,
          selectedId:
            current.selectionTouched && selected && candidates.some((item) => item.id === selected)
              ? selected
              : (activeCandidate?.id ?? candidates[0]?.id ?? null),
          error: null
        })
      })
      .catch((error: unknown) => {
        if (loadSequence !== candidateLoadSequence) return
        set({
          candidates: activeCandidate ? [activeCandidate] : [],
          selectedId: activeCandidate?.id ?? null,
          error: activeCandidate ? null : humanError(error)
        })
      })
  },
  select: (selectedId) =>
    set({
      selectedId,
      selectionTouched: true,
      result: null,
      error: null,
      summary: null,
      summaryLoading: false,
      summaryError: null,
      sentFinding: null
    }),
  run: async () => {
    const state = get()
    const candidate = state.candidates.find((item) => item.id === state.selectedId)
    const reviewer = bridges().reviewer
    if (!candidate || state.loading) return
    if (!reviewer) {
      set({ error: 'The review bridge is unavailable. Restart Morz and try again.' })
      return
    }
    set({
      loading: true,
      result: null,
      error: null,
      summary: null,
      summaryLoading: false,
      summaryError: null,
      sentFinding: null
    })
    try {
      const result = (await reviewer.run({
        cwd: candidate.cwd,
        baseRef: candidate.baseRef,
        headRef: candidate.headRef,
        author: candidate.author
      })) as ReviewResult
      const needsSummary = !result.emptyDiff && result.findings.length > 0
      set({ result, loading: false, summaryLoading: needsSummary })
      if (!needsSummary) return

      const report = bridges().report
      if (!report) {
        set({
          summaryLoading: false,
          summaryError:
            'Connect a report engine in Settings to turn these findings into a short priority brief.'
        })
        return
      }
      try {
        const response = await report.summarize({
          kind: 'review',
          cwd: result.cwd,
          context: reviewSummaryContext(result)
        })
        if (get().result?.id !== result.id) return
        if (response.ok) {
          set({ summary: response.text, summaryLoading: false, summaryError: null })
        } else {
          set({
            summaryLoading: false,
            summaryError: `${response.text} Connect or test the report engine in Settings.`
          })
        }
      } catch (error) {
        if (get().result?.id !== result.id) return
        set({
          summaryLoading: false,
          summaryError: `${humanError(error)} Connect or test the report engine in Settings.`
        })
      }
    } catch (error) {
      set({
        loading: false,
        summaryLoading: false,
        error: humanError(error)
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
      set({ error: humanError(error) })
    }
  }
}))
