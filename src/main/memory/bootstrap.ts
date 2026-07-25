import { createHash } from 'node:crypto'
import { lstat, open, opendir, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, extname, join } from 'node:path'
import type { MemoryScope } from '../../shared/memory'
import type { MemoryCandidate } from './opset'
import {
  assertKnownPathSafe,
  validateContextRoot
} from '../services/context-hub'

export const MEMORY_BOOTSTRAP_MAX_FILES = 200
export const MEMORY_BOOTSTRAP_MAX_FILE_BYTES = 256 * 1024
export const MEMORY_BOOTSTRAP_MAX_CANDIDATE_BYTES = 2 * 1024

export interface BootstrapMarkdownInput {
  path: string
  content: string
  scope: MemoryScope
  scopeRef?: string
}

export interface BootstrapMarkdownDocument extends BootstrapMarkdownInput {
  truncated: boolean
}

export interface BootstrapScanResult {
  filesScanned: number
  filesRead: number
  documents: BootstrapMarkdownDocument[]
  truncations: string[]
}

export interface BootstrapSpaceInput {
  id: string
  name: string
  root: string
}

function cleanHeading(value: string): string {
  return value
    .replace(/[\u0000-\u001f]/g, ' ')
    .replace(/\s+#+\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 220)
}

function stripFrontmatter(value: string): string {
  return value.replace(/^---\s*\n[\s\S]*?\n---\s*(?:\n|$)/, '')
}

function splitUtf8(value: string, limit: number): string[] {
  const result: string[] = []
  let current = ''
  for (const char of value) {
    if (current && Buffer.byteLength(current + char, 'utf8') > limit) {
      result.push(current.trim())
      current = char
    } else {
      current += char
    }
  }
  if (current.trim()) result.push(current.trim())
  return result
}

function candidateId(input: {
  source: string
  scope: MemoryScope
  scopeRef?: string
  title: string
  body: string
}): string {
  const slug = input.title
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'memory'
  const digest = createHash('sha256')
    .update([input.scope, input.scopeRef ?? '', input.source, input.title, input.body].join('\u0000'))
    .digest('hex')
    .slice(0, 12)
  return `${slug}-${digest}`
}

/** Pure heading-boundary splitter used by unit tests and the main-process scan. */
export function splitMarkdownCandidates(input: BootstrapMarkdownInput): MemoryCandidate[] {
  const fallbackHeading = cleanHeading(basename(input.path)) || 'Document'
  const sections: Array<{ heading: string; body: string }> = []
  let heading = fallbackHeading
  let lines: string[] = []
  const flush = (): void => {
    const body = stripFrontmatter(lines.join('\n')).trim()
    if (body) sections.push({ heading, body })
    lines = []
  }

  for (const line of input.content.replace(/\r\n/g, '\n').split('\n')) {
    const match = /^(#{1,6})\s+(.+?)\s*$/.exec(line)
    if (!match) {
      lines.push(line)
      continue
    }
    flush()
    heading = cleanHeading(match[2]) || fallbackHeading
  }
  flush()

  return sections.flatMap((section) => {
    const chunks = splitUtf8(section.body, MEMORY_BOOTSTRAP_MAX_CANDIDATE_BYTES)
    return chunks.map((body, index) => {
      const title = chunks.length > 1
        ? `${section.heading.slice(0, 205)} (part ${index + 1})`
        : section.heading
      const source = `${input.path}#${section.heading}`
      return {
        id: candidateId({ source, scope: input.scope, scopeRef: input.scopeRef, title, body }),
        scope: input.scope,
        ...(input.scope === 'global' ? {} : { scopeRef: input.scopeRef }),
        kind: 'fact' as const,
        title,
        body,
        origin: 'learned' as const,
        enabled: true,
        source
      }
    })
  })
}

interface PendingFile {
  path: string
  scope: MemoryScope
  scopeRef?: string
}

async function safeFile(root: string, path: string): Promise<boolean> {
  try {
    await assertKnownPathSafe(root, path)
    const info = await lstat(path)
    return info.isFile() && !info.isSymbolicLink()
  } catch {
    return false
  }
}

async function walkMarkdown(
  root: string,
  directory: string,
  files: PendingFile[],
  scope: MemoryScope,
  scopeRef: string | undefined,
  truncations: string[],
  depth = 0
): Promise<void> {
  if (depth > 20 || files.length > 5_000) {
    truncations.push(`${directory}: directory scan limit reached`)
    return
  }
  try {
    await assertKnownPathSafe(root, directory)
    const info = await lstat(directory)
    if (!info.isDirectory() || info.isSymbolicLink()) return
    const stream = await opendir(directory)
    for await (const entry of stream) {
      const path = join(directory, entry.name)
      if (entry.isSymbolicLink()) {
        truncations.push(`${path}: symbolic link skipped`)
      } else if (entry.isDirectory()) {
        await walkMarkdown(root, path, files, scope, scopeRef, truncations, depth + 1)
      } else if (entry.isFile() && extname(entry.name).toLowerCase() === '.md') {
        files.push({ path, scope, scopeRef })
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      truncations.push(`${directory}: unreadable directory skipped`)
    }
  }
}

async function collectGlobalFiles(
  files: PendingFile[],
  truncations: string[]
): Promise<void> {
  const home =
    process.env.MORZ_E2E === '1' && process.env.MORZ_MEMORY_BOOTSTRAP_HOME
      ? process.env.MORZ_MEMORY_BOOTSTRAP_HOME
      : homedir()
  const requestedRoot = join(home, '.claude')
  let root: string
  try {
    root = await validateContextRoot(requestedRoot)
  } catch {
    return
  }

  try {
    const stream = await opendir(root)
    for await (const entry of stream) {
      if (entry.isFile() && extname(entry.name).toLowerCase() === '.md') {
        files.push({ path: join(root, entry.name), scope: 'global' })
      }
    }
  } catch {
    truncations.push(`${root}: unreadable directory skipped`)
  }

  const projects = join(root, 'projects')
  try {
    await assertKnownPathSafe(root, projects)
    const stream = await opendir(projects)
    for await (const entry of stream) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue
      await walkMarkdown(
        root,
        join(projects, entry.name, 'memory'),
        files,
        'global',
        undefined,
        truncations
      )
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      truncations.push(`${projects}: unreadable directory skipped`)
    }
  }
}

async function collectSpaceFiles(
  input: BootstrapSpaceInput,
  files: PendingFile[],
  truncations: string[]
): Promise<void> {
  let root: string
  try {
    root = await validateContextRoot(input.root)
  } catch {
    truncations.push(`${input.root}: unavailable space skipped`)
    return
  }
  for (const name of ['CLAUDE.md', 'AGENTS.md', 'GEMINI.md']) {
    const path = join(root, name)
    if (await safeFile(root, path)) files.push({ path, scope: 'project', scopeRef: root })
  }
  await walkMarkdown(root, join(root, 'docs'), files, 'project', root, truncations)
}

async function readPrefix(path: string): Promise<{ content: string; truncated: boolean }> {
  const handle = await open(path, 'r')
  try {
    const buffer = Buffer.alloc(MEMORY_BOOTSTRAP_MAX_FILE_BYTES + 1)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    return {
      content: buffer.subarray(0, Math.min(bytesRead, MEMORY_BOOTSTRAP_MAX_FILE_BYTES)).toString('utf8'),
      truncated: bytesRead > MEMORY_BOOTSTRAP_MAX_FILE_BYTES
    }
  } finally {
    await handle.close()
  }
}

/** Main-safe file discovery: canonical roots, no symlinks, bounded reads. */
export async function scanBootstrapMarkdown(
  spaces: BootstrapSpaceInput[]
): Promise<BootstrapScanResult> {
  const files: PendingFile[] = []
  const truncations: string[] = []
  await collectGlobalFiles(files, truncations)
  const scanSpaces =
    process.env.MORZ_E2E === '1' && process.env.MORZ_MEMORY_BOOTSTRAP_GLOBAL_ONLY === '1'
      ? []
      : spaces
  for (const space of scanSpaces) await collectSpaceFiles(space, files, truncations)

  const deduped = new Map<string, PendingFile>()
  for (const file of files) {
    try {
      const canonical = await realpath(file.path)
      const key = process.platform === 'win32' ? canonical.toLowerCase() : canonical
      if (!deduped.has(key)) deduped.set(key, { ...file, path: canonical })
    } catch {
      truncations.push(`${file.path}: unreadable file skipped`)
    }
  }
  const discovered = [...deduped.values()].sort((a, b) => a.path.localeCompare(b.path))
  if (discovered.length > MEMORY_BOOTSTRAP_MAX_FILES) {
    truncations.push(
      `${discovered.length - MEMORY_BOOTSTRAP_MAX_FILES} files skipped after the ${MEMORY_BOOTSTRAP_MAX_FILES}-file cap`
    )
  }

  const documents: BootstrapMarkdownDocument[] = []
  for (const file of discovered.slice(0, MEMORY_BOOTSTRAP_MAX_FILES)) {
    try {
      const info = await stat(file.path)
      if (!info.isFile()) continue
      const read = await readPrefix(file.path)
      if (read.content.includes('\u0000')) {
        truncations.push(`${file.path}: binary-looking file skipped`)
        continue
      }
      if (read.truncated) {
        truncations.push(
          `${file.path}: truncated to ${MEMORY_BOOTSTRAP_MAX_FILE_BYTES / 1024}KB`
        )
      }
      documents.push({ ...file, ...read })
    } catch {
      truncations.push(`${file.path}: unreadable file skipped`)
    }
  }

  return {
    filesScanned: discovered.length,
    filesRead: documents.length,
    documents,
    truncations
  }
}
