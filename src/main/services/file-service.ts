/*
 * Morz FileService (0.0.1 Slice 3) — main process.
 * read / save(expectedMtime) / watch over typed IPC per FileApi in shared/ipc.ts.
 *
 * Rules (Backend Plan §4):
 *  - content crosses IPC LF-normalized; original EOL + BOM are restored on save
 *  - saves are atomic (temp file in same dir → rename over target)
 *  - save with a stale expectedMtimeMs returns {ok:false, conflict:true} — never clobbers
 *  - our own saves are echo-suppressed so the renderer doesn't reload what it just wrote
 */
import { promises as fs } from 'fs'
import { dirname, join, normalize } from 'path'
import { randomBytes } from 'crypto'
import chokidar, { type FSWatcher } from 'chokidar'
import type { IpcMain, WebContents } from 'electron'
import { FileApi, type Eol, type FileChangedMsg, type FileReadResult, type FileSaveResult } from '../../shared/ipc'

const BOM = String.fromCharCode(0xfeff)
/** NTFS mtime is sub-ms precise but float64 round-trips can wobble; treat <1ms as equal. */
const MTIME_EPSILON = 1

interface FileMeta {
  eol: Eol
  bom: boolean
}

interface WatchEntry {
  watcher: FSWatcher
  sender: WebContents
}

/** Per-path state, keyed case-insensitively (win32). */
const metaByPath = new Map<string, FileMeta>()
const watchers = new Map<string, WatchEntry>()
const selfWriteMtime = new Map<string, number>()

function key(p: string): string {
  return normalize(p).toLowerCase()
}

function looksBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8000)
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true
  return false
}

function detectEol(text: string): Eol {
  const crlf = (text.match(/\r\n/g) ?? []).length
  const lf = (text.match(/(?<!\r)\n/g) ?? []).length
  return crlf > lf ? 'crlf' : 'lf'
}

async function readFile(path: string): Promise<FileReadResult> {
  const [buf, st] = await Promise.all([fs.readFile(path), fs.stat(path)])
  if (looksBinary(buf)) {
    metaByPath.delete(key(path))
    return { content: '', mtimeMs: st.mtimeMs, eol: 'lf', binary: true }
  }
  let text = buf.toString('utf8')
  const bom = text.startsWith(BOM)
  if (bom) text = text.slice(BOM.length)
  const eol = detectEol(text)
  metaByPath.set(key(path), { eol, bom })
  return { content: text.replace(/\r\n/g, '\n'), mtimeMs: st.mtimeMs, eol, binary: false }
}

async function saveFile(path: string, content: string, expectedMtimeMs: number): Promise<FileSaveResult> {
  const st = await fs.stat(path).catch(() => null)
  if (st && Math.abs(st.mtimeMs - expectedMtimeMs) > MTIME_EPSILON) {
    return { ok: false, conflict: true, mtimeMs: st.mtimeMs }
  }

  const meta = metaByPath.get(key(path)) ?? { eol: 'lf' as Eol, bom: false }
  let out = content
  if (meta.eol === 'crlf') out = out.replace(/\n/g, '\r\n')
  if (meta.bom) out = BOM + out

  const tmp = join(dirname(path), `.morz-tmp-${randomBytes(6).toString('hex')}`)
  try {
    await fs.writeFile(tmp, out, 'utf8')
    await fs.rename(tmp, path)
  } catch (err) {
    await fs.unlink(tmp).catch(() => {})
    throw err
  }

  const after = await fs.stat(path)
  selfWriteMtime.set(key(path), after.mtimeMs)
  return { ok: true, mtimeMs: after.mtimeMs }
}

function startWatch(path: string, sender: WebContents): void {
  const k = key(path)
  stopWatch(path)

  const watcher = chokidar.watch(path, {
    ignoreInitial: true,
    // agents often stream writes; wait for the file to settle before reporting
    awaitWriteFinish: { stabilityThreshold: 150, pollInterval: 50 }
  })

  const push = (msg: FileChangedMsg): void => {
    if (!sender.isDestroyed()) sender.send(FileApi.changed, msg)
  }

  const onChanged = async (): Promise<void> => {
    const st = await fs.stat(path).catch(() => null)
    if (!st) return
    const own = selfWriteMtime.get(k)
    if (own !== undefined && Math.abs(st.mtimeMs - own) <= MTIME_EPSILON) return // our own save echoing back
    push({ path, kind: 'changed', mtimeMs: st.mtimeMs })
  }

  watcher.on('change', () => void onChanged())
  // agents delete-then-recreate; treat re-add as a change so the pane reloads
  watcher.on('add', () => void onChanged())
  watcher.on('unlink', async () => {
    // atomic rename-over-target can surface as unlink+add — confirm it's really gone
    const st = await fs.stat(path).catch(() => null)
    if (st) return
    push({ path, kind: 'deleted', mtimeMs: 0 })
  })

  watchers.set(k, { watcher, sender })
}

function stopWatch(path: string): void {
  const k = key(path)
  const entry = watchers.get(k)
  if (entry) {
    void entry.watcher.close()
    watchers.delete(k)
  }
}

export function registerFileIpc(ipcMain: IpcMain): void {
  ipcMain.handle(FileApi.read, (_e, path: string) => readFile(path))
  ipcMain.handle(
    FileApi.save,
    (_e, args: { path: string; content: string; expectedMtimeMs: number }) =>
      saveFile(args.path, args.content, args.expectedMtimeMs)
  )
  ipcMain.on(FileApi.watch, (e, path: string) => startWatch(path, e.sender))
  ipcMain.on(FileApi.unwatch, (_e, path: string) => stopWatch(path))
}
