import { useEffect, useMemo, useState } from 'react'
import { motion } from 'framer-motion'
import {
  IconAlertCircle,
  IconCloudOff,
  IconDatabase,
  IconPlus,
  IconRefresh,
  IconSearch,
  IconShieldCheck,
  IconStar,
  IconTrophy
} from '@tabler/icons-react'
import type {
  CatalogCategory,
  CatalogInstallSpec,
  CatalogItem,
  CatalogTargetCli,
  MorzApi
} from '@shared/ipc'
import { colors } from '@/lib/tokens'
import { cliTint } from '@/lib/mock'
import { staggerContainer, staggerItem, springs } from '@/lib/springs'
import { useCatalogStore } from '@/store/catalogStore'

const CATEGORIES: { id: CatalogCategory; label: string }[] = [
  { id: 'recommended', label: 'Recommended' },
  { id: 'skills', label: 'Skills' },
  { id: 'mcp', label: 'MCP servers' },
  { id: 'plugins', label: 'Plugins' },
  { id: 'models', label: 'Best models' }
]

const TARGET_CLIS: CatalogTargetCli[] = ['claude', 'codex', 'agy', 'opencode']

const TYPE_COLOR: Record<CatalogItem['kind'], string> = {
  skill: '#77C9A4',
  mcp: '#7FA6F0',
  plugin: '#C09AE6',
  model: '#E4BC77'
}

interface ConfigWriterBridge {
  propose(installSpec: CatalogInstallSpec, targetClis: CatalogTargetCli[]): Promise<unknown>
}

function configWriter(): ConfigWriterBridge | null {
  const morz = (window as unknown as {
    morz?: Partial<MorzApi> & { configWriter?: ConfigWriterBridge }
  }).morz
  return morz?.configWriter && typeof morz.configWriter.propose === 'function'
    ? morz.configWriter
    : null
}

function formatStars(stars: number | null): string {
  if (stars === null) return '—'
  if (stars >= 1_000_000) return `${(stars / 1_000_000).toFixed(1).replace(/\.0$/, '')}m`
  if (stars >= 1_000) return `${(stars / 1_000).toFixed(1).replace(/\.0$/, '')}k`
  return String(stars)
}

function formatSyncTime(timestamp: number | null): string {
  if (!timestamp) return 'not synced yet'
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  }).format(timestamp)
}

function sourceLabel(item: CatalogItem): JSX.Element {
  const label = <span className="truncate">{item.source}</span>
  let safeUrl: string | null = null
  try {
    const parsed = item.sourceUrl ? new URL(item.sourceUrl) : null
    safeUrl = parsed?.protocol === 'https:' ? parsed.toString() : null
  } catch {
    safeUrl = null
  }
  if (!safeUrl) return label
  return (
    <a
      href={safeUrl}
      target="_blank"
      rel="noopener noreferrer"
      className="truncate hover:underline"
      title={safeUrl}
    >
      {item.source}
    </a>
  )
}

function CatalogCard({ item }: { item: CatalogItem }): JSX.Element {
  const [adding, setAdding] = useState(false)
  const [addError, setAddError] = useState<string | null>(null)
  const writer = configWriter()
  const disabledReason = !writer
    ? 'config writer pending'
    : !item.installSpec
      ? 'No compatible install spec'
      : undefined

  const add = async (): Promise<void> => {
    if (!writer || !item.installSpec || adding) return
    setAdding(true)
    setAddError(null)
    try {
      await writer.propose(item.installSpec, TARGET_CLIS)
    } catch (error) {
      setAddError(error instanceof Error ? error.message : 'Unable to propose config change')
    } finally {
      setAdding(false)
    }
  }

  return (
    <motion.article
      variants={staggerItem}
      className="group rounded-xl border p-3 transition-colors hover:bg-[#37332B]"
      style={{ background: colors.panel, borderColor: 'var(--color-line)' }}
    >
      <div className="flex min-w-0 items-center gap-2">
        <h2
          className="truncate text-xs font-bold"
          style={{ fontFamily: 'var(--font-display)' }}
          title={item.name}
        >
          {item.name}
        </h2>
        <span
          className="shrink-0 rounded-md px-1.5 py-px text-[8.5px] font-bold uppercase"
          style={{ background: `${TYPE_COLOR[item.kind]}1f`, color: TYPE_COLOR[item.kind] }}
        >
          {item.kind}
        </span>
        {item.official && (
          <span title="Official MCP Registry entry">
            <IconShieldCheck size={12} stroke={1.5} style={{ color: colors.bronzeHot }} />
          </span>
        )}
        <span
          className="ml-auto flex shrink-0 items-center gap-1 text-[10px] tabular-nums"
          style={{ color: item.stars === null ? colors.quartzDim : colors.quartz }}
          title={item.stars === null ? 'GitHub stars unavailable' : `${item.stars.toLocaleString()} GitHub stars`}
        >
          <IconStar size={10} stroke={1.5} />
          {formatStars(item.stars)}
        </span>
      </div>
      <div className="mt-0.5 flex min-w-0 items-center gap-1 font-mono text-[9.5px]" style={{ color: colors.quartzDim }}>
        {sourceLabel(item)}
      </div>
      <p className="mt-1.5 line-clamp-3 text-[11px] leading-snug" style={{ color: colors.quartzDim }}>
        {item.description}
      </p>
      <div className="mt-2.5 flex items-center gap-1">
        {TARGET_CLIS.map((target) => (
          <span
            key={target}
            className="size-1.5 rounded-full"
            style={{ background: cliTint[target] }}
            title={`installs into ${target === 'agy' ? 'Antigravity' : target}`}
          />
        ))}
        <span className="text-[9px]" style={{ color: colors.quartzDim }}>
          4 CLIs
        </span>
        {addError && (
          <span className="ml-1 truncate text-[9px]" style={{ color: colors.error }} title={addError}>
            {addError}
          </span>
        )}
        <motion.button
          whileHover={disabledReason ? undefined : { scale: 1.02 }}
          transition={springs.snappy}
          type="button"
          disabled={Boolean(disabledReason) || adding}
          title={disabledReason}
          aria-label={`Add ${item.name}`}
          onClick={() => void add()}
          className="ml-auto flex items-center gap-1 rounded-lg px-2.5 py-1 text-[10.5px] font-bold disabled:cursor-not-allowed disabled:opacity-40"
          style={{
            background: `linear-gradient(180deg, ${colors.bronzeHot}, ${colors.bronze})`,
            color: '#241c0a',
            fontFamily: 'var(--font-display)'
          }}
        >
          <IconPlus size={11} stroke={2.5} />
          {adding ? 'Adding…' : 'Add'}
        </motion.button>
      </div>
    </motion.article>
  )
}

