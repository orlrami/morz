import { basename } from 'path'

export interface TuiProcess {
  id: string
  executables: readonly string[]
}

/**
 * Known full-screen or terminal-owning processes. Keep this declarative: the
 * PTY manager samples node-pty's active-process title and asks this matcher.
 */
export const TUI_PROCESSES: readonly TuiProcess[] = [
  { id: 'vim', executables: ['vim', 'vi', 'view'] },
  { id: 'nvim', executables: ['nvim'] },
  { id: 'nano', executables: ['nano'] },
  { id: 'emacs', executables: ['emacs', 'emacsclient'] },
  { id: 'less', executables: ['less'] },
  { id: 'htop', executables: ['htop'] },
  { id: 'btop', executables: ['btop', 'btop4win'] },
  { id: 'lazygit', executables: ['lazygit'] },
  { id: 'gitui', executables: ['gitui'] },
  { id: 'tig', executables: ['tig'] },
  { id: 'ssh', executables: ['ssh', 'mosh'] },
  { id: 'python-repl', executables: ['python', 'python3', 'py', 'ipython'] },
  { id: 'node-repl', executables: ['node'] },
  { id: 'claude', executables: ['claude'] },
  { id: 'codex', executables: ['codex'] },
  { id: 'gemini', executables: ['gemini'] },
  { id: 'opencode', executables: ['opencode'] }
]

const KNOWN_EXECUTABLES = new Set(TUI_PROCESSES.flatMap((entry) => entry.executables))

/** Normalize a process title or spawned command to its executable stem. */
export function normalizeProcessName(command: string): string {
  const trimmed = command.trim()
  if (!trimmed) return ''
  const token = /^(?:"([^"]+)"|'([^']+)'|(\S+))/.exec(trimmed)
  const file = token?.[1] ?? token?.[2] ?? token?.[3] ?? ''
  return basename(file).toLowerCase().replace(/\.(?:exe|cmd|bat|ps1)$/i, '')
}

export function isKnownTuiProcess(command: string): boolean {
  return KNOWN_EXECUTABLES.has(normalizeProcessName(command))
}
