import type { IpcMain } from 'electron'
import { OrganizerApi } from '../../shared/ipc'
import { organizerApply } from './apply'
import { organizerAudit } from './audit'
import { organizerPropose } from './propose'
import { explainRule } from './rules'

export { organizerApply } from './apply'
export { organizerAudit } from './audit'
export { organizerPropose } from './propose'

export function organizerExplain(ruleId: string): {
  rule: string
  explanation: string
  cite: string
} {
  const definition = explainRule(ruleId)
  return { rule: definition.id, explanation: definition.explanation, cite: definition.cite }
}

export function registerOrganizerIpc(ipcMain: IpcMain): void {
  ipcMain.handle(OrganizerApi.audit, (_event, root: string) => organizerAudit(root))
  ipcMain.handle(OrganizerApi.propose, (_event, root: string) => organizerPropose(root))
  ipcMain.handle(OrganizerApi.explain, (_event, ruleId: string) => organizerExplain(ruleId))
  ipcMain.handle(
    OrganizerApi.apply,
    (_event, request: { root: string; planHash: string }) =>
      organizerApply(request?.root, request?.planHash)
  )
}
