import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  IconArrowRight,
  IconBolt,
  IconBrandOpenai,
  IconChevronDown,
  IconChevronRight,
  IconClock,
  IconCode,
  IconFile,
  IconFolder,
  IconFolderOpen,
  IconGitBranch,
  IconPlus,
  IconSparkles,
  IconTerminal2
} from '@tabler/icons-react'
import type {
  FsEntry,
  OnLaunchPreference,
  SessionHistoryRecord,
  StartScreenBridge
} from '@shared/ipc'
import {
  START_MODEL_CATALOGS,
  buildStartLaunch,
  type StartModel,
  type StartSession
} from '@shared/start-screen'
import { MorzSignal, MorzWordmark } from '@/components/Brand'
import { colors } from '@/lib/tokens'
import { newPaneId, rowOf, useLayoutStore, type PaneDef } from '@/store/layoutStore'
import { useConnectionsStore } from '@/store/connectionsStore'
import { useLaneStore } from '@/store/laneStore'
import { useModeStore, type MorzMode } from '@/store/modeStore'
import {
  pickAndAddSpace,
  selectActiveSpace,
  useSpaceStore,
  type Space
} from '@/store/spaceStore'
import { useSessionsStore } from '@/store/sessionsStore'
import { useModulesStore } from '@/store/modulesStore' // w15/modules-core

const SESSION_OPTIONS: ReadonlyArray<{ value: StartSession; label: string }> = [
  { value: 'shell', label: 'Plain shell' },
  { value: 'claude', label: 'Claude' },
  { value: 'codex', label: 'Codex' },
  { value: 'agy', label: 'Antigravity' },
  { value: 'opencode', label: 'OpenCode' }
]

interface StartScreenWindow {
  morzStartScreen?: StartScreenBridge
  morzModules?: { get(): Promise<Record<string, boolean>> }
}

export interface StartScreenProps {
  preference: OnLaunchPreference
  onPreferenceChange(preference: OnLaunchPreference): Promise<void>
  onEnterShell(): void
}

function sameRoot(left: string, right: string): boolean {
  const key = (value: string): string =>
    value.replace(/[\\/]+$/, '').replace(/\\/g, '/').toLocaleLowerCase()
  return key(left) === key(right)
}

function formatSessionTime(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return 'Unknown time'
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  }).format(date)
}

function launchPanes(
  session: StartSession,
  model: StartModel,
  goal: string,
  cwd: string
): PaneDef[] {
  if (session === 'shell') {
    return ['term-1', 'term-2'].map((paneId) => ({
      paneId,
      kind: 'terminal',
      cwd,
      shell: '',
      startScreenLaunch: true,
      touched: false
    }))
  }
  const launch = buildStartLaunch(session, model, goal)
  return [
    {
      paneId: newPaneId(session),
      kind: 'terminal',
      cwd,
      shell: launch.shell ?? '',
      argv: launch.argv,
      startScreenLaunch: true,
      touched: false
    }
  ]
}

