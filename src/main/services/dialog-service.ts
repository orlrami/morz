import { isAbsolute, normalize } from 'path'
import { BrowserWindow, dialog, type IpcMain } from 'electron'
import { DialogApi } from '../../shared/ipc'

function e2eFolder(): string | null {
  if (process.env.MORZ_E2E !== '1') return null
  const fixture = process.env.MORZ_E2E_PICK_FOLDER
  return fixture && isAbsolute(fixture) ? normalize(fixture) : null
}

export function registerDialogIpc(ipcMain: IpcMain): void {
  ipcMain.handle(DialogApi.pickFolder, async (event): Promise<string | null> => {
    if (process.env.MORZ_E2E === '1') return e2eFolder()

    const parent = BrowserWindow.fromWebContents(event.sender)
    const options: Electron.OpenDialogOptions = {
      title: 'Open project folder',
      properties: ['openDirectory']
    }
    const result = parent
      ? await dialog.showOpenDialog(parent, options)
      : await dialog.showOpenDialog(options)
    if (result.canceled) return null
    const root = result.filePaths[0]
    return root && isAbsolute(root) ? normalize(root) : null
  })
}
