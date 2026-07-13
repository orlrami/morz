/*
 * Bus v0 (0.0.2) — IPC surface. Wires the SQLite task board + file mailbox to
 * the renderer (blackboard UI) and pushes `bus:tasks-changed` with the full
 * board on every write (create/accept/claim/complete/block/resume/withdraw
 * and sweeper reclaims all funnel through onBoardChange).
 *
 * Trust boundary: everything arriving over renderer IPC is the user acting
 * through the app — Main stamps `from` as 'morz' on send; a sender-supplied
 * identity is never honored (protocol.md §1).
 */
import { BrowserWindow, ipcMain } from 'electron'
import { BusApi, type BusArtifactInput, type BusCreateTaskInput, type BusSendInput, type BusTaskFilter } from '../../shared/ipc'
import { MORZ_AGENT_ID, type AgentId, type TaskId } from '../../shared/bus'
import {
  acceptTask,
  blockTask,
  claimTask,
  completeTask,
  createTask,
  listTasks,
  onBoardChange,
  resumeTask,
  withdrawTask
} from './board'
import { deliver } from './mailbox'
import { startSweeper } from './sweeper'

function broadcastTasks(): void {
  const tasks = listTasks()
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(BusApi.tasksChanged, tasks)
  }
}

export function registerBusIpc(): void {
  onBoardChange(broadcastTasks)
  startSweeper()

  ipcMain.handle(BusApi.listTasks, (_e, filter?: BusTaskFilter) => listTasks(filter))
  ipcMain.handle(BusApi.createTask, (_e, input: BusCreateTaskInput) => createTask(input))
  ipcMain.handle(BusApi.acceptTask, (_e, taskId: TaskId) => acceptTask(taskId))
  ipcMain.handle(BusApi.withdrawTask, (_e, taskId: TaskId) => withdrawTask(taskId))
  ipcMain.handle(
    BusApi.claimTask,
    (_e, p: { taskId: TaskId; agentId: AgentId; leaseMs?: number }) =>
      claimTask(p.taskId, p.agentId, p.leaseMs)
  )
  ipcMain.handle(
    BusApi.completeTask,
    (_e, p: { taskId: TaskId; agentId: AgentId; artifact: BusArtifactInput }) =>
      completeTask(p.taskId, p.agentId, p.artifact)
  )
  ipcMain.handle(
    BusApi.blockTask,
    (_e, p: { taskId: TaskId; agentId: AgentId; reason: string }) =>
      blockTask(p.taskId, p.agentId, p.reason)
  )
  ipcMain.handle(
    BusApi.resumeTask,
    (_e, p: { taskId: TaskId; agentId: AgentId; leaseMs?: number }) =>
      resumeTask(p.taskId, p.agentId, p.leaseMs)
  )
  // renderer-originated sends are the user/app speaking — stamped 'morz'
  ipcMain.handle(BusApi.send, (_e, input: BusSendInput) => deliver(MORZ_AGENT_ID, input))
}
