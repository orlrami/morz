import { useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import {
  IconAlertTriangle,
  IconCheck,
  IconCoin,
  IconHandStop,
  IconPlayerPlay,
  IconPlayerStop,
  IconRefresh,
  IconSend,
  IconSparkles,
  IconTerminal2,
  IconTool,
  IconX
} from '@tabler/icons-react'
import type { ClaudePermissionReq } from '@shared/ipc'
import { reduceEvent, userBlock, type LaneBlock } from '@/lib/claude-events'
import { on, off } from '@/lib/app-events'
import { colors } from '@/lib/tokens'
import { springs } from '@/lib/springs'
import { useTerminal } from '@/hooks/useTerminal'
import { useLaneStore, type LaneMeter } from '@/store/laneStore'
import { useModeStore } from '@/store/modeStore'
import { getMorz } from '@/store/spaceStore'

/*
 * Claude lane (Slice 5+6, w5/bugfix): two ways to run Claude in a lane.
 *
 * Interactive (default): the REAL `claude` CLI in a PTY, rendered as a framed
 * TUI — its text and every slash command (/config, /model, /mcp) work exactly
 * like the real terminal. Headless print mode cannot do this: verified live,
 * `-p --input-format stream-json` answers "/model isn't available in this
 * environment." and /config with a usage error — the TUI is the only place
 * interactive commands exist.
 *
 * Structured: the stream-json adapter with native block rendering, meters and
 * Morz permission dialogs (Slices 5+6) — the machine-readable lane handoffs
 * and orchestration target.
 *
 * Mode gating is structural: in Manual this component renders an inert notice
 * and mounts NOTHING that touches window.morz.claude — the adapter is never
 * called, so Manual provably makes zero LLM calls (Slice 6). The interactive
 * PTY likewise never spawns until the user explicitly launches it, so merely
 * creating a lane still runs no claude process (manual-gate invariant).
 */
export function ClaudeLane({ agentId, cwd }: { agentId: string; cwd: string }): JSX.Element {
  const mode = useModeStore((s) => s.mode)
  const [laneMode, setLaneMode] = useState<'interactive' | 'structured'>('interactive')
  if (mode === 'manual') return <ManualNotice />
  // Both variants stay mounted (hidden via CSS) so toggling never loses the
  // TUI session or the structured transcript.
  return (
    <div className="flex h-full min-h-0 flex-col gap-1.5">
      <div className="flex shrink-0 items-center gap-1" role="tablist" aria-label="Lane mode">
        <LaneModeButton
          label="Interactive"
          active={laneMode === 'interactive'}
          onClick={() => setLaneMode('interactive')}
        />
        <LaneModeButton
          label="Structured"
          active={laneMode === 'structured'}
          onClick={() => setLaneMode('structured')}
        />
      </div>
      <div className={laneMode === 'interactive' ? 'min-h-0 flex-1' : 'hidden'}>
        <InteractiveLane agentId={agentId} cwd={cwd} />
      </div>
      <div className={laneMode === 'structured' ? 'min-h-0 flex-1' : 'hidden'}>
        <ActiveLane agentId={agentId} cwd={cwd} />
      </div>
    </div>
  )
}

function LaneModeButton({
  label,
  active,
  onClick
}: {
  label: string
  active: boolean
  onClick(): void
}): JSX.Element {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className="cursor-pointer rounded-md border px-2 py-0.5 text-[10px] font-semibold transition-colors"
      style={{
        borderColor: active ? 'rgba(203,162,90,0.5)' : 'var(--color-line)',
        color: active ? colors.bronzeHot : colors.quartzDim,
        background: active ? 'rgba(203,162,90,0.08)' : 'transparent'
      }}
    >
      {label}
    </button>
  )
}

/* ── interactive lane (w5/bugfix): real `claude` in a PTY, framed TUI ── */