function ModelRow({ item }: { item: CatalogItem }): JSX.Element {
  const context = item.contextLength
    ? `${Math.round(item.contextLength / 1_000).toLocaleString()}k context`
    : null
  return (
    <motion.article
      variants={staggerItem}
      className="flex items-center gap-3 rounded-xl border px-3.5 py-2.5"
      style={{ background: colors.panel, borderColor: 'var(--color-line)' }}
    >
      <span className="flex size-7 shrink-0 items-center justify-center rounded-lg" style={{ background: `${colors.bronze}18` }}>
        <IconTrophy size={13} stroke={1.5} style={{ color: colors.bronzeHot }} />
      </span>
      <div className="min-w-0 flex-1">
        <h2 className="truncate text-xs font-bold" style={{ fontFamily: 'var(--font-display)' }}>
          {item.name}
        </h2>
        <p className="mt-0.5 truncate text-[9.5px]" style={{ color: colors.quartzDim }}>
          {item.source}
          {context ? ` · ${context}` : ''}
        </p>
      </div>
      <div className="max-w-[42%] shrink-0 text-right">
        <p className="truncate text-[10px]" style={{ color: item.benchmarkLabel ? colors.bronzeHot : colors.quartzDim }}>
          {item.benchmarkLabel ?? 'Benchmark data pending'}
        </p>
        {item.benchmarkScore !== null && item.benchmarkScore !== undefined && (
          <p className="mt-0.5 font-mono text-[9px]" style={{ color: colors.quartzDim }}>
            composite {item.benchmarkScore.toFixed(1)}
          </p>
        )}
      </div>
    </motion.article>
  )
}

