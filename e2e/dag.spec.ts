import { expect, test } from '@playwright/test'
import { spawnSync } from 'child_process'
import { closeMorz, launchMorz, ROOT, type MorzApp } from './app'
import type { Task } from '../src/shared/bus'

interface DodCheck {
  command: string[]
  cwd: string
}

type DagBus = {
  createTask(input: {
    title: string
    createdBy: string
    dependsOn?: string[]
    dod?: DodCheck[]
  }): Promise<Task>
  acceptTask(taskId: string): Promise<Task>
  claimTask(taskId: string, agentId: string): Promise<Task | null>
  completeTask(
    taskId: string,
    agentId: string,
    artifact: { label: string; files?: never[]; commits?: never[] }
  ): Promise<Task>
  completeVerified(
    taskId: string,
    agentId: string,
    artifact: { label: string; files?: never[]; commits?: never[] }
  ): Promise<Task>
  blockTask(taskId: string, agentId: string, reason: string): Promise<Task>
  listTasks(): Promise<Task[]>
}

type DagWindow = Window & { morz: { bus: DagBus } }

const POWERSHELL = spawnSync('where.exe', ['pwsh'], { windowsHide: true }).status === 0
  ? 'pwsh'
  : 'powershell.exe'

test.describe.serial('DAG waves and machine-verified Definition of Done', () => {
  let morz: MorzApp

  test.beforeAll(async () => {
    morz = await launchMorz()
  })

  test.afterAll(async () => {
    if (morz) await closeMorz(morz.app)
  })

  test('gates waves on verified predecessors and renders live task states', async () => {
    const ids = await morz.page.evaluate(async ({ cwd, powershell }) => {
      const bus = (window as unknown as DagWindow).morz.bus
      const first = await bus.createTask({
        title: 'Compile contracts',
        createdBy: 'codex-dag',
        dod: [
          {
            command: [powershell, '-NoProfile', '-c', 'Write-Output DOD_OK; exit 0'],
            cwd
          }
        ]
      })
      const second = await bus.createTask({
        title: 'Run integration checks',
        createdBy: 'codex-dag',
        dependsOn: [first.id],
        dod: [
          {
            command: [powershell, '-NoProfile', '-c', "Write-Error 'DOD_FAIL'; exit 1"],
            cwd
          }
        ]
      })
      const third = await bus.createTask({
        title: 'Ship verified wave',
        createdBy: 'codex-dag',
        dependsOn: [second.id]
      })

      await Promise.all([first, second, third].map((task) => bus.acceptTask(task.id)))
      return { first: first.id, second: second.id, third: third.id }
    }, { cwd: ROOT, powershell: POWERSHELL })

    await morz.page.getByRole('tab', { name: 'Waves' }).click()

    const firstNode = morz.page.locator(`[data-dag-task-id="${ids.first}"]`)
    const secondNode = morz.page.locator(`[data-dag-task-id="${ids.second}"]`)
    const thirdNode = morz.page.locator(`[data-dag-task-id="${ids.third}"]`)
    await expect(firstNode).toBeVisible()
    await expect(secondNode).toHaveAttribute('data-locked', 'true')
    await expect(thirdNode).toHaveAttribute('data-locked', 'true')

    await morz.page.evaluate(async (taskId) => {
      const bus = (window as unknown as DagWindow).morz.bus
      await bus.claimTask(taskId, 'codex-dag')
    }, ids.first)
    await expect(firstNode).toHaveAttribute('data-task-state', 'working')
    await expect(firstNode.locator('[data-state-dot]')).toHaveCSS('background-color', 'rgb(106, 166, 217)')

    const selfReport = await morz.page.evaluate(async (taskId) => {
      const bus = (window as unknown as DagWindow).morz.bus
      try {
        await bus.completeTask(taskId, 'codex-dag', { label: 'self-reported only' })
        return null
      } catch (error) {
        return error instanceof Error ? error.message : String(error)
      }
    }, ids.first)
    expect(selfReport).toContain('requires bus.completeVerified')
    await expect(firstNode).toHaveAttribute('data-task-state', 'working')

    const completed = await morz.page.evaluate(async (taskId) => {
      const bus = (window as unknown as DagWindow).morz.bus
      return bus.completeVerified(taskId, 'codex-dag', { label: 'contracts verified' })
    }, ids.first)
    expect(completed.state).toBe('done')
    await expect(firstNode).toHaveAttribute('data-task-state', 'done')
    await expect(firstNode.locator('[data-state-dot]')).toHaveCSS('background-color', 'rgb(127, 183, 126)')
    await expect(secondNode).toHaveAttribute('data-locked', 'false')
    await expect(
      morz.page.locator(`[data-dag-edge-from="${ids.first}"][data-dag-edge-to="${ids.second}"]`)
    ).toHaveAttribute('data-pulse', 'true')

    await morz.page.evaluate(async (taskId) => {
      const bus = (window as unknown as DagWindow).morz.bus
      await bus.claimTask(taskId, 'codex-dag')
    }, ids.second)
    await expect(secondNode).toHaveAttribute('data-task-state', 'working')
    await expect(secondNode.locator('[data-state-dot]')).toHaveCSS('background-color', 'rgb(106, 166, 217)')

    const failure = await morz.page.evaluate(async (taskId) => {
      const bus = (window as unknown as DagWindow).morz.bus
      try {
        await bus.completeVerified(taskId, 'codex-dag', { label: 'must not land' })
        return null
      } catch (error) {
        return error instanceof Error ? error.message : String(error)
      }
    }, ids.second)
    expect(failure).toContain('DOD_FAIL')

    const stillWorking = await morz.page.evaluate(async (taskId) => {
      const bus = (window as unknown as DagWindow).morz.bus
      return (await bus.listTasks()).find((task) => task.id === taskId)?.state
    }, ids.second)
    expect(stillWorking).toBe('working')

    await morz.page.evaluate(async (taskId) => {
      const bus = (window as unknown as DagWindow).morz.bus
      await bus.blockTask(taskId, 'codex-dag', 'Definition of Done failed')
    }, ids.second)
    await expect(secondNode).toHaveAttribute('data-task-state', 'blocked')
    await expect(secondNode).toHaveAttribute('data-blocked-pulse', 'true')
    await expect(secondNode.locator('[data-state-dot]')).toHaveCSS('background-color', 'rgb(228, 169, 79)')
    await expect(thirdNode).toHaveAttribute('data-locked', 'true')
  })
})