export function StartScreen({
  preference,
  onPreferenceChange,
  onEnterShell
}: StartScreenProps): JSX.Element {
  const spaces = useSpaceStore((state) => state.spaces)
  const activeSpace = useSpaceStore(selectActiveSpace)
  const activeSpaceId = useSpaceStore((state) => state.activeSpaceId)
  const unavailableRoots = useSpaceStore((state) => state.unavailableRoots)
  const gitByRoot = useSpaceStore((state) => state.gitByRoot)
  const spacesReady = useSpaceStore((state) => state.ready)
  const connections = useConnectionsStore((state) => state.connections)
  const sessionsEnabled = useModulesStore((state) => state.enabled.sessions)
  const sessions = useSessionsStore((state) => state.sessions)
  const sessionsLoading = useSessionsStore((state) => state.loading)
  const sessionsError = useSessionsStore((state) => state.error)
  const resumeAvailability = useSessionsStore((state) => state.resumeAvailability)
  const busyId = useSessionsStore((state) => state.busyId)
  const lanes = useLaneStore((state) => state.lanes)
  const [selectedSpaceId, setSelectedSpaceId] = useState(activeSpaceId ?? '')
  const [session, setSession] = useState<StartSession>('shell')
  const [model, setModel] = useState<StartModel>('inherit')
  const [autonomy, setAutonomy] = useState<MorzMode>('manual')
  const [goal, setGoal] = useState('')
  const [orchestrationEnabled, setOrchestrationEnabled] = useState(false)
  const [preferenceBusy, setPreferenceBusy] = useState(false)

  const selectedSpace =
    spaces.find((space) => space.id === selectedSpaceId) ?? activeSpace ?? spaces[0]
  const selectedRoot =
    selectedSpace && !unavailableRoots[selectedSpace.root] ? selectedSpace.root : ''

  useEffect(() => {
    void useSpaceStore.getState().initialize()
    useConnectionsStore.getState().start()
    const modules = (window as unknown as StartScreenWindow).morzModules
    void modules
      ?.get()
      .then((enabled) => setOrchestrationEnabled(enabled.orchestration === true))
      .catch(() => setOrchestrationEnabled(false))
  }, [])

  useEffect(() => {
    if (!selectedSpaceId && activeSpaceId) setSelectedSpaceId(activeSpaceId)
  }, [activeSpaceId, selectedSpaceId])

  /* w15/modules-core â€” recent sessions belong to the sessions module: with it
   * disabled the launcher must not query session history at all. */
  useEffect(() => {
    if (!sessionsEnabled) return
    void useSessionsStore.getState().refresh(selectedRoot)
  }, [selectedRoot, sessionsEnabled])

  const installed = useMemo(
    () =>
      new Map(
        connections.map((connection) => [
          connection.id,
          connection.installed
        ])
      ),
    [connections]
  )
  const launch = useMemo(() => buildStartLaunch(session, model, goal), [goal, model, session])

  const chooseSpace = useCallback(async (value: string): Promise<void> => {
    if (value === '__open__') {
      const added = await pickAndAddSpace()
      if (added) setSelectedSpaceId(added.id)
      return
    }
    useSpaceStore.getState().setActiveSpace(value)
    setSelectedSpaceId(value)
  }, [])

  const chooseSession = (value: StartSession): void => {
    setSession(value)
    setModel('inherit')
    setAutonomy(value === 'shell' ? 'manual' : 'assisted')
  }

  const open = (): void => {
    if (!selectedSpace || !selectedRoot) return
    useSpaceStore.getState().setActiveSpace(selectedSpace.id)
    useModeStore.getState().setMode(autonomy)
    useLayoutStore.getState().hydrate(
      rowOf(launchPanes(session, model, goal, selectedRoot)),
      selectedRoot
    )
    if (autonomy === 'orchestrated') window.history.replaceState(null, '', '?view=dag')
    onEnterShell()
  }

  const resume = async (record: SessionHistoryRecord): Promise<void> => {
    await useSessionsStore.getState().resume(record.id)
    const layout = useLayoutStore.getState()
    if (layout.panes.length > 0 && !useSessionsStore.getState().error) {
      layout.hydrate(layout.root, selectedRoot)
      onEnterShell()
    }
  }

  const updatePreference = async (value: OnLaunchPreference): Promise<void> => {
    setPreferenceBusy(true)
    try {
      await onPreferenceChange(value)
    } finally {
      setPreferenceBusy(false)
    }
  }

  return (
    <div
      data-testid="start-screen"
      className="flex h-full min-h-0 overflow-hidden"
      style={{
        background:
          'radial-gradient(circle at 18% 12%, rgba(203,162,90,0.09), transparent 34%), #26241E'
      }}
    >
      <main
        className="flex min-h-0 w-[58%] min-w-[580px] flex-col border-r"
        style={{ borderColor: 'var(--color-line)' }}
      >
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-10 pb-8 pt-10">
          <header className="flex items-center gap-3">
            <MorzSignal className="h-8 w-10" style={{ color: colors.quartz }} />
            <MorzWordmark className="text-[24px]" />
            <span
              className="rounded-full border px-2.5 py-1 text-[9px] font-bold uppercase tracking-[0.14em]"
              style={{ color: colors.bronzeHot, borderColor: `${colors.bronze}55` }}
            >
              Launcher
            </span>
          </header>

          <section className="mt-9" aria-labelledby="start-heading">
            <p
              className="text-[10px] font-bold uppercase tracking-[0.22em]"
              style={{ color: colors.bronzeHot }}
            >
              Start with intent
            </p>
            <h1
              id="start-heading"
              className="mt-2 text-[30px] font-bold tracking-[-0.03em]"
              style={{ fontFamily: 'var(--font-display)' }}
            >
              What do you want to do?
            </h1>
            <p
              className="mt-2 max-w-2xl text-[12px] leading-relaxed"
              style={{ color: colors.quartzDim }}
            >
              Open a clean shell, continue a session, or give one of your installed CLIs a focused
              goal.
            </p>

            <div
              className="mt-5 overflow-hidden rounded-2xl border"
              style={{
                background: 'rgba(46,43,36,0.92)',
                borderColor: 'var(--color-line-strong)'
              }}
            >
              <label className="block">
                <span className="sr-only">Goal</span>
                <textarea
                  aria-label="Goal"
                  value={goal}
                  onChange={(event) => setGoal(event.target.value)}
                  maxLength={16_000}
                  rows={4}
                  placeholder={
                    session === 'shell'
                      ? 'Optional â€” leave empty for a plain shellâ€¦'
                      : 'Describe the outcome you want from this sessionâ€¦'
                  }
                  className="block w-full resize-none bg-transparent px-5 py-4 text-[14px] leading-relaxed outline-none placeholder:text-[#EEE6D966]"
                />
              </label>

              <div
                className={`grid border-t ${session === 'shell' ? 'grid-cols-[1.2fr_1fr_1fr]' : 'grid-cols-[1.15fr_1fr_1.2fr_1fr]'}`}
                style={{ borderColor: 'var(--color-line)' }}
              >
                <PreflightSelect
                  label="Space"
                  value={selectedSpace?.id ?? ''}
                  disabled={!spacesReady}
                  onChange={(value) => void chooseSpace(value)}
                >
                  {spaces.map((space) => (
                    <option
                      key={space.id}
                      value={space.id}
                      disabled={Boolean(unavailableRoots[space.root])}
                    >
                      {space.name}
                    </option>
                  ))}
                  <option value="__open__">Open a folderâ€¦</option>
                </PreflightSelect>

                <PreflightSelect
                  label="Session"
                  value={session}
                  onChange={(value) => chooseSession(value as StartSession)}
                >
                  {SESSION_OPTIONS.map((option) => (
                    <option
                      key={option.value}
                      value={option.value}
                      disabled={
                        option.value !== 'shell' && installed.get(option.value) !== true
                      }
                    >
                      {option.label}
                      {option.value === 'shell'
                        ? ' Â· default'
                        : installed.get(option.value)
                          ? ''
                          : ' Â· unavailable'}
                    </option>
                  ))}
                </PreflightSelect>

                {session !== 'shell' && (
                  <PreflightSelect label="Model" value={model} onChange={setModel}>
                    <option value="inherit">Inherit CLI default</option>
                    {START_MODEL_CATALOGS[session].map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </PreflightSelect>
                )}

                <PreflightSelect
                  label="Autonomy"
                  value={autonomy}
                  onChange={(value) => setAutonomy(value as MorzMode)}
                >
                  <option value="manual">Manual</option>
                  <option value="assisted">Assisted</option>
                  <option value="orchestrated" disabled={!orchestrationEnabled}>
                    Orchestrated{orchestrationEnabled ? '' : ' Â· module off'}
                  </option>
                </PreflightSelect>
              </div>

              <div
                className="flex items-center gap-3 border-t px-4 py-3"
                style={{
                  borderColor: 'var(--color-line)',
                  background: 'rgba(38,36,30,0.48)'
                }}
              >
                <IconTerminal2 size={14} stroke={1.5} style={{ color: colors.bronzeHot }} />
                <div className="min-w-0 flex-1">
                  <p
                    className="text-[9px] font-bold uppercase tracking-[0.16em]"
                    style={{ color: colors.quartzFaint }}
                  >
                    Spawn transparency
                  </p>
                  <p
                    data-testid="spawn-command"
                    className="mt-0.5 truncate font-mono text-[10px]"
                    title={launch.command}
                  >
                    <span style={{ color: colors.bronzeHot }}>$</span> {launch.command}
                    {session !== 'shell' && launch.inheritsCliDefault && (
                      <span style={{ color: colors.quartzDim }}> Â· Morz adds no flag</span>
                    )}
                  </p>
                </div>
                <button
                  data-testid="start-launch"
                  type="button"
                  onClick={open}
                  disabled={
                    !selectedRoot || (session !== 'shell' && installed.get(session) !== true)
                  }
                  className="inline-flex min-h-9 items-center gap-2 rounded-lg px-4 text-[11px] font-bold transition-[filter,opacity] hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
                  style={{
                    background: `linear-gradient(180deg, ${colors.bronzeHot}, ${colors.bronze})`,
                    color: '#241c0a'
                  }}
                >
                  {session === 'shell' ? 'Open shell' : 'Launch'}
                  <IconArrowRight size={14} stroke={2} />
                </button>
              </div>
            </div>
          </section>

          <section className="mt-7" aria-labelledby="spaces-heading">
            <SectionTitle id="spaces-heading" title="Spaces" action="Live workspace state" />
            <div className="mt-2 grid grid-cols-2 gap-2">
              {spaces.map((space) => (
                <SpaceCard
                  key={space.id}
                  space={space}
                  active={space.id === selectedSpace?.id}
                  unavailable={Boolean(unavailableRoots[space.root])}
                  branch={gitByRoot[space.root]?.branch ?? null}
                  dirty={gitByRoot[space.root]?.files.length ?? 0}
                  liveAgents={
                    space.agents.length +
                    lanes.filter((lane) => sameRoot(lane.cwd, space.root)).length
                  }
                  onSelect={() => void chooseSpace(space.id)}
                />
              ))}
              <button
                type="button"
                onClick={() => void chooseSpace('__open__')}
                aria-label="Open a folder"
                className="flex min-h-[72px] items-center justify-center gap-2 rounded-xl border border-dashed text-[11px] font-semibold transition-colors hover:bg-[#37332B]"
                style={{
                  borderColor: 'var(--color-line-strong)',
                  color: colors.quartzDim
                }}
              >
                <IconPlus size={14} />
                Open a folder
              </button>
            </div>
          </section>

          <section className="mt-7" aria-labelledby="recent-heading">
            <SectionTitle
              id="recent-heading"
              title="Recent sessions"
              action={selectedSpace?.name ?? 'No space'}
            />
            <div className="mt-2 space-y-2">
              {sessionsLoading && <EmptyRow text="Reading session historyâ€¦" />}
              {!sessionsLoading && sessionsError && <EmptyRow text={sessionsError} error />}
              {!sessionsLoading && !sessionsError && sessions.length === 0 && (
                <EmptyRow text="No resumable work in this space yet." />
              )}
              {sessions.slice(0, 5).map((record) => (
                <article
                  key={record.id}
                  className="flex items-center gap-3 rounded-xl border px-3 py-2.5"
                  style={{ background: colors.panel, borderColor: 'var(--color-line)' }}
                >
                  <span
                    className="flex size-8 shrink-0 items-center justify-center rounded-lg"
                    style={{
                      background: colors.card,
                      color: record.source === 'claude' ? colors.agentClaude : colors.bronzeHot
                    }}
                  >
                    {record.source === 'claude' ? (
                      <IconSparkles size={14} />
                    ) : (
                      <IconClock size={14} />
                    )}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[11px] font-semibold">{record.title}</p>
                    <p
                      className="mt-0.5 truncate text-[9px]"
                      style={{ color: colors.quartzDim }}
                    >
                      {formatSessionTime(record.startedAt)}
                      {record.model ? ` Â· ${record.model}` : ''}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => void resume(record)}
                    disabled={busyId === record.id || resumeAvailability[record.id] !== true}
                    aria-label={`Resume ${record.title}`}
                    title={
                      resumeAvailability[record.id]
                        ? undefined
                        : 'no native CLI session recorded'
                    }
                    className="rounded-md border px-2.5 py-1.5 text-[10px] font-bold disabled:cursor-not-allowed disabled:opacity-40"
                    style={{ color: colors.bronzeHot, borderColor: `${colors.bronze}55` }}
                  >
                    Resume
                  </button>
                </article>
              ))}
            </div>
          </section>

          <footer
            className="mt-7 flex items-center gap-3 border-t pt-5"
            style={{ borderColor: 'var(--color-line)' }}
          >
            <label className="flex items-center gap-3 text-[10px]">
              <span style={{ color: colors.quartzDim }}>On launch</span>
              <select
                aria-label="On launch"
                value={preference}
                disabled={preferenceBusy}
                onChange={(event) =>
                  void updatePreference(event.target.value as OnLaunchPreference)
                }
                className="rounded-md border bg-[#2E2B24] px-2 py-1.5 text-[10px] outline-none"
                style={{ borderColor: 'var(--color-line-strong)', color: colors.quartz }}
              >
                <option value="straight-to-shell">Restore open sessions</option>
                <option value="always-start-screen">Always show start screen</option>
              </select>
            </label>
            <p
              className="ml-auto text-right text-[9px]"
              style={{ color: colors.quartzFaint }}
            >
              Open sessions always restore directly.
            </p>
          </footer>
        </div>
      </main>

      <SpaceExplorerPreview space={selectedSpace} />
    </div>
  )
}

