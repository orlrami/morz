/*
 * Bus v0 (0.0.2) torture — drives the real IPC surface (window.morz.bus)
 * against the built app:
 *   1. full lifecycle: propose → accept → two concurrent claims (exactly one
 *      winner) → complete with artifact; DAG dep gates the claim; illegal
 *      transition rejects.
 *   2. lease expiry: a short-leased claim is reclaimed by the sweeper
 *      (working → accepted, the crashed-agent path).
 *   3. mailbox: bus.send lands an atomic Maildir file in new/ with JSON
 *      frontmatter + Markdown body; Main stamps from='morz' — a spoofed
 *      sender identity is ignored (trust boundary).
 *   4. bus:tasks-changed pushes the full board on writes.
 *
 * Sweeper runs at 500ms (MORZ_BUS_SWEEP_MS) and the Maildir roots in an
 * isolated MORZ_SPACE tmp dir — both env hooks read at app start.
 */
import { test, expect } from '@playwright/test'
import { mkdirSync, readdirSync, readFileSync } from 'fs'
import { join } from 'path'
import { closeMorz, launchMorz, ROOT, type MorzApp } from './app'
import type { Message, Task } from '../src/shared/bus'

type BusWindow = Window & {
  morz: {
    bus: {
      listTasks(f?: { state?: string }): Promise<Task[]>
      createTask(i: { title: string; createdBy: string; dependsOn?: string[] }): Promise<Task>
      acceptTask(id: string): Promise<Task>
      claimTask(id: string, agent: string, leaseMs?: number): Promise<Task | null>
      completeTask(
        id: string,
        agent: string,
        artifact: { label: string; files?: unknown[]; commits?: unknown[] }
      ): Promise<Task>
      send(i: unknown): Promise<Message>
      onTasksChanged(cb: (tasks: Task[]) => void): () => void
    }
  }
  __busEvents?: Task[][]
}

