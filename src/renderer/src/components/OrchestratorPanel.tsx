import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { IconClipboardList, IconFlask, IconHandStop, IconSparkles } from '@tabler/icons-react'
import type { Message, Part, Task, TaskState } from '@shared/bus'
import type {
  PlannerBridge,
  PlannerClaudeModel,
  PlannerEngine,
  PlannerEngineBridge,
  PlanTeamOptions, // w14/multi-agent-plan
  StoredPlanAmendment,
  StoredSpawnPlan
} from '@shared/ipc'
import { colors } from '@/lib/tokens'
import { staggerContainer, staggerItem } from '@/lib/springs'
import { useModeStore } from '@/store/modeStore'
import { useBusStore, getBus } from '@/store/busStore'
import { useLaneStore } from '@/store/laneStore'
import { selectActiveSpace, selectActiveSpaceRoot, useSpaceStore } from '@/store/spaceStore'
import { AgentPillBar } from './AgentPillBar'
import { ApprovalChip } from './ApprovalChip'
import { AmendmentCard, PlanCard } from './PlanCard'
import { RunsPanel } from './RunsPanel'
import { MorzSignal } from './Brand'

/*
 * Orchestrator side panel = the live blackboard (0.0.2, w4/handoff).
 * Tasks by state, messages per task, artifacts — fed by bus:changed pushes.
 * Assisted: every dispatch surfaces an ApprovalChip first. Manual: inert —
 * nothing below the gate mounts, so no bus IPC ever fires (like ClaudeLane).
 */

/** TaskState → status color (design tokens); unknown future states dim out. */
const stateColor: Record<TaskState, string> = {
  proposed: colors.quartzDim,
  accepted: colors.bronze,
  working: colors.working,
  blocked: colors.blocked,
  done: colors.done
}

const STATE_ORDER: TaskState[] = ['working', 'blocked', 'accepted', 'proposed', 'done']

export function OrchestratorPanel(): JSX.Element {
  const mode = useModeStore((s) => s.mode)
  return (
    <aside
      className="flex w-[330px] shrink-0 flex-col overflow-hidden border-l"
      style={{ background: colors.panel, borderColor: 'var(--color-line)' }}
      aria-label="Orchestrator"
    >
      {mode === 'manual' ? <ManualNotice /> : <LiveBlackboard showPlanner />}{/* w8/routing */}
    </aside>
  )
}

function ManualNotice(): JSX.Element {
  return (
    <>
      <Header subtitle="off" />
      <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
        <IconHandStop size={22} stroke={1.5} style={{ color: colors.quartzDim }} />
        <p className="text-xs font-semibold" style={{ color: colors.quartz, fontFamily: 'var(--font-display)' }}>
          Manual mode — blackboard off
        </p>
        <p className="max-w-[240px] text-[11px]" style={{ color: colors.quartzDim }}>
          No handoff machinery runs. Switch the dial to Assisted; every dispatch will ask you
          first.
        </p>
      </div>
    </>
  )
}

function Header({ subtitle, spaceName }: { subtitle: string; spaceName?: string }): JSX.Element {
  return (
    <div className="flex items-center gap-2 border-b px-3.5 py-2.5" style={{ borderColor: 'var(--color-line)' }}>
      {/* w10/identity — carry the canonical Signal into the system header. */}
      <MorzSignal className="h-4 w-[22px]" goldPoint style={{ color: colors.quartz }} />
      <span className="text-[13px] font-bold" style={{ fontFamily: 'var(--font-display)' }}>
        Orchestrator
      </span>
      {/* w14/orch-scoped — the panel is scoped to the active space; show it */}
      {spaceName && (
        <span
          className="max-w-[90px] truncate rounded px-1.5 py-px text-[9px] font-semibold"
          style={{ background: colors.card, color: colors.bronze }}
          data-testid="orchestrator-space"
          title={spaceName}
        >
          {spaceName}
        </span>
      )}
      <span className="ml-auto text-[10px]" style={{ color: colors.quartzDim }}>
        {subtitle}
      </span>
    </div>
  )
}