function InteractiveLane({ agentId, cwd }: { agentId: string; cwd: string }): JSX.Element {
  const [launched, setLaunched] = useState(false)
  return (
    <div
      className="relative flex h-full flex-col overflow-hidden rounded-xl border"
      style={{ background: colors.panel, borderColor: 'var(--color-line)' }}
    >
      <div
        className="flex shrink-0 items-center gap-2 border-b px-3 py-2"
        style={{ borderColor: 'var(--color-line)' }}
      >
        <IconSparkles size={13} stroke={1.5} style={{ color: colors.agentClaude }} />
        <span className="text-[11px] font-semibold" style={{ fontFamily: 'var(--font-display)' }}>
          {agentId}
        </span>
        <span className="truncate text-[10px]" style={{ color: colors.quartzDim }}>
          {cwd}
        </span>
      </div>
      {launched ? (
        <InteractiveTerminal agentId={agentId} cwd={cwd} />
      ) : (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
          <IconTerminal2 size={22} stroke={1.5} style={{ color: colors.quartzDim }} />
          <p className="max-w-[300px] text-[11px]" style={{ color: colors.quartzDim }}>
            Runs the real <code>claude</code> CLI in this pane — its full UI and every slash
            command (<code>/config</code>, <code>/model</code>, <code>/mcp</code>) work here.
          </p>
          <button
            onClick={() => setLaunched(true)}
            aria-label="Launch interactive claude"
            className="flex cursor-pointer items-center gap-1.5 rounded-md px-3 py-1.5 text-[11px] font-semibold"
            style={{
              background: `linear-gradient(180deg, ${colors.bronzeHot}, ${colors.bronze})`,
              color: '#241c0a'
            }}
          >
            <IconPlayerPlay size={12} stroke={2} />
            Launch claude
          </button>
        </div>
      )}
    </div>
  )
}

/**
 * Mounted only after the explicit launch click — useTerminal spawns on mount.
 * The PTY pane is lane-scoped (`tty-<agentId>`): it survives Shell remounts
 * like any terminal, and dies with the lane (close-pane) or the Manual dial
 * (zero-LLM guarantee — a live TUI must not outlive the lane that owns it).
 */
function InteractiveTerminal({ agentId, cwd }: { agentId: string; cwd: string }): JSX.Element {
  const paneId = `tty-${agentId}`
  const { containerRef } = useTerminal(paneId, { shell: 'claude', cwd })

  useEffect(() => {
    const kill = (): void => getMorz()?.pty.kill(paneId)
    const onClosePane = ({ paneId: closing }: { paneId: string }): void => {
      const lane = useLaneStore.getState().lanes.find((l) => l.agentId === agentId)
      if (lane?.paneId === closing) kill()
    }
    on('close-pane', onClosePane)
    // zustand notifies synchronously on set() — this runs before the Manual
    // re-render unmounts us, so the kill always lands.
    const unsub = useModeStore.subscribe((s) => {
      if (s.mode === 'manual') kill()
    })
    return () => {
      off('close-pane', onClosePane)
      unsub()
    }
  }, [agentId, paneId])

  return <div ref={containerRef} className="min-h-0 flex-1 py-1 pl-2 pr-1" />
}

function ManualNotice(): JSX.Element {
  return (
    <div
      className="flex h-full flex-col items-center justify-center gap-2 rounded-xl border p-6 text-center"
      style={{ background: colors.panel, borderColor: 'var(--color-line)' }}
    >
      <IconHandStop size={22} stroke={1.5} style={{ color: colors.quartzDim }} />
      <p className="text-xs font-semibold" style={{ color: colors.quartz, fontFamily: 'var(--font-display)' }}>
        Manual mode — Claude lane off
      </p>
      <p className="max-w-[260px] text-[11px]" style={{ color: colors.quartzDim }}>
        Nothing runs in the background. Switch the dial to Assisted to start a lane; every tool
        permission will ask you first.
      </p>
    </div>
  )
}

