/*
 * GitService (Slice 4) — owner: Agent 4.
 * Git state via the git CLI (`git status --porcelain=v2 --branch`) — no git
 * library by design (docs/roadmap/0.0.1.md Slice 4). Watches .git/HEAD +
 * .git/index (worktree-aware) through chokidar and pushes GitApi.changed on a
 * 3s throttle so rapid branch switches / index churn stay smooth.
 */
import { spawn } from 'child_process'
import { ipcMain, webContents } from 'electron'
import { watch, type FSWatcher } from 'chokidar'
import { readFileSync, statSync } from 'fs'
import { isAbsolute, join, resolve } from 'path'
import { GitApi, type GitFile, type GitStatus } from '../../shared/ipc'

const THROTTLE_MS = 3000

interface RepoWatch {
  watcher: FSWatcher
  timer: NodeJS.Timeout | null
  lastRun: number
}

const watches = new Map<string, RepoWatch>()

function emptyStatus(cwd: string): GitStatus {
  return { cwd, branch: null, ahead: 0, behind: 0, files: [] }
}

/** Parse `git status --porcelain=v2 --branch` output. Exported for tests. */
export function parsePorcelainV2(cwd: string, text: string): GitStatus {
  const status = emptyStatus(cwd)
  for (const line of text.split('\n')) {
    if (!line) continue
    if (line.startsWith('# branch.head ')) {
      const head = line.slice('# branch.head '.length)
      status.branch = head === '(detached)' ? '(detached)' : head
    } else if (line.startsWith('# branch.ab ')) {
      const m = /^# branch\.ab \+(\d+) -(\d+)$/.exec(line)
      if (m) {
        status.ahead = Number(m[1])
        status.behind = Number(m[2])
      }
    } else if (line.startsWith('1 ') || line.startsWith('2 ')) {
      // 1 XY sub mH mI mW hH hI path   |   2 XY sub mH mI mW hH hI X<score> path\torig
      const fieldCount = line.startsWith('1 ') ? 8 : 9
      const fields = splitFields(line, fieldCount)
      if (!fields) continue
      const xy = fields.head[1]
      const path = line.startsWith('2 ') ? fields.rest.split('\t')[0] : fields.rest
      status.files.push(toGitFile(path, xy))
    } else if (line.startsWith('u ')) {
      // u XY sub m1 m2 m3 mW h1 h2 h3 path
      const fields = splitFields(line, 10)
      if (!fields) continue
      status.files.push(toGitFile(fields.rest, fields.head[1]))
    } else if (line.startsWith('? ')) {
      status.files.push({ path: line.slice(2), index: '?', worktree: '?' })
    }
  }
  return status
}

/** Split off the first n space-separated fields; return them + the remainder verbatim. */
function splitFields(line: string, n: number): { head: string[]; rest: string } | null {
  const head: string[] = []
  let idx = 0
  for (let i = 0; i < n; i++) {
    const next = line.indexOf(' ', idx)
    if (next === -1) return null
    head.push(line.slice(idx, next))
    idx = next + 1
  }
  return { head, rest: line.slice(idx) }
}

function toGitFile(path: string, xy: string): GitFile {
  return { path, index: xy[0] ?? '.', worktree: xy[1] ?? '.' }
}

function runGitStatus(cwd: string): Promise<GitStatus> {
  return new Promise((res) => {
    const child = spawn('git', ['status', '--porcelain=v2', '--branch'], {
      cwd,
      windowsHide: true
    })
    let out = ''
    child.stdout.on('data', (d: Buffer) => (out += d.toString('utf8')))
    child.on('error', () => res(emptyStatus(cwd)))
    child.on('close', (code) => res(code === 0 ? parsePorcelainV2(cwd, out) : emptyStatus(cwd)))
  })
}

/** Resolve the real gitdir — `.git` is a FILE (`gitdir: <path>`) in linked worktrees. */
function resolveGitDir(cwd: string): string | null {
  const dotGit = join(cwd, '.git')
  try {
    const st = statSync(dotGit)
    if (st.isDirectory()) return dotGit
    const m = /^gitdir:\s*(.+)\s*$/m.exec(readFileSync(dotGit, 'utf8'))
    if (!m) return null
    const dir = m[1].trim()
    return isAbsolute(dir) ? dir : resolve(cwd, dir)
  } catch {
    return null
  }
}

function broadcast(status: GitStatus): void {
  for (const wc of webContents.getAllWebContents()) wc.send(GitApi.changed, status)
}

function refresh(cwd: string): void {
  const w = watches.get(cwd)
  if (w) w.lastRun = Date.now()
  void runGitStatus(cwd).then(broadcast)
}

/** Leading + trailing throttle: fire now if idle ≥3s, else once at the window edge. */
function scheduleRefresh(cwd: string): void {
  const w = watches.get(cwd)
  if (!w) return
  const elapsed = Date.now() - w.lastRun
  if (elapsed >= THROTTLE_MS) {
    refresh(cwd)
  } else if (!w.timer) {
    w.timer = setTimeout(() => {
      w.timer = null
      refresh(cwd)
    }, THROTTLE_MS - elapsed)
  }
}

function watchRepo(cwd: string): void {
  if (watches.has(cwd)) return
  const gitDir = resolveGitDir(cwd)
  if (!gitDir) return
  const watcher = watch([join(gitDir, 'HEAD'), join(gitDir, 'index')], {
    ignoreInitial: true
  })
  watches.set(cwd, { watcher, timer: null, lastRun: 0 })
  watcher.on('all', () => scheduleRefresh(cwd))
}

export function registerGitIpc(): void {
  ipcMain.handle(GitApi.status, (_e, cwd: string) => runGitStatus(cwd))
  ipcMain.on(GitApi.watch, (_e, cwd: string) => watchRepo(cwd))
}

export function disposeGitService(): void {
  for (const w of watches.values()) {
    if (w.timer) clearTimeout(w.timer)
    void w.watcher.close()
  }
  watches.clear()
}
