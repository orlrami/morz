/*
 * Morz FsService (0.0.1) — main process.
 * fs:list — shallow directory listing for the file explorer over typed IPC
 * (FsApi in shared/ipc.ts).
 *
 * Scope: the renderer only ever asks for a space root or a child path returned
 * by a previous listing, so the guard is structural — the path must be
 * absolute and normalize without any '..' segment (no traversal above the
 * root it started from). node_modules/.git never appear in results.
 */
import { promises as fs } from 'fs'
import { isAbsolute, join, normalize, sep } from 'path'
import type { IpcMain } from 'electron'
import { FsApi, type FsEntry } from '../../shared/ipc'

const HIDDEN = new Set(['node_modules', '.git'])

async function listDir(dir: string): Promise<FsEntry[]> {
  const clean = normalize(dir)
  if (!isAbsolute(clean) || clean.split(sep).includes('..')) {
    throw new Error(`fs:list rejected path outside scope: ${dir}`)
  }
  const dirents = await fs.readdir(clean, { withFileTypes: true })
  const out: FsEntry[] = []
  for (const d of dirents) {
    if (HIDDEN.has(d.name)) continue
    out.push({
      name: d.name,
      kind: d.isDirectory() ? 'dir' : 'file',
      path: join(clean, d.name)
    })
  }
  // dirs first, then files, each alphabetical (case-insensitive)
  out.sort((a, b) =>
    a.kind !== b.kind ? (a.kind === 'dir' ? -1 : 1) : a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
  )
  return out
}

export function registerFsIpc(ipcMain: IpcMain): void {
  ipcMain.handle(FsApi.list, (_e, dir: string) => listDir(dir))
}