/* All window.morz.claude access lives below this line, unmounted in Manual. */
function ActiveLane({ agentId, cwd }: { agentId: string; cwd: string }): JSX.Element {
  const [blocks, setBlocks] = useState<LaneBlock[]>([])
  const [status, setStatus] = useState<'idle' | 'live' | 'dead'>('idle')
  const [running, setRunning] = useState(false)
  const [model, setModel] = useState<string | null>(null)
  const [permissions, setPermissions] = useState<ClaudePermissionReq[]>([])
  const [input, setInput] = useState('')
  const mounted = useRef(true)
  /** Last result.total_cost_usd of the CURRENT process (cumulative per run). */
  const lastRunCost = useRef(0)
  const scrollRef = useRef<HTMLDivElement>(null)
  const meter = useLaneStore((s) => s.meters[agentId])
  const sessionId = useLaneStore((s) => s.sessions[agentId])
  const morz = getMorz()
  const bridge = morz && 'claude' in morz ? morz.claude : undefined

  useEffect(() => {
    mounted.current = true
    if (!bridge) return
    // Contract has no unsubscribe — gate the callbacks on the mount flag.
    bridge.onEvent((m) => {
      if (!mounted.current || m.agentId !== agentId) return
      const ev = m.event
      if (ev.type === 'system' && (ev as { subtype?: string }).subtype === 'init') {
        const init = ev as { session_id?: string; model?: string }
        if (init.session_id) useLaneStore.getState().setSessionId(agentId, init.session_id)
        if (init.model) setModel(init.model)
      } else if (ev.type === 'result') {
        const r = ev as {
          total_cost_usd?: number
          usage?: { input_tokens?: number; output_tokens?: number }
        }
        // Cost is cumulative within one claude process and resets on respawn
        // (verified live) — meter the delta. Tokens are per-run, add directly.
        const cost = typeof r.total_cost_usd === 'number' ? r.total_cost_usd : null
        const costDelta = cost != null ? Math.max(0, cost - lastRunCost.current) : undefined
        if (cost != null) lastRunCost.current = cost
        useLaneStore.getState().addUsage(agentId, {
          costUsd: costDelta,
          inputTokens: r.usage?.input_tokens,
          outputTokens: r.usage?.output_tokens
        })
        setRunning(false)
      } else if (ev.type === 'meter' && (ev as { source?: string }).source === 'jsonl') {
        const u = ev as { inputTokens?: number; outputTokens?: number }
        useLaneStore.getState().setFallbackUsage(agentId, {
          inputTokens: u.inputTokens ?? 0,
          outputTokens: u.outputTokens ?? 0
        })
      } else if (ev.type === 'process_exit' || ev.type === 'process_error') {
        setStatus('dead')
        setRunning(false)
      }
      setBlocks((b) => reduceEvent(b, ev))
    })
    bridge.onPermission((r) => {
      if (!mounted.current || r.agentId !== agentId) return
      setPermissions((q) => [...q, r])
    })
    return () => {
      mounted.current = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentId])

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
  }, [blocks])

  if (!bridge) {
    return (
      <div
        className="flex h-full items-center justify-center rounded-xl border p-6 text-[11px]"
        style={{ background: colors.panel, borderColor: 'var(--color-line)', color: colors.quartzDim }}
      >
        Claude bridge not available — preload wiring pending.
      </div>
    )
  }

  /** Spawn (or respawn) claude; resumes the persisted session when present. */
  const startProc = (firstText?: string): void => {
    lastRunCost.current = 0
    setStatus('live')
    const resume = useLaneStore.getState().sessions[agentId]
    void bridge.start({ agentId, cwd, resume }).then(() => {
      if (firstText) bridge.send(agentId, firstText)
    })
  }

  const submit = (): void => {
    const text = input.trim()
    if (!text) return
    if (status !== 'live') {
      startProc(text)
    } else {
      bridge.send(agentId, text)
    }
    setBlocks((b) => [...b, userBlock(text)])
    setRunning(true)
    setInput('')
  }

  const answerPermission = (requestId: string, behavior: 'allow' | 'deny'): void => {
    bridge.respondPermission({ requestId, behavior })
    setPermissions((q) => q.filter((p) => p.requestId !== requestId))
  }

  const activePermission = permissions[0]

  return (
    <div
      className="relative flex h-full flex-col overflow-hidden rounded-xl border"
      style={{ background: colors.panel, borderColor: 'var(--color-line)' }}
    >
      <div
        className="flex items-center gap-2 border-b px-3 py-2"
        style={{ borderColor: 'var(--color-line)' }}
      >
        <IconSparkles size={13} stroke={1.5} style={{ color: colors.agentClaude }} />
        <span className="text-[11px] font-semibold" style={{ fontFamily: 'var(--font-display)' }}>
          {agentId}
        </span>
        <span className="truncate text-[10px]" style={{ color: colors.quartzDim }}>
          {cwd}
        </span>
        {running && (
          <button
            onClick={() => bridge.interrupt(agentId)}
            className="ml-auto flex cursor-pointer items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10px]"
            style={{ borderColor: 'var(--color-line-strong)', color: colors.error }}
          >
            <IconPlayerStop size={11} stroke={2} />
            Interrupt
          </button>
        )}
      </div>

      <div ref={scrollRef} className="flex-1 space-y-1.5 overflow-y-auto px-3 py-2">
        {blocks.length === 0 && (
          <p className="pt-6 text-center text-[11px]" style={{ color: colors.quartzDim }}>
            Assisted lane ready — first prompt starts <code>claude</code> in this space.
          </p>
        )}
        {blocks.map((b) => (
          <Block key={b.id} block={b} />
        ))}
      </div>

      {status === 'dead' && (
        <div
          className="flex items-center gap-2 border-t px-3 py-1.5"
          style={{ borderColor: 'var(--color-line)', background: colors.page }}
        >
          <IconAlertTriangle size={12} style={{ color: colors.error }} />
          <span className="text-[10.5px]" style={{ color: colors.quartzDim }}>
            claude exited{sessionId ? ' — restart resumes this session' : ''}
          </span>
          <button
            onClick={() => startProc()}
            className="ml-auto flex cursor-pointer items-center gap-1 rounded-md border px-2 py-0.5 text-[10.5px] font-semibold"
            style={{ borderColor: 'var(--color-line-strong)', color: colors.bronzeHot }}
          >
            <IconRefresh size={11} stroke={2} />
            Restart
          </button>
        </div>
      )}

      <div className="border-t p-2" style={{ borderColor: 'var(--color-line)' }}>
        <div
          className="flex items-end gap-1.5 rounded-lg border px-2 py-1.5"
          style={{ background: colors.page, borderColor: 'var(--color-line-strong)' }}
        >
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              // w12/voice-input: Enter confirms an IME candidate before it submits a prompt.
              if (e.nativeEvent.isComposing) return
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                submit()
              }
            }}
            rows={1}
            placeholder="Prompt Claude…"
            className="max-h-24 min-h-[20px] flex-1 resize-none bg-transparent text-xs outline-none"
            style={{ color: colors.quartz }}
          />
          <button
            onClick={submit}
            className="cursor-pointer rounded-md p-1 transition-colors hover:brightness-110"
            style={{ color: colors.bronzeHot }}
            aria-label="Send"
          >
            <IconSend size={14} stroke={1.75} />
          </button>
        </div>
        <MeterRow meter={meter} model={model} />
      </div>

      <AnimatePresence>
        {activePermission && (
          <PermissionDialog
            req={activePermission}
            queued={permissions.length - 1}
            onAnswer={answerPermission}
          />
        )}
      </AnimatePresence>
    </div>
  )
}