function PreflightSelect({
  label,
  value,
  disabled,
  onChange,
  children
}: {
  label: string
  value: string
  disabled?: boolean
  onChange(value: string): void
  children: React.ReactNode
}): JSX.Element {
  return (
    <label
      className="relative min-w-0 border-r px-3 py-2 last:border-r-0"
      style={{ borderColor: 'var(--color-line)' }}
    >
      <span
        className="block text-[8px] font-bold uppercase tracking-[0.15em]"
        style={{ color: colors.quartzFaint }}
      >
        {label}
      </span>
      <select
        aria-label={label}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        className="mt-0.5 w-full appearance-none truncate bg-transparent pr-5 text-[10px] font-semibold outline-none disabled:opacity-40"
        style={{ color: colors.quartz }}
      >
        {children}
      </select>
      <IconChevronDown
        aria-hidden
        size={11}
        className="pointer-events-none absolute bottom-3 right-3"
        style={{ color: colors.quartzDim }}
      />
    </label>
  )
}

function SectionTitle({
  id,
  title,
  action
}: {
  id: string
  title: string
  action: string
}): JSX.Element {
  return (
    <div className="flex items-end gap-3">
      <h2 id={id} className="text-[11px] font-bold uppercase tracking-[0.14em]">
        {title}
      </h2>
      <span
        className="ml-auto truncate text-[9px]"
        style={{ color: colors.quartzFaint }}
      >
        {action}
      </span>
    </div>
  )
}

