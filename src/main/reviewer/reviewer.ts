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
const MAX_FINDINGS = 20
const PROCESS_TIMEOUT_MS = 120_000
const AUTO_BASE_REF = 'MORZ_BASE'
const SEVERITY_PRIORITY: Record<ReviewSeverity, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  info: 4
}

// w11/review-fix: renderer-only metadata may trail the shared w5 contract.
interface ReviewResultMeta {
  emptyDiff: boolean
  findingsTruncated: boolean
  totalFindings: number
}

interface CliResult {
  stdout: string
  stderr: string
}

class BrainUnavailableError extends Error {}

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
    // w11/review-fix: a disconnected/auth-blocked CLI must release the UI.
    const timeout = setTimeout(
      () => fail(new Error(`[reviewer] ${command} timed out after 120 seconds`)),
      PROCESS_TIMEOUT_MS
    )

    const fail = (error: Error): void => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
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
      clearTimeout(timeout)
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
  // w11/review-fix: deterministic brain for the packaged Electron E2E proof.
  if (process.env.MORZ_E2E === '1') {
    const mode = process.env.MORZ_E2E_REVIEW_MODE
    if (mode === 'missing-codex' && reviewer === 'codex') {
      throw new BrainUnavailableError('Codex CLI is not installed')
    }
    if (mode === 'finding') {
      return JSON.stringify(
        Array.from({ length: 24 }, (_, index) => ({
          severity:
            index === 23 ? 'critical' : index === 0 ? 'high' : index < 6 ? 'medium' : 'low',
          file: 'retry.ts',
          line: 1,
          title:
            index === 0
              ? 'Inverted retry comparison disables valid retries'
              : `Related retry-path concern ${index + 1}`,
          evidence:
            index === 0
              ? 'The changed predicate uses attempts > max, so normal attempts never retry.'
              : 'Stubbed supporting evidence for the bounded review presentation.',
          suggestedFix: index === 0 ? 'Restore attempts < max.' : undefined
        }))
      )
    }
  }

  if (reviewer === 'codex') {
    try {
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
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new BrainUnavailableError('Codex CLI is not installed')
      }
      throw error
    }
  }
  try {
    const output = await runProcess(
      'claude',
      ['-p', '--output-format', 'json', '--permission-mode', 'dontAsk', prompt],
      cwd
    )
    return claudeMessage(output.stdout)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new BrainUnavailableError('Claude CLI is not installed')
    }
    throw error
  }
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
}): Promise<{
  reviewer: ReviewAuthor
  sameModelReview: boolean
  findings: ReviewFinding[]
  findingsTruncated: boolean
  totalFindings: number
}> {
  if (!input.diff.trim()) {
    return {
      reviewer: input.author === 'claude' ? 'codex' : 'claude',
      sameModelReview: false,
      findings: [],
      findingsTruncated: false,
      totalFindings: 0
    }
  }
  const preferred: ReviewAuthor = input.author === 'claude' ? 'codex' : 'claude'
  try {
    const allFindings = await reviewWithBrain({ ...input, reviewer: preferred })
    const prioritizedFindings = allFindings
      .map((finding, index) => ({ finding, index }))
      .sort(
        (left, right) =>
          SEVERITY_PRIORITY[left.finding.severity] - SEVERITY_PRIORITY[right.finding.severity] ||
          left.index - right.index
      )
      .map(({ finding }) => finding)
    return {
      reviewer: preferred,
      sameModelReview: false,
      // w11/review-fix: keep large reviews actionable without losing the total.
      findings: prioritizedFindings.slice(0, MAX_FINDINGS),
      findingsTruncated: allFindings.length > MAX_FINDINGS,
      totalFindings: allFindings.length
    }
  } catch (error) {
    const label = preferred === 'codex' ? 'Codex' : 'Claude'
    const reason = error instanceof Error ? error.message.replace(/^\[reviewer\]\s*/, '') : String(error)
    if (!(error instanceof BrainUnavailableError)) {
      throw new Error(`[reviewer] Cross-model review with ${label} failed: ${reason}`)
    }
    // w11/review-fix: never disguise a missing non-author brain as cross-model review.
    throw new Error(
      `[reviewer] ${label} CLI is required for cross-model review. ` +
        `Connect ${label} in Settings or install the ${label} CLI, then try again. (${reason})`
    )
  }
}

async function refExists(cwd: string, ref: string): Promise<boolean> {
  try {
    await runProcess('git', ['rev-parse', '--verify', `${ref}^{commit}`], cwd)
    return true
  } catch {
    return false
  }
}

async function automaticBase(input: ReviewRunInput): Promise<string | null> {
  try {
    const { stdout } = await runProcess(
      'git',
      ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'],
      input.cwd
    )
    const remoteBase = stdout.trim()
    if (SAFE_REF.test(remoteBase) && (await refExists(input.cwd, remoteBase))) return remoteBase
  } catch {
    // A local-only repository normally has no origin/HEAD; probe conventional bases next.
  }
  for (const candidate of ['main', 'master']) {
    if (await refExists(input.cwd, candidate)) return candidate
  }
  return (await refExists(input.cwd, `${input.headRef}^`)) ? `${input.headRef}^` : null
}

async function gitDiff(input: ReviewRunInput): Promise<string> {
  let baseRef = input.baseRef
  let separator = '..'
  if (baseRef === AUTO_BASE_REF) {
    const detected = await automaticBase(input)
    if (!detected || detected === input.headRef) return ''
    baseRef = detected
    separator = '...'
  }
  const range = `${baseRef}${separator}${input.headRef}`
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

export async function runReview(
  rawInput: ReviewRunInput
): Promise<ReviewRunResult & ReviewResultMeta> {
  const input = assertRunInput(rawInput)
  const diff = await gitDiff(input)
  const reviewed = await reviewDiff({ diff, author: input.author, cwd: input.cwd })
  const result: ReviewRunResult & ReviewResultMeta = {
    ...input,
    id: randomUUID(),
    reviewer: reviewed.reviewer,
    sameModelReview: reviewed.sameModelReview,
    findings: reviewed.findings,
    emptyDiff: !diff.trim(),
    findingsTruncated: reviewed.findingsTruncated,
    totalFindings: reviewed.totalFindings,
    createdAt: new Date().toISOString()
  }
  persist(result)
  broadcast(result)
  return result
}

export function registerReviewerIpc(): void {
  ipcMain.handle(ReviewApi.run, (_event, input: ReviewRunInput) => runReview(input))
}