/* ── meters (Slice 5) ────────────────────────────────────────── */

/** Grey dash = "no data", a first-class meter state — never a fake $0. */
function MeterRow({ meter, model }: { meter?: LaneMeter; model: string | null }): JSX.Element {
  const dash = <span style={{ color: colors.quartzDim, opacity: 0.6 }}>—</span>
  const cost = meter?.costUsd
  const inTok = meter?.inputTokens
  const outTok = meter?.outputTokens
  return (
    <div
      className="mt-1.5 flex items-center gap-2.5 px-1 text-[10px]"
      style={{ color: colors.quartzDim }}
      data-testid="lane-meter"
    >
      <span className="flex items-center gap-0.5">
        <IconCoin size={11} stroke={1.75} />
        {cost != null ? `$${cost.toFixed(4)}` : dash}
      </span>
      <span>{inTok != null ? `${inTok.toLocaleString()} in` : dash}</span>
      <span>{outTok != null ? `${outTok.toLocaleString()} out` : dash}</span>
      {model && <span className="ml-auto truncate">{model}</span>}
    </div>
  )
}

/* ── blocks ──────────────────────────────────────────────────── */

function Block({ block }: { block: LaneBlock }): JSX.Element | null {
  switch (block.kind) {
    case 'user':
      return (
        <div
          className="ml-8 rounded-lg border px-2.5 py-1.5 text-xs"
          style={{ background: colors.card, borderColor: 'var(--color-line)', color: colors.quartz }}
        >
          {block.text}
        </div>
      )
    case 'text':
      return (
        <div className="whitespace-pre-wrap px-1 text-xs leading-relaxed" style={{ color: colors.quartz }}>
          {block.text}
          {block.streaming && <span style={{ color: colors.bronzeHot }}>▍</span>}
        </div>
      )
    case 'tool':
      return <ToolBlock block={block} />
    case 'result':
      return (
        <div
          className="flex items-center gap-2 rounded-md px-2 py-1 text-[10px]"
          style={{ color: block.isError ? colors.error : colors.quartzDim }}
        >
          {block.isError ? <IconAlertTriangle size={11} /> : <IconCheck size={11} />}
          {block.costUsd != null && (
            <span className="flex items-center gap-0.5">
              <IconCoin size={11} />${block.costUsd.toFixed(4)}
            </span>
          )}
          {block.inputTokens != null && <span>{block.inputTokens} in</span>}
          {block.outputTokens != null && <span>{block.outputTokens} out</span>}
          {block.durationMs != null && <span>{(block.durationMs / 1000).toFixed(1)}s</span>}
        </div>
      )
    case 'info':
      return (
        <div className="px-1 text-[10px] italic" style={{ color: colors.quartzDim }}>
          {block.text}
        </div>
      )
    default:
      return null
  }
}

