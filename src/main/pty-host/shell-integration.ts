import { mkdirSync, readFileSync, writeFileSync } from 'fs'
import { basename, join } from 'path'
import { tmpdir } from 'os'

/*
 * Consent-gated shell-integration hook (0.0.1 Slice 1 — OSC-133 blocks).
 * The scripts in resources/shell-integration/ emit nonce-signed OSC 133 marks.
 * PowerShell gets the script inline via -EncodedCommand: dot-sourcing a FILE
 * is subject to execution policy (default Restricted on stock Windows), a
 * command string is not — and nothing touches the user's profile or policy.
 * WSL bash needs a real file path for --init-file, so that one is copied to
 * %LOCALAPPDATA%\Morz\shell-integration (tmpdir fallback) — bash can't read
 * from inside app.asar.
 * Default ON; killed by MORZ_NO_SHELL_HOOK=1 (host env or per-spawn env).
 */

const PS1_NAME = 'morz-integration.ps1'
const SH_NAME = 'morz-integration.sh'

let psEncoded: string | null | undefined // base64(UTF-16LE) for -EncodedCommand
let shInstalled: string | null | undefined // on-disk path for bash --init-file

function readSource(name: string): string {
  // dev: out/main → <root>/resources; packaged: app.asar/out/main → app.asar/resources
  // (fs reads inside the asar transparently). extraResources layouts covered too.
  const candidates = [
    join(__dirname, '..', '..', 'resources', 'shell-integration', name),
    join(process.resourcesPath ?? '', 'shell-integration', name),
    join(process.resourcesPath ?? '', 'resources', 'shell-integration', name)
  ]
  for (const p of candidates) {
    try {
      return readFileSync(p, 'utf8')
    } catch {
      // try next
    }
  }
  throw new Error(`shell-integration script ${name} not found`)
}

function ensurePsCommand(): string | null {
  if (psEncoded !== undefined) return psEncoded
  try {
    psEncoded = Buffer.from(readSource(PS1_NAME), 'utf16le').toString('base64')
  } catch (e) {
    console.error(`[morz pty-host] shell-integration (ps) failed: ${(e as Error).message}`)
    psEncoded = null
  }
  return psEncoded
}

function ensureShScript(): string | null {
  if (shInstalled !== undefined) return shInstalled
  try {
    const base = process.env.LOCALAPPDATA
      ? join(process.env.LOCALAPPDATA, 'Morz')
      : join(tmpdir(), 'morz')
    const dir = join(base, 'shell-integration')
    mkdirSync(dir, { recursive: true })
    const sh = join(dir, SH_NAME)
    // bash chokes on CRLF — normalize whatever git checkout produced
    writeFileSync(sh, readSource(SH_NAME).replace(/\r\n/g, '\n'))
    shInstalled = sh
  } catch (e) {
    console.error(`[morz pty-host] shell-integration (sh) install failed: ${(e as Error).message}`)
    shInstalled = null
  }
  return shInstalled
}

/** C:\foo\bar → /mnt/c/foo/bar (null if not a drive-letter path). */
function toWslPath(winPath: string): string | null {
  const m = /^([A-Za-z]):[\\/](.*)$/.exec(winPath)
  if (!m) return null
  return `/mnt/${m[1].toLowerCase()}/${m[2].replace(/\\/g, '/')}`
}

export interface ShellHook {
  /** argv for the shell so it dot-sources the integration script. */
  args: string[]
  /** extra env entries (e.g. WSLENV pass-through for the nonce). */
  env?: Record<string, string>
}

/**
 * Hook for a resolved shell path, or null when the shell is unsupported
 * (cmd.exe — plain buffer is fine), the nonce is absent, or install failed.
 */
export function buildShellHook(file: string, env: Record<string, string>): ShellHook | null {
  if (!env.MORZ_BLOCK_NONCE) return null
  const exe = basename(file).toLowerCase()
  if (exe === 'pwsh.exe' || exe === 'pwsh' || exe === 'powershell.exe' || exe === 'powershell') {
    const encoded = ensurePsCommand()
    if (!encoded) return null
    return { args: ['-NoExit', '-EncodedCommand', encoded] }
  }
  if (exe === 'wsl.exe' || exe === 'wsl') {
    const sh = ensureShScript()
    if (!sh) return null
    const wslPath = toWslPath(sh)
    if (!wslPath) return null
    const wslenv = env.WSLENV ? `${env.WSLENV}:MORZ_BLOCK_NONCE/u` : 'MORZ_BLOCK_NONCE/u'
    return { args: ['bash', '--init-file', wslPath], env: { WSLENV: wslenv } }
  }
  return null
}
