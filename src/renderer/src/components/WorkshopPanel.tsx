import { useState } from 'react'
import { motion } from 'framer-motion'
import { IconSearch, IconStar, IconShieldCheck, IconPlus, IconTrophy } from '@tabler/icons-react'
import { colors } from '@/lib/tokens'
import { cliTint } from '@/lib/mock'
import { staggerContainer, staggerItem, springs } from '@/lib/springs'

type Category = 'recommended' | 'skills' | 'mcp' | 'plugins' | 'models'

const CATEGORIES: { id: Category; label: string }[] = [
  { id: 'recommended', label: 'Recommended' },
  { id: 'skills', label: 'Skills' },
  { id: 'mcp', label: 'MCP servers' },
  { id: 'plugins', label: 'Plugins' },
  { id: 'models', label: 'Best models' }
]

interface Addon {
  name: string
  type: 'skill' | 'mcp' | 'plugin'
  stars: string
  source: string
  why: string
  targets: ('claude' | 'codex' | 'agy' | 'opencode')[]
  official?: boolean
  recommended?: boolean
}

/* Catalog mock — real projects; stars/registry state resolve live from the
 * Official MCP Registry + GitHub + skill registries when wired (Phase 6). */
const ADDONS: Addon[] = [
  { name: 'Ponytail', type: 'skill', stars: '31k', source: 'DietrichGebert/ponytail', why: 'Your agent thinks like a lazy senior dev — ~54% less code written.', targets: ['claude', 'codex', 'opencode', 'agy'], recommended: true },
  { name: 'Figma MCP', type: 'mcp', stars: 'official', source: 'Figma', why: 'Read + generate designs straight from your Figma files.', targets: ['claude', 'codex', 'agy'], official: true, recommended: true },
  { name: 'Playwright MCP', type: 'mcp', stars: '21k', source: 'microsoft/playwright-mcp', why: 'Agents drive a real browser — click, fill, screenshot, test.', targets: ['claude', 'codex', 'opencode'], official: true, recommended: true },
  { name: 'Chrome DevTools MCP', type: 'mcp', stars: '9k', source: 'ChromeDevTools', why: 'Console, network, and DOM for debugging web apps.', targets: ['claude', 'codex'], official: true },
  { name: 'GitHub MCP', type: 'mcp', stars: 'official', source: 'GitHub', why: 'Issues, PRs, and reviews as agent tools.', targets: ['claude', 'codex', 'opencode', 'agy'], official: true, recommended: true },
  { name: 'Context7', type: 'mcp', stars: '38k', source: 'upstash/context7', why: 'Fresh, version-correct library docs injected into any prompt.', targets: ['claude', 'codex', 'opencode'] },
  { name: 'Honcho memory', type: 'mcp', stars: '4k', source: 'plastic-labs/honcho', why: 'One shared memory every agent on the team reads and writes.', targets: ['claude', 'codex', 'opencode'], recommended: true },
  { name: 'Code Time', type: 'plugin', stars: '1k', source: 'codetime.dev', why: 'Tracks your coding hours and lines across every editor.', targets: ['claude'] },
  { name: 'Superpowers', type: 'plugin', stars: '12k', source: 'claude-plugins-official', why: 'Battle-tested workflows: brainstorm → plan → TDD → review.', targets: ['claude'] },
  { name: 'Caveman', type: 'skill', stars: 'yours', source: 'local', why: 'Terse replies, zero fluff. Your own skill, shareable.', targets: ['claude', 'codex'] }
]

interface ModelRow {
  task: string
  model: string
  vendor: string
  metric: string
  cli: 'claude' | 'codex' | 'agy' | 'opencode'
}

/* Vendor-published benchmark leaders per task — refreshed automatically when wired. */
const MODELS: ModelRow[] = [
  { task: 'Deep coding / build', model: 'Fable 5', vendor: 'Anthropic', metric: 'SWE-bench Verified — top score', cli: 'claude' },
  { task: 'Code review / refute', model: 'GPT-5.6', vendor: 'OpenAI', metric: 'SWE-bench + long-context audit', cli: 'codex' },
  { task: 'Math & design', model: 'Gemini 3.1 Pro', vendor: 'Google', metric: 'AIME / MMMU leader', cli: 'agy' },
  { task: 'Cheap fan-out workers', model: 'Haiku 4.5', vendor: 'Anthropic', metric: 'best cost per solved task', cli: 'claude' },
  { task: 'Long agent sessions', model: 'Opus 4.8 (1M)', vendor: 'Anthropic', metric: '1M-token context window', cli: 'claude' }
]

const TYPE_COLOR: Record<Addon['type'], string> = {
  skill: '#77C9A4',
  mcp: '#7FA6F0',
  plugin: '#C09AE6'
}

/*
 * Workshop — the "additions" surface. Curated catalog of skills, MCP servers,
 * plugins, and per-task model picks. One click installs into the CLIs you
 * choose (Morz writes each CLI's config; every add shows a diff first).
 */
