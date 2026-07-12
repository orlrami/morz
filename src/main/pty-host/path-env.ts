import { execFile } from 'child_process'

/*
 * Real-PATH resolution (0.0.1 Slice 1).
 * A GUI-launched Electron inherits the PATH from whatever spawned it (installer,
 * tray, stale explorer), so pipx/npm shims added after login are often missing.
 * Windows Terminal always sees them because each new shell recomposes PATH from
 * the registry (Machine + User). We do the same once at PTY-host startup and
 * reuse the merged PATH for every spawn.
 */

let cachedPath: string | null = null

function queryRegistryPath(): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        "[Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')"
      ],
      { timeout: 10_000, windowsHide: true },
      (err, stdout) => (err ? reject(err) : resolve(stdout.trim()))
    )
  })
}

/** Merge registry PATH (authoritative) with the inherited one, deduped, order-preserving. */
export async function resolveRealPath(): Promise<string> {
  if (cachedPath) return cachedPath
  const inherited = process.env.PATH ?? ''
  let registry = ''
  try {
    registry = await queryRegistryPath()
  } catch {
    // registry probe failed — inherited PATH is the best we have
  }
  const seen = new Set<string>()
  const merged: string[] = []
  for (const entry of `${registry};${inherited}`.split(';')) {
    const p = entry.trim()
    if (!p) continue
    const key = p.toLowerCase().replace(/\\+$/, '')
    if (seen.has(key)) continue
    seen.add(key)
    merged.push(p)
  }
  cachedPath = merged.join(';')
  return cachedPath
}

/** Build the env for a PTY child: real PATH + MORZ_SESSION tag, Electron noise stripped. */
export function buildChildEnv(
  realPath: string,
  sessionGuid: string,
  extra?: Record<string, string>
): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue
    if (k === 'ELECTRON_RUN_AS_NODE' || k.startsWith('ELECTRON_')) continue
    if (k.toUpperCase() === 'PATH') continue // re-set once below; duplicate casings confuse the child env block
    env[k] = v
  }
  env.Path = realPath
  env.MORZ_SESSION = sessionGuid
  return { ...env, ...extra }
}