export function WorkshopPanel(): JSX.Element {
  const {
    items,
    category,
    search,
    lastSyncAt,
    offline,
    syncing,
    loading,
    error,
    setCategory,
    setSearch,
    query,
    refresh,
    start
  } = useCatalogStore()

  useEffect(() => start(), [start])

  useEffect(() => {
    const timer = window.setTimeout(() => void query(), 180)
    return () => window.clearTimeout(timer)
  }, [category, query, search])

  const emptyCopy = useMemo(() => {
    if (search) return `No ${CATEGORIES.find((entry) => entry.id === category)?.label.toLowerCase()} match “${search}”.`
    if (category === 'skills') return 'No live skill source is connected yet.'
    if (category === 'plugins') return 'No live plugin source is connected yet.'
    return offline ? 'No cached entries are available yet. Reconnect and refresh.' : 'Catalog sync is still warming up.'
  }, [category, offline, search])

  return (
    <section className="flex min-w-0 flex-1 flex-col" style={{ background: colors.page }} aria-label="Workshop">
      <div className="flex items-center gap-3 border-b px-4 py-2.5" style={{ borderColor: 'var(--color-line)' }}>
        <span className="text-sm font-bold" style={{ fontFamily: 'var(--font-display)' }}>
          Workshop
        </span>
        <span className="hidden text-[10.5px] lg:inline" style={{ color: colors.quartzDim }}>
          live tools and models for your CLIs — cached for offline use
        </span>
        <label
          className="ml-auto flex w-[260px] items-center gap-2 rounded-[10px] border px-3 py-1.5 text-[11px] focus-within:border-[#CBA25A]"
          style={{ background: colors.panel, borderColor: 'var(--color-line-strong)', color: colors.quartzDim }}
        >
          <IconSearch size={13} stroke={1.5} />
          <input
            type="search"
            aria-label="Search catalog"
            placeholder="Search the catalog…"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            className="min-w-0 flex-1 bg-transparent text-[11px] outline-none placeholder:text-[#8f887b]"
            style={{ color: colors.quartz }}
          />
        </label>
      </div>

      <div
        className="flex min-h-8 items-center gap-2 border-b px-4 py-1.5 text-[9.5px]"
        style={{ borderColor: 'var(--color-line)', color: colors.quartzDim, background: colors.panel }}
      >
        <IconDatabase size={11} stroke={1.5} />
        <span>Last sync: {formatSyncTime(lastSyncAt)}</span>
        {offline && (
          <span
            className="flex items-center gap-1 rounded-full border px-2 py-0.5 font-semibold"
            style={{ borderColor: `${colors.warning}66`, color: colors.warning, background: `${colors.warning}12` }}
            title={error ?? 'Using the cached catalog'}
          >
            <IconCloudOff size={10} stroke={1.8} />
            offline
          </span>
        )}
        {!offline && error && (
          <span className="flex items-center gap-1" style={{ color: colors.warning }} title={error}>
            <IconAlertCircle size={10} /> enrichment limited
          </span>
        )}
        <button
          type="button"
          aria-label="Refresh catalog"
          disabled={syncing}
          onClick={() => void refresh()}
          className="ml-auto flex items-center gap-1 rounded-md border px-2 py-0.5 font-semibold disabled:cursor-wait disabled:opacity-60"
          style={{ borderColor: 'var(--color-line-strong)', color: colors.bronzeHot }}
        >
          <motion.span animate={syncing ? { rotate: 360 } : { rotate: 0 }} transition={syncing ? { duration: 1, repeat: Infinity, ease: 'linear' } : undefined}>
            <IconRefresh size={10} stroke={1.8} />
          </motion.span>
          {syncing ? 'Syncing' : 'Refresh'}
        </button>
      </div>

      <div className="flex min-h-0 flex-1">
        <nav className="w-[180px] shrink-0 border-r p-2.5" style={{ borderColor: 'var(--color-line)' }} aria-label="Workshop categories">
          {CATEGORIES.map((entry) => {
            const active = category === entry.id
            return (
              <button
                key={entry.id}
                type="button"
                onClick={() => setCategory(entry.id)}
                className="relative mb-0.5 flex w-full cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[11.5px]"
                style={{ color: active ? colors.quartz : colors.quartzDim, fontFamily: 'var(--font-display)' }}
              >
                {active && (
                  <motion.span
                    layoutId="workshop-cat"
                    transition={springs.layout}
                    className="absolute inset-0 rounded-lg border"
                    style={{ background: colors.card, borderColor: 'var(--color-line-strong)' }}
                  />
                )}
                <span className="relative">{entry.label}</span>
              </button>
            )
          })}
          <p className="mt-4 px-2.5 text-[9.5px] leading-relaxed" style={{ color: colors.quartzDim }}>
            Official MCP Registry, GitHub stars, and OpenRouter benchmarks. Refreshes are incremental after the first sync.
          </p>
        </nav>

        <div className="relative min-w-0 flex-1 overflow-y-auto p-3.5">
          {category === 'models' && items.length > 0 && (
            <div className="mb-2 flex items-center gap-2 text-[11px]" style={{ color: colors.quartzDim }}>
              <IconTrophy size={13} stroke={1.5} style={{ color: colors.bronzeHot }} />
              {items.some((item) => item.benchmarkScore !== null && item.benchmarkScore !== undefined)
                ? 'Best available models ranked by published benchmark fields.'
                : 'OpenRouter models; benchmark data is not currently available.'}
            </div>
          )}
          {items.length > 0 ? (
            <motion.div
              key={`${category}:${search}`}
              variants={staggerContainer}
              initial="hidden"
              animate="show"
              className={category === 'models' ? 'space-y-1.5' : 'grid auto-rows-min grid-cols-1 gap-2.5 xl:grid-cols-2'}
            >
              {items.map((item) =>
                category === 'models' ? <ModelRow key={item.id} item={item} /> : <CatalogCard key={item.id} item={item} />
              )}
            </motion.div>
          ) : (
            <div className="flex min-h-[220px] items-center justify-center px-8 text-center text-[11px]" style={{ color: colors.quartzDim }}>
              {loading ? 'Loading cached catalog…' : emptyCopy}
            </div>
          )}
        </div>
      </div>
    </section>
  )
}