export function WorkshopPanel(): JSX.Element {
  const [category, setCategory] = useState<Category>('recommended')

  const items =
    category === 'recommended'
      ? ADDONS.filter((a) => a.recommended)
      : ADDONS.filter((a) => (category === 'skills' ? a.type === 'skill' : category === 'mcp' ? a.type === 'mcp' : a.type === 'plugin'))

  return (
    <section className="flex min-w-0 flex-1 flex-col" style={{ background: colors.page }} aria-label="Workshop">
      {/* header */}
      <div className="flex items-center gap-3 border-b px-4 py-2.5" style={{ borderColor: 'var(--color-line)' }}>
        <span className="text-sm font-bold" style={{ fontFamily: 'var(--font-display)' }}>
          Workshop
        </span>
        <span className="text-[10.5px]" style={{ color: colors.quartzDim }}>
          add skills, MCP servers, plugins, and models to your CLIs — no config editing
        </span>
        <div
          className="ml-auto flex w-[240px] items-center gap-2 rounded-[10px] border px-3 py-1.5 text-[11px]"
          style={{ background: colors.panel, borderColor: 'var(--color-line-strong)', color: colors.quartzDim }}
        >
          <IconSearch size={13} stroke={1.5} />
          Search the catalog…
        </div>
      </div>

      <div className="flex min-h-0 flex-1">
        {/* categories */}
        <nav className="w-[180px] shrink-0 border-r p-2.5" style={{ borderColor: 'var(--color-line)' }}>
          {CATEGORIES.map((c) => {
            const active = category === c.id
            return (
              <button
                key={c.id}
                onClick={() => setCategory(c.id)}
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
                <span className="relative">{c.label}</span>
              </button>
            )
          })}
          <p className="mt-4 px-2.5 text-[9.5px] leading-relaxed" style={{ color: colors.quartzDim }}>
            Sources: Official MCP Registry, GitHub stars, Agent Skills registry. Every add shows the exact config
            change before it lands.
          </p>
        </nav>

        {/* content */}
        {category !== 'models' ? (
          <motion.div
            key={category}
            variants={staggerContainer}
            initial="hidden"
            animate="show"
            className="grid min-w-0 flex-1 auto-rows-min grid-cols-2 gap-2.5 overflow-y-auto p-3.5"
          >
            {items.map((addon) => (
              <motion.article
                key={addon.name}
                variants={staggerItem}
                className="rounded-xl border p-3"
                style={{ background: colors.panel, borderColor: 'var(--color-line)' }}
              >
                <div className="flex items-center gap-2">
                  <span className="text-xs font-bold" style={{ fontFamily: 'var(--font-display)' }}>
                    {addon.name}
                  </span>
                  <span
                    className="rounded-md px-1.5 py-px text-[8.5px] font-bold uppercase"
                    style={{ background: `${TYPE_COLOR[addon.type]}1f`, color: TYPE_COLOR[addon.type] }}
                  >
                    {addon.type}
                  </span>
                  {addon.official && (
                    <span title="Official / verified publisher">
                      <IconShieldCheck size={12} stroke={1.5} style={{ color: colors.bronzeHot }} />
                    </span>
                  )}
                  <span className="ml-auto flex items-center gap-1 text-[10px]" style={{ color: colors.quartzDim }}>
                    <IconStar size={10} stroke={1.5} />
                    {addon.stars}
                  </span>
                </div>
                <p className="mt-0.5 font-mono text-[9.5px]" style={{ color: colors.quartzDim }}>
                  {addon.source}
                </p>
                <p className="mt-1.5 text-[11px] leading-snug" style={{ color: colors.quartzDim }}>
                  {addon.why}
                </p>
                <div className="mt-2.5 flex items-center gap-1">
                  {addon.targets.map((t) => (
                    <span
                      key={t}
                      className="size-1.5 rounded-full"
                      style={{ background: cliTint[t] }}
                      title={`installs into ${t === 'agy' ? 'Antigravity' : t}`}
                    />
                  ))}
                  <span className="text-[9px]" style={{ color: colors.quartzDim }}>
                    {addon.targets.length} CLIs
                  </span>
                  <motion.button
                    whileHover={{ scale: 1.03 }}
                    transition={springs.snappy}
                    className="ml-auto flex cursor-pointer items-center gap-1 rounded-lg px-2.5 py-1 text-[10.5px] font-bold"
                    style={{
                      background: `linear-gradient(180deg, ${colors.bronzeHot}, ${colors.bronze})`,
                      color: '#241c0a',
                      fontFamily: 'var(--font-display)'
                    }}
                  >
                    <IconPlus size={11} stroke={2.5} />
                    Add
                  </motion.button>
                </div>
              </motion.article>
            ))}
          </motion.div>
        ) : (
          <div className="min-w-0 flex-1 overflow-y-auto p-3.5">
            <div className="mb-2 flex items-center gap-2 text-[11px]" style={{ color: colors.quartzDim }}>
              <IconTrophy size={13} stroke={1.5} style={{ color: colors.bronzeHot }} />
              Best model per task — vendor-published benchmarks, updated as new models ship.
            </div>
            <motion.div variants={staggerContainer} initial="hidden" animate="show" className="space-y-1.5">
              {MODELS.map((m) => (
                <motion.div
                  key={m.task}
                  variants={staggerItem}
                  className="flex items-center gap-3 rounded-xl border px-3.5 py-2.5"
                  style={{ background: colors.panel, borderColor: 'var(--color-line)' }}
                >
                  <span className="w-[170px] shrink-0 text-[11px]" style={{ color: colors.quartzDim }}>
                    {m.task}
                  </span>
                  <span className="size-1.5 rounded-full" style={{ background: cliTint[m.cli] }} />
                  <span className="text-xs font-bold" style={{ fontFamily: 'var(--font-display)' }}>
                    {m.model}
                  </span>
                  <span className="text-[10px]" style={{ color: colors.quartzDim }}>
                    {m.vendor}
                  </span>
                  <span className="ml-auto text-[10px]" style={{ color: colors.quartzDim }}>
                    {m.metric}
                  </span>
                  <button
                    className="cursor-pointer rounded-lg border px-2.5 py-1 text-[10px] font-semibold"
                    style={{ borderColor: 'var(--color-line-strong)', color: colors.bronzeHot }}
                  >
                    Use in routing
                  </button>
                </motion.div>
              ))}
            </motion.div>
          </div>
        )}
      </div>
    </section>
  )
}