function ToolBlock({ block }: { block: Extract<LaneBlock, { kind: 'tool' }> }): JSX.Element {
  const diff = editDiff(block.name, block.input)
  return (
    <div
      className="overflow-hidden rounded-lg border"
      style={{ background: colors.page, borderColor: 'var(--color-line)' }}
    >
      <div className="flex items-center gap-1.5 px-2 py-1">
        <IconTool size={11} stroke={1.75} style={{ color: colors.agentClaude }} />
        <span className="text-[10.5px] font-semibold" style={{ color: colors.quartz }}>
          {block.name}
        </span>
        <span className="truncate text-[10px]" style={{ color: colors.quartzDim }}>
          {toolSummary(block.input)}
        </span>
        {block.isError && <IconAlertTriangle size={11} style={{ color: colors.error }} />}
      </div>
      {diff && (
        <pre className="max-h-40 overflow-auto px-2 pb-1.5 text-[10px] leading-snug">
          {diff.map((l, i) => (
            <div
              key={i}
              style={{
                color: l.kind === 'add' ? colors.done : l.kind === 'del' ? colors.error : colors.quartzDim
              }}
            >
              {l.kind === 'add' ? '+ ' : l.kind === 'del' ? '- ' : '  '}
              {l.text}
            </div>
          ))}
        </pre>
      )}
      {block.output && (
        <pre
          className="max-h-32 overflow-auto whitespace-pre-wrap border-t px-2 py-1 text-[10px]"
          style={{ borderColor: 'var(--color-line)', color: colors.quartzDim }}
        >
          {block.output.length > 1500 ? block.output.slice(0, 1500) + ' …' : block.output}
        </pre>
      )}
    </div>
  )
}