function SpaceCard({
  space,
  active,
  unavailable,
  branch,
  dirty,
  liveAgents,
  onSelect
}: {
  space: Space
  active: boolean
  unavailable: boolean
  branch: string | null
  dirty: number
  liveAgents: number
  onSelect(): void
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onSelect}
      disabled={unavailable}
      data-space-name={space.name}
      data-active={active}
      className="min-w-0 rounded-xl border px-3 py-2.5 text-left transition-colors hover:bg-[#37332B] disabled:cursor-not-allowed disabled:opacity-40"
      style={{
        background: active ? `${colors.bronze}12` : colors.panel,
        borderColor: active ? `${colors.bronze}66` : 'var(--color-line)'
      }}
    >
      <div className="flex items-center gap-2">
        <IconFolderOpen
          size={14}
          style={{ color: active ? colors.bronzeHot : colors.quartzDim }}
        />
        <span className="truncate text-[11px] font-semibold">{space.name}</span>
        {liveAgents > 0 && (
          <span
            className="ml-auto flex items-center gap-1 text-[8px]"
            style={{ color: colors.working }}
          >
            <span
              className="size-1.5 animate-pulse rounded-full"
              style={{ background: colors.working }}
            />
            {liveAgents}
          </span>
        )}
      </div>
      <div
        className="mt-2 flex min-w-0 items-center gap-2 font-mono text-[8px]"
        style={{ color: colors.quartzDim }}
      >
        <span className="flex min-w-0 items-center gap-1 truncate">
          <IconGitBranch size={9} />
          {branch ?? 'no branch'}
        </span>
        {dirty > 0 ? (
          <span className="ml-auto shrink-0" style={{ color: colors.warning }}>
            dirty Â· Â±{dirty}
          </span>
        ) : (
          <span className="ml-auto shrink-0" style={{ color: colors.done }}>
            clean
          </span>
        )}
      </div>
    </button>
  )
}

