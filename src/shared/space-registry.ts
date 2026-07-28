/*
 * w17/context-blocks — main's view of the user's Spaces.
 *
 * Space identity lives in the renderer (spaceStore slugs, user-renamable), but
 * main needs it: `space`-scoped memory keys off the space id, while the
 * dispatcher and the adapters only ever see absolute paths. The renderer
 * publishes the id↔root pairs plus the active id so main can resolve a space
 * instead of guessing one from a worktree path.
 */

export interface SpaceRegistryEntry {
  id: string
  root: string
}

export interface SpaceRegistrySnapshot {
  spaces: SpaceRegistryEntry[]
  activeSpaceId: string | null
  /*
   * Who published, and their monotonic sequence. Main ignores an older message
   * from the SAME publisher (a lost race) while letting a reloaded renderer —
   * a new publisher — take over. Absent on the snapshot main hands back.
   */
  publisherId?: string
  generation?: number
}

export const SpaceRegistryApi = {
  publish: 'spaces:publish', // (snapshot) => Promise<SpaceRegistrySnapshot>
  testSnapshot: 'spaces:test-snapshot' // MORZ_E2E only — what main currently knows
} as const

/** window.morzSpaces — exposed by the preload. */
export interface SpaceRegistryBridge {
  publish(snapshot: SpaceRegistrySnapshot): Promise<SpaceRegistrySnapshot>
  testSnapshot?(): Promise<SpaceRegistrySnapshot>
}