interface DiffLine {
  kind: 'add' | 'del' | 'ctx'
  text: string
}

/** Edit/Write inputs render as a mini diff (capped) instead of raw JSON. */
function editDiff(tool: string, input: unknown): DiffLine[] | null {
  const inp = input as { old_string?: string; new_string?: string; content?: string } | undefined
  if (!inp) return null
  const cap = (lines: string[], kind: DiffLine['kind']): DiffLine[] => {
    const shown = lines.slice(0, 12).map((text) => ({ kind, text }))
    if (lines.length > 12) shown.push({ kind: 'ctx', text: `… ${lines.length - 12} more lines` })
    return shown
  }
  if (tool === 'Edit' && (inp.old_string != null || inp.new_string != null)) {
    return [
      ...cap((inp.old_string ?? '').split('\n'), 'del'),
      ...cap((inp.new_string ?? '').split('\n'), 'add')
    ]
  }
  if (tool === 'Write' && inp.content != null) return cap(inp.content.split('\n'), 'add')
  return null
}

function toolSummary(input: unknown): string {
  const inp = input as Record<string, unknown> | undefined
  if (!inp) return ''
  const hint = inp.file_path ?? inp.path ?? inp.command ?? inp.pattern ?? inp.url
  return typeof hint === 'string' ? hint : ''
}

/* ── permission dialog (Slice 6: EVERY request, never auto-allow) ── */

function PermissionDialog({
  req,
  queued,
  onAnswer
}: {
  req: ClaudePermissionReq
  queued: number
  onAnswer(requestId: string, behavior: 'allow' | 'deny'): void
}): JSX.Element {
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="absolute inset-0 z-10 flex items-center justify-center p-4"
      style={{ background: 'rgba(20,18,14,0.6)' }}
    >
      <motion.div
        initial={{ scale: 0.95, y: 8 }}
        animate={{ scale: 1, y: 0, transition: springs.float }}
        exit={{ scale: 0.95, opacity: 0, transition: { duration: 0.12 } }}
        className="w-full max-w-sm rounded-xl border p-3"
        style={{ background: colors.panel, borderColor: 'rgba(203,162,90,0.4)' }}
        role="alertdialog"
        aria-label="Tool permission request"
      >
        <div className="flex items-center gap-1.5">
          <IconTerminal2 size={13} style={{ color: colors.blocked }} />
          <span className="text-xs font-semibold" style={{ fontFamily: 'var(--font-display)' }}>
            {req.agentId} wants to use {req.tool}
          </span>
          {queued > 0 && (
            <span className="ml-auto text-[10px]" style={{ color: colors.quartzDim }}>
              +{queued} queued
            </span>
          )}
        </div>
        <pre
          className="mt-2 max-h-36 overflow-auto whitespace-pre-wrap rounded-md border p-2 text-[10px]"
          style={{ background: colors.page, borderColor: 'var(--color-line)', color: colors.quartz }}
        >
          {JSON.stringify(req.input, null, 2)}
        </pre>
        <div className="mt-2.5 flex justify-end gap-1.5">
          <button
            onClick={() => onAnswer(req.requestId, 'deny')}
            className="flex cursor-pointer items-center gap-1 rounded-md border px-2.5 py-1 text-[11px]"
            style={{ borderColor: 'var(--color-line-strong)', color: colors.quartz }}
          >
            <IconX size={12} />
            Deny
          </button>
          <button
            onClick={() => onAnswer(req.requestId, 'allow')}
            className="flex cursor-pointer items-center gap-1 rounded-md px-2.5 py-1 text-[11px] font-semibold"
            style={{
              background: `linear-gradient(180deg, ${colors.bronzeHot}, ${colors.bronze})`,
              color: '#241c0a'
            }}
          >
            <IconCheck size={12} />
            Allow
          </button>
        </div>
      </motion.div>
    </motion.div>
  )
}
