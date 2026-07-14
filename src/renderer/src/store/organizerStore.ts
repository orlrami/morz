import { create } from 'zustand'
import type {
  OrganizerApi,
  OrganizerApplyResult,
  OrganizerExplanation,
  OrganizerPlan,
  OrganizerViolation
} from '@shared/ipc'
import type { NotifyItem } from '@shared/notify'

type OrganizerAction = 'audit' | 'propose' | 'apply'

interface OrganizerState {
  root: string
  violations: OrganizerViolation[]
  plan: OrganizerPlan | null
  result: OrganizerApplyResult | null
  explanations: Record<string, OrganizerExplanation>
  explainingRules: Record<string, boolean>
  busy: OrganizerAction | null
  audited: boolean
  error: string | null
  setRoot(root: string): void
  audit(): Promise<void>
  propose(): Promise<void>
  explain(rule: string): Promise<void>
  apply(): Promise<void>
}

let requestSequence = 0

interface OrganizerWindow {
  morz?: {
    organizer?: OrganizerApi
    notify?: { emit(item: NotifyItem): void }
  }
}

function bridge(): OrganizerApi | null {
  const api = (window as unknown as OrganizerWindow).morz?.organizer
  return api && typeof api.audit === 'function' ? api : null
}

function message(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback
}

function notifyFailure(action: OrganizerAction | 'explain', detail: string): void {
  ;(window as unknown as OrganizerWindow).morz?.notify?.emit({
    id: `organizer-${action}-failed`,
    level: 'error',
    source: 'organizer',
    title: `Organizer ${action} failed`,
    detail
  })
}

export const useOrganizerStore = create<OrganizerState>((set, get) => ({
  root: '',
  violations: [],
  plan: null,
  result: null,
  explanations: {},
  explainingRules: {},
  busy: null,
  audited: false,
  error: null,
  setRoot: (root) => {
    if (get().busy || get().root === root) return
    requestSequence += 1
    set({ root, violations: [], plan: null, result: null, audited: false, error: null })
  },
  audit: async () => {
    const api = bridge()
    const root = get().root.trim()
    if (!root || get().busy) return
    if (!api) {
      const detail = 'Organizer bridge unavailable'
      set({ error: detail, audited: false })
      notifyFailure('audit', detail)
      return
    }
    const sequence = ++requestSequence
    set({ busy: 'audit', error: null, plan: null, result: null })
    try {
      const violations = await api.audit(root)
      if (sequence !== requestSequence || get().root.trim() !== root) return
      set({ violations, audited: true, busy: null })
    } catch (error) {
      if (sequence !== requestSequence || get().root.trim() !== root) return
      const detail = message(error, 'Unable to audit this repository')
      set({ busy: null, audited: false, error: detail })
      notifyFailure('audit', detail)
    }
  },
  propose: async () => {
    const api = bridge()
    const root = get().root.trim()
    if (!root || get().busy) return
    if (!api) {
      const detail = 'Organizer bridge unavailable'
      set({ error: detail })
      notifyFailure('propose', detail)
      return
    }
    const sequence = ++requestSequence
    set({ busy: 'propose', error: null, result: null })
    try {
      const plan = await api.propose(root)
      if (sequence !== requestSequence || get().root.trim() !== root) return
      set({ plan, busy: null })
    } catch (error) {
      if (sequence !== requestSequence || get().root.trim() !== root) return
      const detail = message(error, 'Unable to propose an Organizer plan')
      set({ busy: null, error: detail })
      notifyFailure('propose', detail)
    }
  },
  explain: async (rule) => {
    const api = bridge()
    if (get().explanations[rule] || get().explainingRules[rule]) return
    if (!api) {
      const detail = 'Organizer bridge unavailable'
      set({ error: detail })
      notifyFailure('explain', detail)
      return
    }
    set((state) => ({ explainingRules: { ...state.explainingRules, [rule]: true } }))
    try {
      const explanation = await api.explain(rule)
      set((state) => ({
        explanations: { ...state.explanations, [rule]: explanation },
        explainingRules: { ...state.explainingRules, [rule]: false }
      }))
    } catch (error) {
      const detail = message(error, `Unable to explain ${rule}`)
      set((state) => ({
        explainingRules: { ...state.explainingRules, [rule]: false },
        error: detail
      }))
      notifyFailure('explain', detail)
    }
  },
  apply: async () => {
    const api = bridge()
    const { root, plan, busy } = get()
    const trimmedRoot = root.trim()
    if (!trimmedRoot || !plan || plan.operations.length === 0 || busy) return
    if (!api) {
      const detail = 'Organizer bridge unavailable'
      set({ error: detail })
      notifyFailure('apply', detail)
      return
    }
    const sequence = ++requestSequence
    set({ busy: 'apply', error: null })
    try {
      const result = await api.apply(trimmedRoot, plan.planHash)
      if (sequence !== requestSequence || get().root.trim() !== trimmedRoot) return
      set({ result, busy: null })
    } catch (error) {
      if (sequence !== requestSequence || get().root.trim() !== trimmedRoot) return
      const detail = message(error, 'Unable to apply the Organizer plan')
      set({ busy: null, error: detail })
      notifyFailure('apply', detail)
    }
  }
}))
