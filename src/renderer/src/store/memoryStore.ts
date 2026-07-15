import { create } from 'zustand'
import type {
  MemoryEntry,
  MemoryProposal,
  MemoryScope,
  MorzMemoryApi
} from '@shared/memory'

interface MemoryState {
  scope: MemoryScope
  scopeRef: string
  entries: MemoryEntry[]
  proposals: MemoryProposal[]
  query: string
  searchResults: MemoryEntry[]
  loading: boolean
  busy: string | null
  error: string | null
  start(): void
  refresh(): Promise<void>
  setScope(scope: MemoryScope): void
  setScopeRef(scopeRef: string): void
  search(query: string): Promise<void>
  addRule(title: string, body: string): Promise<void>
  save(entry: MemoryEntry): Promise<void>
  remove(id: string): Promise<void>
  setEnabled(id: string, enabled: boolean): Promise<void>
  resolveProposal(id: string, approved: boolean): Promise<void>
}

type MemoryWindow = { morz?: { memory?: MorzMemoryApi } }
let unsubscribe: (() => void) | null = null
let refreshGeneration = 0

function bridge(): MorzMemoryApi {
  const memory = (window as unknown as MemoryWindow).morz?.memory
  if (!memory) throw new Error('Memory bridge is unavailable')
  return memory
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function slugify(value: string): string {
  return value
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 96) || 'memory-rule'
}

export const useMemoryStore = create<MemoryState>((set, get) => ({
  scope: 'global',
  scopeRef: '',
  entries: [],
  proposals: [],
  query: '',
  searchResults: [],
  loading: false,
  busy: null,
  error: null,
  start: () => {
    if (!unsubscribe) {
      try {
        unsubscribe = bridge().onChanged(() => void get().refresh())
      } catch (error) {
        set({ error: errorMessage(error) })
        return
      }
    }
    void get().refresh()
  },
  refresh: async () => {
    const generation = ++refreshGeneration
    const { scope, scopeRef, query } = get()
    set({ loading: true, error: null })
    try {
      const api = bridge()
      const [entries, proposals, searchResults] = await Promise.all([
        api.list(scope, scope === 'global' || !scopeRef.trim() ? undefined : scopeRef.trim()),
        api.proposals(),
        query.trim() ? api.search(query.trim()) : Promise.resolve([])
      ])
      if (generation !== refreshGeneration) return
      set({ entries, proposals, searchResults, loading: false })
    } catch (error) {
      if (generation === refreshGeneration) set({ loading: false, error: errorMessage(error) })
    }
  },
  setScope: (scope) => {
    set({ scope, error: null })
    void get().refresh()
  },
  setScopeRef: (scopeRef) => {
    set({ scopeRef, error: null })
  },
  search: async (query) => {
    set({ query, error: null })
    if (!query.trim()) {
      set({ searchResults: [] })
      return
    }
    try {
      const searchResults = await bridge().search(query.trim())
      if (get().query === query) set({ searchResults })
    } catch (error) {
      set({ error: errorMessage(error) })
    }
  },
  addRule: async (title, body) => {
    const cleanTitle = title.trim()
    const { scope, scopeRef } = get()
    if (!cleanTitle) {
      set({ error: 'A rule title is required.' })
      return
    }
    if (scope !== 'global' && !scopeRef.trim()) {
      set({ error: `A ${scope} reference is required.` })
      return
    }
    set({ busy: 'add', error: null })
    try {
      const api = bridge()
      const base = slugify(cleanTitle)
      const id = await api.get(base) ? `${base}-${Date.now().toString(36)}` : base
      const now = new Date().toISOString()
      await api.save({
        id,
        scope,
        scopeRef: scope === 'global' ? undefined : scopeRef.trim(),
        kind: 'rule',
        title: cleanTitle,
        body,
        origin: 'user',
        createdAt: now,
        updatedAt: now,
        enabled: true
      })
      await get().refresh()
    } catch (error) {
      set({ error: errorMessage(error) })
      throw error
    } finally {
      set({ busy: null })
    }
  },
  save: async (entry) => {
    set({ busy: `save:${entry.id}`, error: null })
    try {
      await bridge().save(entry)
      await get().refresh()
    } catch (error) {
      set({ error: errorMessage(error) })
      throw error
    } finally {
      set({ busy: null })
    }
  },
  remove: async (id) => {
    set({ busy: `remove:${id}`, error: null })
    try {
      await bridge().remove(id)
      await get().refresh()
    } catch (error) {
      set({ error: errorMessage(error) })
    } finally {
      set({ busy: null })
    }
  },
  setEnabled: async (id, enabled) => {
    set({ busy: `enabled:${id}`, error: null })
    try {
      await bridge().setEnabled(id, enabled)
      await get().refresh()
    } catch (error) {
      set({ error: errorMessage(error) })
    } finally {
      set({ busy: null })
    }
  },
  resolveProposal: async (id, approved) => {
    set({ busy: `proposal:${id}`, error: null })
    try {
      await bridge().resolveProposal(id, approved)
      await get().refresh()
    } catch (error) {
      set({ error: errorMessage(error) })
    } finally {
      set({ busy: null })
    }
  }
}))