function EmptyRow({ text, error = false }: { text: string; error?: boolean }): JSX.Element {
  return (
    <div
      className="rounded-xl border px-3 py-4 text-center text-[10px]"
      style={{
        color: error ? colors.error : colors.quartzDim,
        borderColor: error ? `${colors.error}55` : 'var(--color-line)'
      }}
    >
      {text}
    </div>
  )
}

function SpaceExplorerPreview({ space }: { space: Space | undefined }): JSX.Element {
  const [childrenByPath, setChildrenByPath] = useState<Record<string, FsEntry[]>>({})
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [error, setError] = useState<string | null>(null)
  const root = space?.root ?? ''

  const load = useCallback(async (dir: string): Promise<void> => {
    try {
      const entries = await window.morz.fs.list(dir)
      setChildrenByPath((current) => ({ ...current, [dir]: entries }))
      setError(null)
    } catch {
      setError('This space is not available to preview.')
    }
  }, [])

  useEffect(() => {
    setChildrenByPath({})
    setExpanded(new Set())
    setError(null)
    if (root) void load(root)
  }, [load, root])

  const toggle = (path: string): void => {
    setExpanded((current) => {
      const next = new Set(current)
      if (next.has(path)) next.delete(path)
      else {
        next.add(path)
        if (!childrenByPath[path]) void load(path)
      }
      return next
    })
  }

  return (
    <aside
      className="flex min-w-0 flex-1 flex-col"
      aria-label="Explorer preview"
      role="region"
      style={{ background: 'rgba(33,31,26,0.72)' }}
    >
      <header
        className="border-b px-6 pb-4 pt-10"
        style={{ borderColor: 'var(--color-line)' }}
      >
        <div className="flex items-center gap-2">
          <IconFolder size={15} style={{ color: colors.bronzeHot }} />
          <h2 className="text-[11px] font-bold uppercase tracking-[0.14em]">
            Explorer preview
          </h2>
          <span
            className="ml-auto rounded-full border px-2 py-0.5 text-[8px] font-bold uppercase tracking-[0.12em]"
            style={{
              color: colors.quartzFaint,
              borderColor: 'var(--color-line-strong)'
            }}
          >
            Read only
          </span>
        </div>
        <p
          className="mt-2 truncate font-mono text-[9px]"
          title={root}
          style={{ color: colors.quartzDim }}
        >
          {root || 'Choose a space'}
        </p>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 font-mono text-[10px]">
        {!root && <EmptyRow text="Choose or open a project space to preview its files." />}
        {root && error && <EmptyRow text={error} error />}
        {root && !error && !childrenByPath[root] && <EmptyRow text="Reading workspaceâ€¦" />}
        {childrenByPath[root]?.map((entry) => (
          <PreviewTreeRow
            key={entry.path}
            entry={entry}
            depth={0}
            expanded={expanded}
            childrenByPath={childrenByPath}
            onToggle={toggle}
          />
        ))}
      </div>
    </aside>
  )
}

