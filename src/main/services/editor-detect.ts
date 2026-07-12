/*
 * Morz editor handoff (0.0.1 Slice 3) — main process.
 * Detects installed VS Code / Cursor (HKCR url-protocol probe + CLI on PATH)
 * and opens files at line:col via vscode:// / cursor:// with a `code -g` fallback.
 * Undetected editors are omitted from detect() so the UI greys them out.
 */
import { execFile } from 'child_process'
import { shell } from 'electron'
import type { IpcMain } from 'electron'
import { EditorApi } from '../../shared/ipc'

type Editor = 'vscode' | 'cursor'

interface EditorProbe {
  protocol: boolean // HKCR\<scheme> URL Protocol registered
  cli: string | null // resolved CLI path (code.cmd / cursor.cmd), if on PATH
}

const SCHEME: Record<Editor, string> = { vscode: 'vscode', cursor: 'cursor' }
const CLI: Record<Editor, string> = { vscode: 'code', cursor: 'cursor' }

let probeCache: Promise<Record<Editor, EditorProbe>> | null = null

function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { windowsHide: true }, (err, stdout) => (err ? reject(err) : resolve(stdout)))
  })
}

async function hasProtocol(scheme: string): Promise<boolean> {
  try {
    const out = await run('reg', ['query', `HKCR\\${scheme}`, '/v', 'URL Protocol'])
    return out.includes('URL Protocol')
  } catch {
    return false
  }
}

async function cliPath(name: string): Promise<string | null> {
  try {
    const out = await run('where', [name])
    const first = out.split(/\r?\n/).find((l) => l.trim().length > 0)
    return first?.trim() ?? null
  } catch {
    return null
  }
}

function probeAll(): Promise<Record<Editor, EditorProbe>> {
  if (!probeCache) {
    probeCache = (async () => {
      const editors: Editor[] = ['vscode', 'cursor']
      const probes = await Promise.all(
        editors.map(async (ed) => {
          const [protocol, cli] = await Promise.all([hasProtocol(SCHEME[ed]), cliPath(CLI[ed])])
          return [ed, { protocol, cli }] as const
        })
      )
      return Object.fromEntries(probes) as Record<Editor, EditorProbe>
    })()
  }
  return probeCache
}

/** vscode://file/c:/dir/file.ts:12:4 — forward slashes, url-encoded path segments. */
function fileUrl(scheme: string, path: string, line?: number, col?: number): string {
  const fwd = path.replace(/\\/g, '/')
  const suffix = line ? `:${line}${col ? `:${col}` : ''}` : ''
  return `${scheme}://file/${encodeURI(fwd)}${suffix}`
}

async function openExternal(editor: Editor, path: string, line?: number, col?: number): Promise<void> {
  const probe = (await probeAll())[editor]
  if (probe.protocol) {
    await shell.openExternal(fileUrl(SCHEME[editor], path, line, col))
    return
  }
  if (probe.cli) {
    const target = line ? `${path}:${line}${col ? `:${col}` : ''}` : path
    // .cmd shims need a shell on Windows; execFile('cmd', ...) avoids arg-injection via array args
    await run('cmd', ['/c', probe.cli, '-g', target])
  }
}

export function registerEditorIpc(ipcMain: IpcMain): void {
  ipcMain.handle(EditorApi.detectEditors, async () => {
    const probes = await probeAll()
    return (Object.keys(probes) as Editor[]).filter((ed) => probes[ed].protocol || probes[ed].cli)
  })
  ipcMain.on(
    EditorApi.openExternal,
    (_e, args: { editor: Editor; path: string; line?: number; col?: number }) => {
      void openExternal(args.editor, args.path, args.line, args.col)
    }
  )
}