/* All bus access lives below this line, unmounted in Manual. */
function LiveBlackboard({ showPlanner }: { showPlanner: boolean }): JSX.Element {
  const [section, setSection] = useState<'blackboard' | 'runs'>('blackboard')
  const { tasks, messages, approvals, live, start, respondApproval, simulateHandoff } =
    useBusStore()
  const lanes = useLaneStore((s) => s.lanes)
  // w14/orch-scoped — the whole panel follows the active space (busStore and
  // runsStore re-scope themselves on space change; plans re-fetch below).
  const activeSpaceName = useSpaceStore((s) => selectActiveSpace(s)?.name)

  useEffect(() => {
    start()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const working = tasks.filter((t) => t.state === 'working').length
  const blocked = tasks.filter((t) => t.state === 'blocked').length
  const subtitle = live
    ? `${tasks.length} task${tasks.length === 1 ? '' : 's'} · ${working} working · ${blocked} blocked`
    : getBus()
      ? 'connecting…'
      : 'bus offline'

  const sorted = [...tasks].sort((a, b) => {
    const so = STATE_ORDER.indexOf(a.state) - STATE_ORDER.indexOf(b.state)
    return so !== 0 ? so : b.updatedAt.localeCompare(a.updatedAt)
  })

  return (
    <>
      <Header subtitle={section === 'runs' ? 'live runs' : subtitle} spaceName={activeSpaceName} />

      {/* w15/shell-layout — live agents live in the dock now (pill bar moved
       * here from the old strip under the titlebar; statusbar keeps the count) */}
      <AgentPillBar />

      <div
        className="grid grid-cols-2 border-b p-1"
        style={{ borderColor: 'var(--color-line)' }}
        role="tablist"
        aria-label="Orchestrator views"
      >
        {(['blackboard', 'runs'] as const).map((item) => {
          const active = section === item
          const label = item === 'blackboard' ? 'Blackboard' : 'Runs'
          return (
            <button
              key={item}
              type="button"
              role="tab"
              aria-selected={active}
              aria-controls={`orchestrator-${item}`}
              onClick={() => setSection(item)}
              className="rounded-md px-2 py-1 text-[10px] font-semibold"
              style={{
                background: active ? colors.card : 'transparent',
                color: active ? colors.quartz : colors.quartzDim
              }}
            >
              {label}
            </button>
          )
        })}
      </div>

      {section === 'runs' && (
        <div id="orchestrator-runs" role="tabpanel" className="flex min-h-0 flex-1">
          <RunsPanel />
        </div>
      )}

      {section === 'blackboard' && (
        <div id="orchestrator-blackboard" role="tabpanel" className="flex min-h-0 flex-1 flex-col">
      {showPlanner && <PlannerFlow />}

      {/* pending approvals — the Assisted propose-then-approve gate */}
      <AnimatePresence>
        {approvals.length > 0 && (
          <motion.div
            layout
            className="space-y-2 border-b p-3"
            style={{ borderColor: 'var(--color-line)' }}
          >
            <AnimatePresence>
              {approvals.map((a) => (
                <ApprovalChip key={a.requestId} approval={a} onRespond={respondApproval} />
              ))}
            </AnimatePresence>
          </motion.div>
        )}
      </AnimatePresence>

      {/* task board */}
      <motion.div
        variants={staggerContainer}
        initial="hidden"
        animate="show"
        className="flex flex-1 flex-col gap-2 overflow-y-auto p-3"
      >
        {sorted.length === 0 && (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 text-center">
            <IconClipboardList size={20} stroke={1.5} style={{ color: colors.quartzDim }} />
            {/* w14/orch-scoped — a fresh space opens clean */}
            <p className="max-w-[220px] text-[11px]" style={{ color: colors.quartzDim }}>
              No orchestration in this space yet — when a lane hands work off here, the task and
              its approval chip land on this blackboard.
            </p>
          </div>
        )}
        {sorted.map((task) => (
          <TaskCard key={task.id} task={task} messages={messages} />
        ))}
      </motion.div>

      {/* dev command: simulate lane A posting a handoff (stub bus) */}
      {import.meta.env.DEV && (
        <div className="border-t p-2.5" style={{ borderColor: 'var(--color-line)' }}>
          <button
            onClick={() => simulateHandoff(lanes[0]?.agentId ?? 'claude-lane-b')}
            className="flex w-full cursor-pointer items-center justify-center gap-1.5 rounded-md border px-2.5 py-1.5 text-[11px]"
            style={{ borderColor: 'var(--color-line-strong)', color: colors.quartzDim }}
            data-testid="dev-simulate-handoff"
          >
            <IconFlask size={12} stroke={1.75} />
            dev: simulate handoff{lanes[0] ? ` → ${lanes[0].agentId}` : ''}
          </button>
        </div>
      )}
        </div>
      )}
    </>
  )
}

function getPlanner(): PlannerBridge | undefined {
  return (window as unknown as { morzPlanner?: PlannerBridge }).morzPlanner
}

// w12/orch-engine
function getPlannerEngine(): PlannerEngineBridge | undefined {
  return (window as unknown as { morzPlannerEngine?: PlannerEngineBridge }).morzPlannerEngine
}
// end w12/orch-engine

function PlannerFlow(): JSX.Element {
  const spaceRoot = useSpaceStore(selectActiveSpaceRoot)
  const [goal, setGoal] = useState('')
  const goalComposerRef = useRef<HTMLTextAreaElement>(null)
  // w12/orch-engine
  // w15/planner-fast-default — 'fast' (Sonnet + GPT-5.5 race) is the default;
  // the Claude model is user-selectable for the fast/claude engines.
  const [engine, setEngine] = useState<PlannerEngine>('fast')
  const [claudeModel, setClaudeModel] = useState<PlannerClaudeModel>('sonnet')
  const [engineSaving, setEngineSaving] = useState(false)
  const [engineNotice, setEngineNotice] = useState('')
  // end w12/orch-engine
  const [record, setRecord] = useState<StoredSpawnPlan | null>(null)
  const [amendments, setAmendments] = useState<StoredPlanAmendment[]>([])
  const [amendmentRequest, setAmendmentRequest] = useState('')
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState('')
  const [error, setError] = useState('')

  useLayoutEffect(() => {
    const composer = goalComposerRef.current
    if (!composer) return
    composer.style.height = 'auto'
    composer.style.height = `${composer.scrollHeight}px`
  }, [goal])

  // w14/orch-scoped — plans are per space: re-fetch on every space change and
  // clear the composer state so a fresh space opens empty.
  useEffect(() => {
    setRecord(null)
    setAmendments([])
    setStatus('')
    setError('')
    setEngineNotice('')
    const planner = getPlanner()
    if (!planner || !spaceRoot) return
    let cancelled = false
    void planner
      .listOpen(spaceRoot)
      .then((open) => {
        if (cancelled) return
        setRecord(open.plans[0] ?? null)
        setAmendments(open.amendments)
      })
      .catch((reason: unknown) => {
        if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason))
      })
    return () => {
      cancelled = true
    }
  }, [spaceRoot])

  // w12/orch-engine
  useEffect(() => {
    const bridge = getPlannerEngine()
    if (!bridge) return
    void bridge
      .get()
      .then(setEngine)
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason)))
    void bridge
      .getModel()
      .then(setClaudeModel)
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason)))
  }, [])
  // end w12/orch-engine

  const run = async (work: () => Promise<void>): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      await work()
    } catch (reason) {
      setStatus('')
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(false)
    }
  }

  const createPlan = (): void => {
    const planner = getPlanner()
    if (!planner || !goal.trim() || !spaceRoot) return
    setStatus('Planning')
    void run(async () => {
      const next = await planner.plan(goal.trim(), spaceRoot)
      setRecord(next)
      setEngineNotice(next.notice ?? '')
      setStatus('')
    })
  }

  const updatePlan = (plan: StoredSpawnPlan['plan'], expectedHash: string): Promise<void> =>
    run(async () => {
      const next = await getPlanner()!.update(plan, expectedHash)
      setRecord(next)
    })

  // w14/multi-agent-plan — re-plan the same goal with user team constraints;
  // the old proposed plan is discarded only after the new one lands.
  const replanTeam = (options: PlanTeamOptions): Promise<void> => {
    const planner = getPlanner()
    if (!planner || !record) return Promise.resolve()
    setStatus('Planning')
    const previous = record
    return run(async () => {
      const next = await planner.plan(previous.plan.goal, previous.plan.spaceRoot, options)
      setRecord(next)
      setEngineNotice(next.notice ?? '')
      setStatus('')
      if (previous.state === 'PROPOSED') {
        try {
          await planner.discard(previous.plan.planHash)
        } catch {
          // The superseded proposal may already be gone; the new plan stands.
        }
      }
    })
  }
  // end w14/multi-agent-plan

  const approvePlan = (planHash: string): Promise<void> =>
    run(async () => {
      const approved = await getPlanner()!.approveAndRun(planHash)
      setRecord(approved.record)
      setStatus(`Run ${approved.runId}`)
    })

  const discardPlan = (planHash: string): Promise<void> =>
    run(async () => {
      await getPlanner()!.discard(planHash)
      setRecord(null)
      setEngineNotice('')
      setStatus('')
    })

  const requestAmendment = (): void => {
    if (!record || record.state !== 'APPROVED' || !amendmentRequest.trim()) return
    setStatus('Planning amendment')
    void run(async () => {
      const amendment = await getPlanner()!.requestAmendment(record.plan.id, amendmentRequest.trim())
      setAmendments((current) => [amendment, ...current])
      setAmendmentRequest('')
      setStatus('')
    })
  }

  const approveAmendment = (hash: string): Promise<void> =>
    run(async () => {
      await getPlanner()!.approveAmendment(hash)
      setAmendments((current) => current.filter((item) => item.amendment.amendmentHash !== hash))
      setStatus('Amendment approved')
    })

  const discardAmendment = (hash: string): Promise<void> =>
    run(async () => {
      await getPlanner()!.discardAmendment(hash)
      setAmendments((current) => current.filter((item) => item.amendment.amendmentHash !== hash))
    })

  return (
    <div className="space-y-2 border-b p-3" style={{ borderColor: 'var(--color-line)' }}>
      <form
        onSubmit={(event) => {
          event.preventDefault()
          createPlan()
        }}
        className="flex items-end gap-1.5"
      >
        <div className="flex min-w-0 flex-1 items-end gap-1">
          <textarea
            ref={goalComposerRef}
            aria-label="Goal"
            value={goal}
            onChange={(event) => setGoal(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault()
                if (!busy) createPlan()
              }
            }}
            rows={1}
            maxLength={100_000}
            placeholder="What should the team finish?"
            className="max-h-64 min-w-0 flex-1 resize-none overflow-y-auto rounded-md border bg-black/10 px-2 py-1.5 text-[10.5px] leading-relaxed outline-none focus:ring-1"
            style={{
              borderColor: 'var(--color-line-strong)',
              color: colors.quartz,
              '--tw-ring-color': colors.bronze
            } as React.CSSProperties}
          />
        </div>
        {/* w12/orch-engine */}
        <select
          aria-label="Planner engine"
          value={engine}
          disabled={busy || engineSaving || !getPlannerEngine()}
          onChange={(event) => {
            const selected = event.target.value as PlannerEngine
            const bridge = getPlannerEngine()
            if (!bridge) return
            setEngine(selected)
            setEngineSaving(true)
            setError('')
            void bridge
              .set(selected)
              .then(setEngine)
              .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason)))
              .finally(() => setEngineSaving(false))
          }}
          className="w-[66px] rounded-md border bg-black/10 px-1 py-1 text-[9px] font-semibold outline-none focus:ring-1 disabled:opacity-40"
          style={{
            borderColor: 'var(--color-line-strong)',
            color: colors.quartz,
            '--tw-ring-color': colors.bronze
          } as React.CSSProperties}
        >
          <option value="fast">Fast</option>
          <option value="claude">Claude</option>
          <option value="codex">Codex</option>
          <option value="local">Local</option>
        </select>
        {/* w15/planner-fast-default — Claude model for the fast/claude engines */}
        {(engine === 'fast' || engine === 'claude') && (
          <select
            aria-label="Planner Claude model"
            value={claudeModel}
            disabled={busy || engineSaving || !getPlannerEngine()}
            onChange={(event) => {
              const selected = event.target.value as PlannerClaudeModel
              const bridge = getPlannerEngine()
              if (!bridge) return
              setClaudeModel(selected)
              setEngineSaving(true)
              setError('')
              void bridge
                .setModel(selected)
                .then(setClaudeModel)
                .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason)))
                .finally(() => setEngineSaving(false))
            }}
            className="w-[66px] rounded-md border bg-black/10 px-1 py-1 text-[9px] font-semibold outline-none focus:ring-1 disabled:opacity-40"
            style={{
              borderColor: 'var(--color-line-strong)',
              color: colors.quartz,
              '--tw-ring-color': colors.bronze
            } as React.CSSProperties}
          >
            <option value="sonnet">Sonnet</option>
            <option value="opus">Opus</option>
            <option value="fable">Fable</option>
          </select>
        )}
        {/* end w12/orch-engine */}
        <button
          type="submit"
          disabled={busy || engineSaving || !goal.trim() || !getPlanner()}
          className="flex items-center gap-1 rounded-md px-2 py-1.5 text-[10px] font-bold disabled:cursor-not-allowed disabled:opacity-40"
          style={{ background: colors.bronze, color: colors.page }}
          aria-label="Plan team"
        >
          <IconSparkles size={11} stroke={2} />
          Plan
        </button>
      </form>

      {/* w12/orch-engine */}
      {engineNotice && (
        <p role="status" className="text-[9.5px] leading-snug" style={{ color: colors.bronzeHot }}>
          {engineNotice}
        </p>
      )}
      {/* end w12/orch-engine */}
      {status && <p className="text-[9.5px]" style={{ color: colors.bronzeHot }}>{status}</p>}
      {error && <p role="alert" className="text-[9.5px] leading-snug" style={{ color: colors.error }}>{error}</p>}

      {record && (
        <PlanCard
          record={record}
          busy={busy}
          onUpdate={updatePlan}
          onApprove={approvePlan}
          onDiscard={discardPlan}
          onReplan={replanTeam} // w14/multi-agent-plan
        />
      )}

      {record?.state === 'APPROVED' && (
        <form
          onSubmit={(event) => {
            event.preventDefault()
            requestAmendment()
          }}
          className="flex gap-1.5"
        >
          <input
            aria-label="Amendment request"
            value={amendmentRequest}
            onChange={(event) => setAmendmentRequest(event.target.value)}
            maxLength={2_000}
            placeholder="Add or replace one agent"
            className="min-w-0 flex-1 rounded-md border bg-black/10 px-2 py-1 text-[9.5px] outline-none"
            style={{ borderColor: 'var(--color-line-strong)', color: colors.quartz }}
          />
          <button
            type="submit"
            disabled={busy || !amendmentRequest.trim()}
            className="rounded-md border px-2 py-1 text-[9px] disabled:opacity-40"
            style={{ borderColor: 'var(--color-line-strong)', color: colors.quartz }}
          >
            Request
          </button>
        </form>
      )}

      {amendments.map((amendment) => (
        <AmendmentCard
          key={amendment.amendment.id}
          record={amendment}
          busy={busy}
          onApprove={approveAmendment}
          onDiscard={discardAmendment}
        />
      ))}
    </div>
  )
}

