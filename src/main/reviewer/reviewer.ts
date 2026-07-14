import Database from 'better-sqlite3'
import { randomUUID } from 'crypto'
import { spawn } from 'child_process'
import { mkdirSync } from 'fs'
import { isAbsolute, join, resolve } from 'path'
import { app, ipcMain, webContents } from 'electron'
import {
  ReviewApi,
  type ReviewAuthor,
  type ReviewFinding,
  type ReviewRunInput,
  type ReviewRunResult,
  type ReviewSeverity
} from '../../shared/ipc'
import { repairPrompt, reviewPrompt } from './prompts'

const ALLOWED_FINDING_KEYS = new Set([
  'severity',
  'file',
  'line',
  'title',
  'evidence',
  'suggestedFix'
])
const SEVERITIES = new Set<ReviewSeverity>(['critical', 'high', 'medium', 'low', 'info'])
const SAFE_REF = /^(?!-)[A-Za-z0-9][A-Za-z0-9._/-]*(?:\^)?$/
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024

interface CliResult {
  stdout: string
  stderr: string
}

let reviewDb: Database.Database | null = null

function openReviewDb(): Database.Database {
  if (reviewDb) return reviewDb
  const dir = join(app.getPath('appData'), 'Morz')
  mkdirSync(dir, { recursive: true })
  reviewDb = new Database(join(dir, 'morz.db'))
  reviewDb.pragma('journal_mode = WAL')
  reviewDb.exec(`
    CREATE TABLE IF NOT EXISTS review_runs (
      id                TEXT PRIMARY KEY,
      cwd               TEXT NOT NULL,
      base_ref          TEXT NOT NULL,
      head_ref          TEXT NOT NULL,
      author            TEXT NOT NULL,
      reviewer          TEXT NOT NULL,
      same_model_review INTEGER NOT NULL,
      findings          TEXT NOT NULL,
      created_at        TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS review_runs_created_at ON review_runs (created_at DESC);
  `)
  return reviewDb
}

function assertSafeRef(ref: string, name: string): void {
  if (!SAFE_REF.test(ref) || ref.includes('..') || ref.includes('@{') || ref.includes('//')) {
    throw new Error(`[reviewer] invalid ${name}`)
  }
}

function assertRunInput(input: ReviewRunInput): ReviewRunInput {
  if (!input || !isAbsolute(input.cwd)) throw new Error('[reviewer] cwd must be absolute')
  if (input.author !== 'claude' && input.author !== 'codex') {
    throw new Error('[reviewer] author must be claude or codex')
  }
  assertSafeRef(input.baseRef, 'baseRef')
  assertSafeRef(input.headRef, 'headRef')
  return { ...input, cwd: resolve(input.cwd) }
}

function runProcess(command: string, args: string[], cwd: string): Promise<CliResult> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(command, args, {
      cwd,
      windowsHide: true,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let stdout = ''
    let stderr = ''
    let outputBytes = 0
    let settled = false

    const fail = (error: Error): void => {
      if (settled) return
      settled = true
      if (!child.killed) child.kill()
      reject(error)
    }
    const collect = (target: 'stdout' | 'stderr', chunk: Buffer): void => {
      outputBytes += chunk.byteLength
      if (outputBytes > MAX_OUTPUT_BYTES) {
        fail(new Error(`[reviewer] ${command} output exceeded 2 MiB`))
        return
      }
      if (target === 'stdout') stdout += chunk.toString('utf8')
      else stderr += chunk.toString('utf8')
    }

    child.stdout.on('data', (chunk: Buffer) => collect('stdout', chunk))
    child.stderr.on('data', (chunk: Buffer) => collect('stderr', chunk))
    child.once('error', (error) => fail(error))
    child.once('close', (code) => {
      if (settled) return
      settled = true
      if (code !== 0) {
        reject(new Error(`[reviewer] ${command} exited ${code}: ${stderr.trim().slice(0, 1000)}`))
        return
      }
      resolveResult({ stdout, stderr })
    })
  })
}

function codexMessage(stdout: string): string {
  let message = ''
  for (const raw of stdout.split(/\r?\n/)) {
    if (!raw.trim()) continue
    let event: unknown
    try {
      event = JSON.parse(raw)
    } catch {
      continue
    }
    if (!event || typeof event !== 'object') continue
    const item = (event as { item?: { type?: unknown; text?: unknown } }).item
    if (
      (event as { type?: unknown }).type === 'item.completed' &&
      item?.type === 'agent_message' &&
      typeof item.text === 'string'
    ) {
      message = item.text
    }
  }
  if (!message) throw new Error('[reviewer] Codex returned no final agent message')
  return message
}

function claudeMessage(stdout: string): string {
  let envelope: unknown
  try {
    envelope = JSON.parse(stdout)
  } catch {
    throw new Error('[reviewer] Claude returned malformed JSON output')
  }
  if (!envelope || typeof envelope !== 'object') {
    throw new Error('[reviewer] Claude returned no result')
  }
  const result = (envelope as { result?: unknown }).result
  if (typeof result !== 'string') throw new Error('[reviewer] Claude returned no result text')
  return result
}