function PreviewTreeRow({
  entry,
  depth,
  expanded,
  childrenByPath,
  onToggle
}: {
  entry: FsEntry
  depth: number
  expanded: Set<string>
  childrenByPath: Record<string, FsEntry[]>
  onToggle(path: string): void
}): JSX.Element {
  const isDirectory = entry.kind === 'dir'
  const open = isDirectory && expanded.has(entry.path)
  const row = (
    <>
      {isDirectory ? (
        open ? (
          <IconChevronDown size={11} />
        ) : (
          <IconChevronRight size={11} />
        )
      ) : (
        <span className="w-[11px]" />
      )}
      {isDirectory ? (
        <IconFolder size={13} style={{ color: colors.bronze }} />
      ) : (
        <IconFile size={13} style={{ color: colors.quartzFaint }} />
      )}
      <span className="truncate">{entry.name}</span>
    </>
  )

  return (
    <div>
      {isDirectory ? (
        <button
          type="button"
          onClick={() => onToggle(entry.path)}
          className="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left hover:bg-[#37332B]"
          style={{ paddingLeft: 8 + depth * 14, color: colors.quartzDim }}
        >
          {row}
        </button>
      ) : (
        <div
          className="flex items-center gap-1.5 px-2 py-1.5"
          style={{ paddingLeft: 8 + depth * 14, color: colors.quartzDim }}
          title={entry.path}
        >
          {row}
        </div>
      )}
      {open && (
        <div>
          {childrenByPath[entry.path]?.map((child) => (
            <PreviewTreeRow
              key={child.path}
              entry={child}
              depth={depth + 1}
              expanded={expanded}
              childrenByPath={childrenByPath}
              onToggle={onToggle}
            />
          )) ?? (
            <p
              className="py-1"
              style={{ paddingLeft: 24 + depth * 14, color: colors.quartzFaint }}
            >
              â€¦
            </p>
          )}
        </div>
      )}
    </div>
  )
}

