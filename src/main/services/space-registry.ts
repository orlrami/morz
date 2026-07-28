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
 */
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

/** Windows paths differ only by case and trailing separators — compare folded. */
function comparableRoot(root: string): string {
  const absolute = resolve(root)
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute
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

/** Replace the registry with the renderer's current Spaces. */
export function setSpaceRegistry(input: unknown): SpaceRegistrySnapshot {
  if (!input || typeof input !== 'object') throw new Error('Space registry snapshot is invalid')
  const snapshot = input as Record<string, unknown>
  if (!Array.isArray(snapshot.spaces) || snapshot.spaces.length > MAX_SPACES) {
    throw new Error('Space registry snapshot is invalid')
  }
  const next: SpaceRegistryEntry[] = []
  const seen = new Set<string>()
  for (const raw of snapshot.spaces) {
    if (!raw || typeof raw !== 'object') throw new Error('Space registry entry is invalid')
    const entry = raw as Record<string, unknown>
    const id = cleanText(entry.id, 'id', MAX_ID)
    const root = cleanText(entry.root, 'root', MAX_ROOT)
    if (!isAbsolute(root)) throw new Error('Space root must be absolute')
    if (seen.has(id)) throw new Error('Space ids must be unique')
    seen.add(id)
    next.push({ id, root })
  }
  const active = snapshot.activeSpaceId
  if (active !== null && active !== undefined && typeof active !== 'string') {
    throw new Error('Active space id is invalid')
  }
  spaces = next
  activeSpaceId = typeof active === 'string' && seen.has(active) ? active : null
  return spaceRegistry()
}

export function spaceRegistry(): SpaceRegistrySnapshot {
  return { spaces: spaces.map((space) => ({ ...space })), activeSpaceId }
}

/** Test/teardown hook — the registry is process state, not persisted. */
export function clearSpaceRegistry(): void {
  spaces = []
  activeSpaceId = null
}

/**
 * The Space a launch surface belongs to. `root` is an exact Space root (the
 * dispatcher's `plan.spaceRoot`); `cwd` is wherever a lane was opened.
 */
export function resolveSpaceId(opts: { root?: string | null; cwd?: string | null }): string | undefined {
  if (opts.root) {
    const wanted = comparableRoot(opts.root)
    return spaces.find((space) => comparableRoot(space.root) === wanted)?.id
  }
  if (opts.cwd) {
    const containing = spaces
      .filter((space) => contains(space.root, opts.cwd!))
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
  registered = true
}