/* ── task card: state pill + messages + artifacts ────────────── */

function TaskCard({ task, messages }: { task: Task; messages: Message[] }): JSX.Element {
  const tint = stateColor[task.state] ?? colors.quartzDim
  const taskMessages = messages.filter((m) => m.taskId === task.id)
  return (
    <motion.div
      variants={staggerItem}
      layout
      className="rounded-xl border p-2.5"
      style={{ background: colors.card + '99', borderColor: 'var(--color-line)' }}
      data-testid="bus-task"
      data-state={task.state}
    >
      <div className="flex items-center gap-1.5">
        <span className="size-2 shrink-0 rounded-full" style={{ background: tint }} />
        <span
          className="truncate text-xs font-semibold"
          style={{ color: colors.quartz, fontFamily: 'var(--font-display)' }}
        >
          {task.title}
        </span>
        <span
          className="ml-auto shrink-0 rounded px-1.5 py-px text-[8.5px] font-extrabold uppercase"
          style={{ background: `${tint}29`, color: tint }}
        >
          {task.state}
        </span>
      </div>
      <div className="mt-1 flex items-center gap-2 text-[10px]" style={{ color: colors.quartzDim }}>
        <span>{task.createdBy}</span>
        {task.assignee && <span>→ {task.assignee}</span>}
        {task.blockedReason && <span style={{ color: colors.blocked }}>{task.blockedReason}</span>}
      </div>
      {taskMessages.length > 0 && (
        <ul className="mt-1.5 space-y-1 border-t pt-1.5" style={{ borderColor: 'var(--color-line)' }}>
          {taskMessages.slice(-3).map((m) => (
            <li key={m.id} className="flex items-baseline gap-1.5 text-[10.5px]">
              <span className="shrink-0 font-semibold" style={{ color: colors.quartz }}>
                {m.from}
              </span>
              <span className="truncate" style={{ color: colors.quartzDim }}>
                {partSummary(m.parts)}
              </span>
            </li>
          ))}
        </ul>
      )}
      {task.artifacts.length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {task.artifacts.map((a) => (
            <span
              key={a.id}
              className="rounded px-1.5 py-px text-[9px]"
              style={{ background: 'rgba(34,197,94,0.14)', color: colors.done }}
              title={a.files.map((f) => f.path).join('\n')}
            >
              {a.label}
            </span>
          ))}
        </div>
      )}
    </motion.div>
  )
}

/** One-line summary of a message's parts; unknown kinds are skipped (protocol §4). */
function partSummary(parts: Part[]): string {
  for (const p of parts) {
    if (p.kind === 'text') return p.text
    if (p.kind === 'approval-request') return `⏸ ${p.summary}`
    if (p.kind === 'file') return p.path
    if (p.kind === 'command') return p.argv.join(' ')
    if (p.kind === 'diff') return 'diff'
  }
  return `${parts.length} part${parts.length === 1 ? '' : 's'}`
}
