import { create } from 'zustand'
import type {
  CatalogCategory,
  CatalogItem,
  CatalogQuery,
  CatalogSnapshot,
  CatalogSourceStatus,
  MorzApi
} from '@shared/ipc'

interface CatalogState {
  items: CatalogItem[]
  category: CatalogCategory
  search: string
  lastSyncAt: number | null
  offline: boolean
  syncing: boolean
  loading: boolean
  error: string | null
  sources: CatalogSourceStatus[]
  setCategory(category: CatalogCategory): void
  setSearch(search: string): void
  query(): Promise<void>
  refresh(): Promise<void>
  start(): void
}

let started = false
let requestSequence = 0

function catalogApi(): NonNullable<MorzApi['catalog']> | null {
  const morz = (window as unknown as { morz?: Partial<MorzApi> }).morz
  return morz?.catalog && typeof morz.catalog.query === 'function' ? morz.catalog : null
}

function snapshotState(snapshot: CatalogSnapshot): Pick<
  CatalogState,
  'items' | 'lastSyncAt' | 'offline' | 'syncing' | 'error' | 'sources'
> {
  return {
    items: snapshot.items,
    lastSyncAt: snapshot.lastSyncAt,
    offline: snapshot.offline,
    syncing: snapshot.syncing,
    error: snapshot.error,
    sources: Array.isArray(snapshot.sources) ? snapshot.sources : []
  }
}

export const useCatalogStore = create<CatalogState>((set, get) => ({
  items: [],
  category: 'recommended',
  search: '',
  lastSyncAt: null,
  offline: false,
  syncing: false,
  loading: false,
  error: null,
  sources: [],
  setCategory: (category) => set({ category }),
  setSearch: (search) => set({ search }),
  query: async () => {
    const api = catalogApi()
    if (!api) {
      set({ loading: false, error: 'Catalog bridge unavailable' })
      return
    }
    const sequence = ++requestSequence
    const query: CatalogQuery = {
      category: get().category,
      search: get().search,
      limit: 200
    }
    set({ loading: true })
    try {
      const snapshot = await api.query(query)
      if (sequence !== requestSequence) return
      set({ ...snapshotState(snapshot), loading: false })
    } catch (error) {
      if (sequence !== requestSequence) return
      set({
        loading: false,
        offline: true,
        error: error instanceof Error ? error.message : 'Unable to load cached catalog'
      })
    }
  },
  refresh: async () => {
    const api = catalogApi()
    if (!api) {
      set({ error: 'Catalog bridge unavailable' })
      return
    }
    const query: CatalogQuery = {
      category: get().category,
      search: get().search,
      limit: 200
    }
    set({ syncing: true })
    try {
      const snapshot = await api.refresh(query)
      set({
        lastSyncAt: snapshot.lastSyncAt,
        offline: snapshot.offline,
        syncing: snapshot.syncing,
        loading: false,
        error: snapshot.error,
        sources: Array.isArray(snapshot.sources) ? snapshot.sources : []
      })
      await get().query()
    } catch (error) {
      set({
        syncing: false,
        offline: true,
        error: error instanceof Error ? error.message : 'Catalog refresh failed'
      })
      await get().query()
    }
  },
  start: () => {
    if (started) return
    started = true
    catalogApi()?.onUpdated?.(() => {
      void get().query()
    })
    void get().query().finally(() => {
      void get().refresh()
    })
  }
}))
