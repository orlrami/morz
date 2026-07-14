import { execFile } from 'child_process'
import { ipcMain } from 'electron'
import type { Task, TaskId } from '../../shared/bus'
import {
  BusApi,
  DodApi,
  type BusArtifactInput,
  type BusCreateTaskInput,
  type DodCheck
} from '../../shared/ipc'
import { boardDb, completeTask, createTask, getTask } from '../bus/board'

const MAX_CHECKS = 32
const MAX_COMMAND_PARTS = 64
const MAX_OUTPUT_BYTES = 1024 * 1024
const CHECK_TIMEOUT_MS = 2 * 60_000

interface DodRow {
  checks: string
}

function ensureTable(): void {
  boardDb().exec(`
    CREATE TABLE IF NOT EXISTS orchestrator_task_dod (
      task_id    TEXT PRIMARY KEY,
      checks     TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `)
}

function validateChecks(value: unknown): DodCheck[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_CHECKS) {
    throw new Error(`[dod] dod must contain 1-${MAX_CHECKS} checks`)
  }

  return value.map((candidate, index) => {
    if (!candidate || typeof candidate !== 'object') {
      throw new Error(`[dod] check ${index + 1} must be an object`)
    }
    const { command, cwd } = candidate as Partial<DodCheck>
    if (
      !Array.isArray(command) ||
      command.length === 0 ||
      command.length > MAX_COMMAND_PARTS ||
      command.some((part) => typeof part !== 'string') ||
      command[0].trim().length === 0
    ) {
      throw new Error(`[dod] check ${index + 1} needs a valid argv command`)
    }
    if (typeof cwd !== 'string' || cwd.trim().length === 0) {
      throw new Error(`[dod] check ${index + 1} needs a cwd`)
    }
    return { command: [...command], cwd }
  })
}

function storeChecks(taskId: TaskId, checks: DodCheck[]): void {
  ensureTable()
  boardDb()
    .prepare(
      `INSERT INTO orchestrator_task_dod (task_id, checks, created_at)
       VALUES (?, ?, ?)
       ON CONFLICT(task_id) DO UPDATE SET checks = excluded.checks`
    )
    .run(taskId, JSON.stringify(checks), new Date().toISOString())
}

function readChecks(taskId: TaskId): DodCheck[] | null {
  ensureTable()
  const row = boardDb()
    .prepare('SELECT checks FROM orchestrator_task_dod WHERE task_id = ?')
    .get(taskId) as DodRow | undefined
  if (!row) return null

  try {
    return validateChecks(JSON.parse(row.checks))
  } catch (error) {
    throw new Error(
      `[dod] stored checks for task ${taskId} are invalid: ${error instanceof Error ? error.message : String(error)}`
    )
  }
}

function createTaskWithDod(input: BusCreateTaskInput): Task {
  const checks = input.dod === undefined ? null : validateChecks(input.dod)
  const task = createTask(input)
  if (checks) storeChecks(task.id, checks)
  return task
}

function commandLabel(command: string[]): string {
  return command.map((part) => JSON.stringify(part)).join(' ')
}

function runCheck(check: DodCheck): Promise<void> {
  const [executable, ...args] = check.command
  return new Promise((resolve, reject) => {
    execFile(
      executable,
      args,
      {
        cwd: check.cwd,
        encoding: 'utf8',
        maxBuffer: MAX_OUTPUT_BYTES,
        timeout: CHECK_TIMEOUT_MS,
        windowsHide: true,
        shell: false
      },
      (error, stdout, stderr) => {
        if (!error) {
          resolve()
          return
        }
        const output = [stdout, stderr].filter(Boolean).join('\n').trim() || error.message
        reject(new Error(`[dod] command failed: ${commandLabel(check.command)}\n${output}`))
      }
    )
  })
}

async function completeVerified(
  taskId: TaskId,
  agentId: string,
  artifact: BusArtifactInput
): Promise<Task> {
  const task = getTask(taskId)
  if (!task || task.state !== 'working' || task.assignee !== agentId) {
    throw new Error(`[dod] task ${taskId} is not working for agent ${agentId}`)
  }

  const checks = readChecks(taskId)
  if (!checks) throw new Error(`[dod] task ${taskId} has no Definition of Done checks`)
  for (const check of checks) await runCheck(check)
  return completeTask(taskId, agentId, artifact)
}

export function registerDodIpc(): void {
  ensureTable()

  // Wrap the frozen 0.0.2 board surface without changing board.ts internals.
  ipcMain.removeHandler(BusApi.createTask)
  ipcMain.handle(BusApi.createTask, (_event, input: BusCreateTaskInput) => createTaskWithDod(input))

  ipcMain.removeHandler(BusApi.completeTask)
  ipcMain.handle(
    BusApi.completeTask,
    (_event, p: { taskId: TaskId; agentId: string; artifact: BusArtifactInput }) => {
      if (readChecks(p.taskId)) {
        throw new Error(`[dod] task ${p.taskId} requires bus.completeVerified`)
      }
      return completeTask(p.taskId, p.agentId, p.artifact)
    }
  )

  ipcMain.handle(
    DodApi.completeVerified,
    (_event, p: { taskId: TaskId; agentId: string; artifact: BusArtifactInput }) =>
      completeVerified(p.taskId, p.agentId, p.artifact)
  )
}
