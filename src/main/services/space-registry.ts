/*
 * w17/context-blocks — space id resolution for main-process consumers.
 *
 * Before this, main had no way to name a Space: the dispatcher passed
 * `projectRoot` + `agentId` into the memory render and dropped `spaceId`
 * entirely (dispatcher.ts:325), so a `space`-scoped fact never reached a
 * dispatched team. The renderer publishes {id, root} pairs + the active id
 * here; every launch surface resolves through `resolveSpaceId`.
 *
 * Resolution is deliberately narrow:
 *   - a known ROOT resolves to that Space, or to nothing. A plan whose
 *     spaceRoot is not a registered Space must never borrow another Space's
 *     memory, so there is no fallback on this path.
 *   - a CWD resolves through containment, then falls back to the ACTIVE Space.
 *     Lanes run in subdirectories and in worktrees that live BESIDE the space
 *     root, where containment cannot answer — the active Space is the honest
 *     answer there, not a path-similarity guess.
 *
 * The renderer is NOT trusted to send a coherent snapshot (Codex round-1):
 * roots are canonicalized on disk and two Spaces may not claim the same one,
 * because `C:\Projects\morz` published twice — or once as `C:\Projects\.\morz`
 * — would otherwise let the first entry win and hand one team another team's
 * memory. Out-of-order publishes from one renderer are ignored by generation.
 */
import { realpathSync, statSync } from 'node:fs'
import { isAbsolute, relative, resolve } from 'node:path'
import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import {
  SpaceRegistryApi,
  type SpaceRegistryEntry,
  type SpaceRegistrySnapshot
} from '../../shared/space-registry'

const MAX_SPACES = 200
const MAX_ID = 200
const MAX_ROOT = 32_768

let spaces: SpaceRegistryEntry[] = []
let activeSpaceId: string | null = null
let publisherId: string | null = null
let generation = 0
/** True once ANY publish has been accepted — see `spaceRegistryReady`. */
let ready = false
let readyResolvers: (() => void)[] = []

/** Windows paths differ only by case and trailing separators — compare folded. */
function comparableRoot(root: string): string {
  const absolute = resolve(root)
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute
}

/**
 * The on-disk identity of a path: symlinks, junctions, `.` segments and 8.3
 * names all collapse. Falls back to `resolve` for a path that does not exist,
 * so a resolution attempt against a missing root still behaves predictably.
 */