test.describe.serial('agent bus v0 (0.0.2)', () => {
  let morz: MorzApp
  let spaceDir: string

  test.beforeAll(async () => {
    spaceDir = join(ROOT, 'e2e', '.tmp', `space-${Date.now()}`)
    mkdirSync(spaceDir, { recursive: true })
    process.env.MORZ_BUS_SWEEP_MS = '500'
    process.env.MORZ_SPACE = spaceDir
    morz = await launchMorz()
  })

  test.afterAll(async () => {
    delete process.env.MORZ_BUS_SWEEP_MS
    delete process.env.MORZ_SPACE
    if (morz) await closeMorz(morz.app)
  })

  test('lifecycle: propose → accept → CAS claim (one winner) → complete with artifact', async () => {
    const r = await morz.page.evaluate(async () => {
      const bus = (window as unknown as BusWindow).morz.bus

      // DAG dep: gate must be done before the main task is claimable
      const gate = await bus.createTask({ title: 'gate', createdBy: 'claude-lane-1' })
      const task = await bus.createTask({
        title: 'add retry with backoff',
        createdBy: 'claude-lane-1',
        dependsOn: [gate.id]
      })
      const proposedState = task.state

      await bus.acceptTask(gate.id)
      await bus.acceptTask(task.id)

      // dep not done yet → claim returns null (claimable later, not an error)
      const early = await bus.claimTask(task.id, 'codex-lane-1')

      // finish the gate
      await bus.claimTask(gate.id, 'claude-lane-1')
      await bus.completeTask(gate.id, 'claude-lane-1', { label: 'gate done' })

      // two concurrent claims — CAS: exactly one winner
      const [a, b] = await Promise.all([
        bus.claimTask(task.id, 'codex-lane-1'),
        bus.claimTask(task.id, 'claude-lane-2')
      ])
      const winner = a ?? b
      const claimed = winner ? { state: winner.state, assignee: winner.assignee, lease: !!winner.leaseUntil } : null

      const done = winner
        ? await bus.completeTask(task.id, winner.assignee!, {
            label: 'retry logic + tests',
            files: [{ path: 'src/x.ts', mtimeMs: 1 }],
            commits: []
          })
        : null

      // illegal transition: claiming a done task must reject
      let illegalRejected = false
      try {
        await bus.claimTask(task.id, 'claude-lane-3')
      } catch {
        illegalRejected = true
      }

      return {
        proposedState,
        early,
        exactlyOneWinner: (a === null) !== (b === null),
        claimed,
        doneState: done?.state,
        artifactLabels: done?.artifacts.map((x) => x.label),
        artifactStamped: done?.artifacts.every((x) => !!x.id && !!x.ts && !!x.producedBy),
        illegalRejected
      }
    })

    expect(r.proposedState).toBe('proposed')
    expect(r.early).toBeNull() // dep gate held
    expect(r.exactlyOneWinner).toBe(true)
    expect(r.claimed?.state).toBe('working')
    expect(r.claimed?.lease).toBe(true)
    expect(r.doneState).toBe('done')
    expect(r.artifactLabels).toEqual(['retry logic + tests'])
    expect(r.artifactStamped).toBe(true)
    expect(r.illegalRejected).toBe(true)
  })

  test('lease expiry: sweeper re-opens a crashed claim (working → accepted)', async () => {
    const taskId = await morz.page.evaluate(async () => {
      const bus = (window as unknown as BusWindow).morz.bus
      const t = await bus.createTask({ title: 'crashy work', createdBy: 'claude-lane-1' })
      await bus.acceptTask(t.id)
      const claimed = await bus.claimTask(t.id, 'dead-agent', 800) // 0.8s lease
      if (claimed?.state !== 'working') throw new Error('claim failed')
      return t.id
    })

    // sweeper ticks every 500ms; lease dies at 800ms → reclaimed well under 10s
    await expect
      .poll(
        () =>
          morz.page.evaluate(async (id) => {
            const bus = (window as unknown as BusWindow).morz.bus
            const t = (await bus.listTasks()).find((x) => x.id === id)
            return t && { state: t.state, assignee: t.assignee }
          }, taskId),
        { timeout: 15_000 }
      )
      .toEqual({ state: 'accepted', assignee: null })

    // reclaimed task is claimable again by someone else
    const reclaim = await morz.page.evaluate(
      (id) => (window as unknown as BusWindow).morz.bus.claimTask(id, 'live-agent'),
      taskId
    )
    expect(reclaim?.assignee).toBe('live-agent')
  })

  test('mailbox: atomic Maildir file with stamped identity (spoofed from ignored)', async () => {
    const msg = await morz.page.evaluate(async () => {
      const bus = (window as unknown as BusWindow).morz.bus
      return bus.send({
        to: 'codex-lane-1',
        taskId: null,
        from: 'evil-imposter', // NOT part of BusSendInput — must be ignored
        parts: [
          { kind: 'text', text: 'handoff: fetcher fails on **503s**' },
          { kind: 'file', path: 'src/main/catalog/sync.ts', mtimeMs: 1783100000000 }
        ]
      })
    })

    // Main stamped identity + timestamp
    expect(msg.from).toBe('morz')
    expect(msg.ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)

    const newDir = join(spaceDir, '.morz', 'bus', 'codex-lane-1', 'new')
    const files = readdirSync(newDir)
    expect(files).toHaveLength(1)
    expect(files[0]).toBe(`${msg.ts.replace(/[-:.]/g, '')}-${msg.id}.md`)
    expect(readdirSync(join(spaceDir, '.morz', 'bus', 'codex-lane-1', 'tmp'))).toHaveLength(0)

    // JSON frontmatter + Markdown body; first text part became the body
    const content = readFileSync(join(newDir, files[0]), 'utf8')
    const m = /^---\n([\s\S]*?)\n---\n\n([\s\S]*)\n$/.exec(content)
    expect(m).not.toBeNull()
    const envelope = JSON.parse(m![1]) as Message
    expect(envelope.from).toBe('morz')
    expect(envelope.id).toBe(msg.id)
    expect(envelope.parts).toEqual([
      { kind: 'file', path: 'src/main/catalog/sync.ts', mtimeMs: 1783100000000 }
    ])
    expect(m![2]).toBe('handoff: fetcher fails on **503s**')
  })

  test('bus:tasks-changed pushes the full board on writes', async () => {
    const got = await morz.page.evaluate(async () => {
      const w = window as unknown as BusWindow
      w.__busEvents = []
      const off = w.morz.bus.onTasksChanged((tasks) => w.__busEvents!.push(tasks))
      const t = await w.morz.bus.createTask({ title: 'push me', createdBy: 'claude-lane-1' })
      // push arrives async after the invoke resolves — give it a beat
      await new Promise((r) => setTimeout(r, 1_000))
      off()
      const last = w.__busEvents![w.__busEvents!.length - 1]
      return {
        fired: w.__busEvents!.length > 0,
        containsTask: !!last?.find((x) => x.id === t.id && x.title === 'push me')
      }
    })
    expect(got.fired).toBe(true)
    expect(got.containsTask).toBe(true)
  })
})
