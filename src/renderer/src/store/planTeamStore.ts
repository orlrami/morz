/*
 * w14/multi-agent-plan — remembered per-role model defaults for the team card.
 * When the user swaps a planned agent's cli, remember the choice keyed by the
 * role's leading word ("builder", "architect", "math") so the next plan
 * pre-fills the model that role ran on last. localStorage-persisted map;
 * empty until the user makes a choice, so planner output wins by default.
 */
import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { PlannedCli } from '@shared/spawn-plan'

const STORAGE_KEY = 'morz.plan-team-defaults'

/** "Builder: PTY host" → "builder"; "Math/rotation specialist" → "math". */
export function roleKey(role: string): string {
  const match = role.toLowerCase().match(/[a-z]+/)
  return match ? match[0] : 'agent'
}

interface PlanTeamState {
  defaults: Record<string, PlannedCli>
  remember(role: string, cli: PlannedCli): void
  defaultFor(role: string): PlannedCli | null
}

export const usePlanTeamStore = create<PlanTeamState>()(
  persist(
    (set, get) => ({
      defaults: {},
      remember: (role, cli) =>
        set((state) => ({ defaults: { ...state.defaults, [roleKey(role)]: cli } })),
      defaultFor: (role) => get().defaults[roleKey(role)] ?? null
    }),
    { name: STORAGE_KEY, version: 1 }
  )
)