async function invokeBrain(reviewer: ReviewAuthor, prompt: string, cwd: string): Promise<string> {
  if (reviewer === 'codex') {
    const output = await runProcess(
      'codex',
      [
        'exec',
        '--json',
        '--ephemeral',
        '--ignore-user-config',
        '--ignore-rules',
        '--sandbox',
        'read-only',
        '--skip-git-repo-check',
        prompt
      ],
      cwd
    )
    return codexMessage(output.stdout)
  }
  const output = await runProcess(
    'claude',
    ['-p', '--output-format', 'json', '--permission-mode', 'dontAsk', prompt],
    cwd
  )
  return claudeMessage(output.stdout)
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function safeFindingPath(file: string): boolean {
  if (!file || file.length > 500 || isAbsolute(file) || file.includes('\0')) return false
  const normalized = file.replace(/\\/g, '/')
  return !normalized.split('/').some((part) => part === '..' || part === '')
}

export function parseFindings(text: string): ReviewFinding[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error('[reviewer] response is not strict JSON')
  }
  if (!Array.isArray(parsed) || parsed.length > 100) {
    throw new Error('[reviewer] response must be an array of at most 100 findings')
  }
  return parsed.map((value, index) => {
    if (!isPlainObject(value)) throw new Error(`[reviewer] finding ${index} is not an object`)
    if (Object.keys(value).some((key) => !ALLOWED_FINDING_KEYS.has(key))) {
      throw new Error(`[reviewer] finding ${index} has an unknown key`)
    }
    if (!SEVERITIES.has(value.severity as ReviewSeverity)) {
      throw new Error(`[reviewer] finding ${index} has invalid severity`)
    }
    if (typeof value.file !== 'string' || !safeFindingPath(value.file)) {
      throw new Error(`[reviewer] finding ${index} has an unsafe file path`)
    }
    if (!Number.isInteger(value.line) || (value.line as number) < 1 || (value.line as number) > 10_000_000) {
      throw new Error(`[reviewer] finding ${index} has invalid line`)
    }
    if (typeof value.title !== 'string' || !value.title.trim() || value.title.length > 500) {
      throw new Error(`[reviewer] finding ${index} has invalid title`)
    }
    if (typeof value.evidence !== 'string' || !value.evidence.trim() || value.evidence.length > 8_000) {
      throw new Error(`[reviewer] finding ${index} has invalid evidence`)
    }
    if (
      value.suggestedFix !== undefined &&
      (typeof value.suggestedFix !== 'string' || value.suggestedFix.length > 8_000)
    ) {
      throw new Error(`[reviewer] finding ${index} has invalid suggestedFix`)
    }
    const finding: ReviewFinding = {
      severity: value.severity as ReviewSeverity,
      file: value.file,
      line: value.line as number,
      title: value.title.trim(),
      evidence: value.evidence.trim()
    }
    if (typeof value.suggestedFix === 'string' && value.suggestedFix.trim()) {
      finding.suggestedFix = value.suggestedFix.trim()
    }
    return finding
  })
}

async function reviewWithBrain(input: {
  diff: string
  author: ReviewAuthor
  reviewer: ReviewAuthor
  cwd: string
}): Promise<ReviewFinding[]> {
  const first = await invokeBrain(input.reviewer, reviewPrompt(input), input.cwd)
  try {
    return parseFindings(first)
  } catch {
    const repaired = await invokeBrain(input.reviewer, repairPrompt(first), input.cwd)
    return parseFindings(repaired)
  }
}

export async function reviewDiff(input: {
  diff: string
  author: ReviewAuthor
  cwd: string
}): Promise<{ reviewer: ReviewAuthor; sameModelReview: boolean; findings: ReviewFinding[] }> {
  if (!input.diff.trim()) return { reviewer: input.author === 'claude' ? 'codex' : 'claude', sameModelReview: false, findings: [] }
  const preferred: ReviewAuthor = input.author === 'claude' ? 'codex' : 'claude'
  try {
    const findings = await reviewWithBrain({ ...input, reviewer: preferred })
    return { reviewer: preferred, sameModelReview: false, findings }
  } catch (preferredError) {
    try {
      const findings = await reviewWithBrain({ ...input, reviewer: input.author })
      return { reviewer: input.author, sameModelReview: true, findings }
    } catch (fallbackError) {
      const primary = preferredError instanceof Error ? preferredError.message : String(preferredError)
      const fallback = fallbackError instanceof Error ? fallbackError.message : String(fallbackError)
      throw new Error(`[reviewer] cross-model review failed (${primary}); same-model fallback failed (${fallback})`)
    }
  }
}

async function gitDiff(input: ReviewRunInput): Promise<string> {
  const range = `${input.baseRef}..${input.headRef}`
  const { stdout } = await runProcess(
    'git',
    ['diff', '--no-ext-diff', '--unified=80', range, '--'],
    input.cwd
  )
  return stdout
}

function persist(result: ReviewRunResult): void {
  openReviewDb()
    .prepare(
      `INSERT INTO review_runs
       (id, cwd, base_ref, head_ref, author, reviewer, same_model_review, findings, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      result.id,
      result.cwd,
      result.baseRef,
      result.headRef,
      result.author,
      result.reviewer,
      result.sameModelReview ? 1 : 0,
      JSON.stringify(result.findings),
      result.createdAt
    )
}

function broadcast(result: ReviewRunResult): void {
  for (const contents of webContents.getAllWebContents()) {
    if (!contents.isDestroyed()) contents.send(ReviewApi.changed, result)
  }
}

export async function runReview(rawInput: ReviewRunInput): Promise<ReviewRunResult> {
  const input = assertRunInput(rawInput)
  const diff = await gitDiff(input)
  const reviewed = await reviewDiff({ diff, author: input.author, cwd: input.cwd })
  const result: ReviewRunResult = {
    ...input,
    id: randomUUID(),
    reviewer: reviewed.reviewer,
    sameModelReview: reviewed.sameModelReview,
    findings: reviewed.findings,
    createdAt: new Date().toISOString()
  }
  persist(result)
  broadcast(result)
  return result
}

export function registerReviewerIpc(): void {
  ipcMain.handle(ReviewApi.run, (_event, input: ReviewRunInput) => runReview(input))
}