function canonicalRoot(root: string): string {
  try {
    return realpathSync(resolve(root))
  } catch {
    return resolve(root)
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

function contains(root: string, path: string): boolean {
  const fromRoot = relative(comparableRoot(root), comparableRoot(path))
  return fromRoot === '' || (!fromRoot.startsWith('..') && !isAbsolute(fromRoot))
}

function cleanText(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) {
    throw new Error(`Space ${field} is invalid`)
  }
  return value.trim()
}

/**
 * Replace the registry with the renderer's current Spaces. Returns the stored
 * snapshot — which is not necessarily what was sent: a root that no longer
 * exists on disk is dropped (nothing can be dispatched into it anyway) while a
 * structurally incoherent snapshot is rejected outright.
 */
export function setSpaceRegistry(input: unknown): SpaceRegistrySnapshot {
  if (!input || typeof input !== 'object') throw new Error('Space registry snapshot is invalid')
  const snapshot = input as Record<string, unknown>
  if (!Array.isArray(snapshot.spaces) || snapshot.spaces.length > MAX_SPACES) {
    throw new Error('Space registry snapshot is invalid')
  }

  const sender = snapshot.publisherId === undefined ? null : cleanText(snapshot.publisherId, 'publisher', MAX_ID)
  const sentGeneration = snapshot.generation === undefined ? 0 : snapshot.generation
  if (typeof sentGeneration !== 'number' || !Number.isInteger(sentGeneration) || sentGeneration < 0) {
    throw new Error('Space registry generation is invalid')
  }
  // A reloaded renderer is a NEW publisher and takes over; an older message
  // from the CURRENT publisher lost a race and must not overwrite newer state.
  if (sender !== null && sender === publisherId && sentGeneration <= generation) {
    return spaceRegistry()
  }

  const next: SpaceRegistryEntry[] = []
  const ids = new Set<string>()
  const roots = new Set<string>()
  for (const raw of snapshot.spaces) {
    if (!raw || typeof raw !== 'object') throw new Error('Space registry entry is invalid')
    const entry = raw as Record<string, unknown>
    const id = cleanText(entry.id, 'id', MAX_ID)
    const rootInput = cleanText(entry.root, 'root', MAX_ROOT)
    if (!isAbsolute(rootInput)) throw new Error('Space root must be absolute')
    if (ids.has(id)) throw new Error('Space ids must be unique')
    ids.add(id)
    const root = canonicalRoot(rootInput)
    const key = comparableRoot(root)
    if (roots.has(key)) throw new Error('Space roots must be unique')
    roots.add(key)
    if (!isDirectory(root)) continue // unavailable root — nothing can launch there
    next.push({ id, root })
  }

  const active = snapshot.activeSpaceId
  if (active !== null && active !== undefined && typeof active !== 'string') {
    throw new Error('Active space id is invalid')
  }
  spaces = next
  activeSpaceId = typeof active === 'string' && next.some((space) => space.id === active) ? active : null
  publisherId = sender
  generation = sentGeneration
  if (!ready) {
    ready = true
    for (const resolveReady of readyResolvers.splice(0)) resolveReady()
  }
  return spaceRegistry()
}

export function spaceRegistry(): SpaceRegistrySnapshot {
  return { spaces: spaces.map((space) => ({ ...space })), activeSpaceId }
}

/** False until the renderer has published once — the cold-start window. */
export function spaceRegistryReady(): boolean {
  return ready
}

/**
 * Resolve once the renderer has published, or give up after `timeoutMs`.
 * Callers that need a Space (the dispatcher) wait briefly rather than silently
 * launching a team with no space memory during the cold-start race.
 */
export function awaitSpaceRegistryReady(timeoutMs: number): Promise<boolean> {
  if (ready) return Promise.resolve(true)
  return new Promise((resolveReady) => {
    const timer = setTimeout(() => {
      readyResolvers = readyResolvers.filter((candidate) => candidate !== onReady)
      resolveReady(false)
    }, timeoutMs)
    timer.unref?.()
    const onReady = (): void => {
      clearTimeout(timer)
      resolveReady(true)
    }
    readyResolvers.push(onReady)
  })
}

/** Test/teardown hook — the registry is process state, not persisted. */
export function clearSpaceRegistry(): void {
  spaces = []
  activeSpaceId = null
  publisherId = null
  generation = 0
  ready = false
  readyResolvers = []
}

/**
 * The Space a launch surface belongs to. `root` is an exact Space root (the
 * dispatcher's `plan.spaceRoot`); `cwd` is wherever a lane was opened.
 */
export function resolveSpaceId(opts: { root?: string | null; cwd?: string | null }): string | undefined {
  if (opts.root) {
    const wanted = comparableRoot(canonicalRoot(opts.root))
    return spaces.find((space) => comparableRoot(space.root) === wanted)?.id
  }
  if (opts.cwd) {
    const cwd = canonicalRoot(opts.cwd)
    const containing = spaces
      .filter((space) => contains(space.root, cwd))
      .sort((a, b) => comparableRoot(b.root).length - comparableRoot(a.root).length)[0]
    if (containing) return containing.id
  }
  return activeSpaceId ?? undefined
}

/** Same trust boundary as registerContextHubIpc — main frame, local origin. */
function assertTrustedSender(event: IpcMainInvokeEvent): void {
  if (!event.senderFrame || event.senderFrame !== event.sender.mainFrame) {
    throw new Error('Space registry rejected an untrusted frame')
  }
  const url = new URL(event.senderFrame.url)
  const localDev =
    (url.protocol === 'http:' || url.protocol === 'https:') &&
    (url.hostname === 'localhost' || url.hostname === '127.0.0.1')
  if (url.protocol !== 'file:' && !localDev) {
    throw new Error('Space registry rejected an untrusted renderer origin')
  }
}

let registered = false

export function registerSpaceRegistryIpc(ipcMain: IpcMain): void {
  if (registered) return
  ipcMain.handle(SpaceRegistryApi.publish, (event, snapshot: unknown) => {
    assertTrustedSender(event)
    return setSpaceRegistry(snapshot)
  })
  if (process.env.MORZ_E2E === '1') {
    ipcMain.handle(SpaceRegistryApi.testSnapshot, () => spaceRegistry())
  }
  registered = true
}
