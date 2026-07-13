import { execFile, spawn } from 'child_process'
import { createRequire } from 'module'
import { readdir, realpath, stat } from 'fs/promises'
import { basename, extname, isAbsolute, join, relative, sep } from 'path'
import type { ICruiseResult } from 'dependency-cruiser'
import { resolveOrganizerRoot, resolveRules, type ResolvedRule } from './rules'

export interface OrganizerViolation {
  rule: string
  path: string
  detail: string
  cite: string
}

interface SyncpackRow {
  dependency?: unknown
  package?: unknown
  statusType?: unknown
  statusCode?: unknown
  actual?: { raw?: unknown }
  expected?: { raw?: unknown }
}

const ignoredDirectories = new Set(['.git', 'node_modules', 'out', 'dist', 'build', 'release'])
const sourceExtension = /\.(?:[cm]?[jt]sx?)$/i

function toPosix(path: string): string {
  return path.split(sep).join('/')
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

async function listTree(root: string, current = root): Promise<string[]> {
  const entries = await readdir(current, { withFileTypes: true })
  const paths: string[] = []
  for (const entry of entries) {
    if (entry.name === '.git') continue
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue
    const absolute = join(current, entry.name)
    const projectPath = toPosix(relative(root, absolute))
    if (entry.isDirectory()) paths.push(...await listTree(root, absolute))
    else if (entry.isSymbolicLink()) {
      const linkTarget = await realpath(absolute)
      const targetRelative = relative(root, linkTarget)
      if (targetRelative === '..' || targetRelative.startsWith(`..${sep}`) || isAbsolute(targetRelative)) {
        throw new Error(`Organizer refuses a symbolic link outside the repository: ${projectPath}`)
      }
      paths.push(projectPath)
    } else if (entry.isFile()) paths.push(projectPath)
  }
  return paths.sort()
}

function enabledRule(rules: ResolvedRule[], id: string): ResolvedRule | undefined {
  return rules.find((rule) => rule.id === id && rule.enabled)
}

function pushViolation(
  violations: OrganizerViolation[],
  rule: ResolvedRule | undefined,
  path: string,
  detail: string
): void {
  if (rule) violations.push({ rule: rule.id, path, detail, cite: rule.cite })
}

function sourceStem(name: string): string {
  let stem = name.slice(0, -extname(name).length)
  for (const suffix of ['.test', '.spec', '.d']) {
    if (stem.endsWith(suffix)) stem = stem.slice(0, -suffix.length)
  }
  return stem
}

function auditNativeRules(
  tree: string[],
  rules: ResolvedRule[]
): OrganizerViolation[] {
  const violations: OrganizerViolation[] = []
  const present = new Set(tree)
  for (const [id, path] of [
    ['required-file/readme', 'README.md'],
    ['required-file/license', 'LICENSE'],
    ['required-file/gitignore', '.gitignore']
  ] as const) {
    if (!present.has(path)) pushViolation(violations, enabledRule(rules, id), path, `Required repository file ${path} is missing.`)
  }

  const namingRule = enabledRule(rules, 'naming/kebab-case')
  if (namingRule) {
    for (const path of tree) {
      if (!path.startsWith('src/') || !sourceExtension.test(path)) continue
      const name = basename(path)
      const stem = sourceStem(name)
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(stem)) {
        pushViolation(violations, namingRule, path, `Source filename ${name} is not lowercase kebab-case.`)
      }
    }
  }

  const docsRule = enabledRule(rules, 'docs/diataxis')
  if (docsRule && tree.some((path) => path.startsWith('docs/'))) {
    for (const bucket of ['tutorials', 'how-to', 'reference', 'explanation']) {
      if (!tree.some((path) => path.startsWith(`docs/${bucket}/`))) {
        pushViolation(violations, docsRule, `docs/${bucket}`, `Diátaxis bucket docs/${bucket}/ is missing.`)
      }
    }
  }

  const adrRule = enabledRule(rules, 'adr/madr-log')
  if (adrRule && !present.has('docs/decisions/README.md')) {
    pushViolation(violations, adrRule, 'docs/decisions/README.md', 'The MADR decision log index is missing.')
  }
  return violations
}

async function auditDependencyGraph(root: string, rules: ResolvedRule[]): Promise<OrganizerViolation[]> {
  const cycleRule = enabledRule(rules, 'dependencies/no-cycles')
  const boundaryRule = enabledRule(rules, 'boundaries/main-to-renderer')
  if ((!cycleRule && !boundaryRule) || !await pathExists(join(root, 'src'))) return []

  const forbidden = []
  if (cycleRule) forbidden.push({
    name: cycleRule.id,
    severity: 'warn' as const,
    from: {},
    to: { circular: true }
  })
  if (boundaryRule) forbidden.push({
    name: boundaryRule.id,
    severity: 'warn' as const,
    from: { path: '^src/main(?:/|$)' },
    to: { path: '^src/renderer(?:/|$)' }
  })

  // Lazy by design: dependency-cruiser and its graph parser load only when audit is invoked.
  const { cruise } = await import('dependency-cruiser')
  const report = await cruise(['src'], {
    baseDir: root,
    validate: true,
    ruleSet: { forbidden },
    exclude: '(^|/)(node_modules|out|dist|build|release)(/|$)'
  })
  if (typeof report.output === 'string') throw new Error('dependency-cruiser returned an unexpected text report')
  const result = report.output as ICruiseResult
  return result.summary.violations.map((violation) => {
    const rule = violation.rule.name === cycleRule?.id ? cycleRule : boundaryRule
    const cycle = violation.cycle?.map((step) => step.name).join(' -> ')
    return {
      rule: violation.rule.name,
      path: toPosix(violation.from),
      detail: cycle
        ? `Dependency cycle: ${toPosix(violation.from)} -> ${cycle}.`
        : `Forbidden dependency from ${toPosix(violation.from)} to ${toPosix(violation.to)}.`,
      cite: rule?.cite ?? 'https://github.com/sverweij/dependency-cruiser'
    }
  })
}

function runSyncpack(root: string): Promise<string> {
  const requireFromMain = createRequire(__filename)
  const platform = ['win32', 'cygwin'].includes(process.platform) ? 'windows' : process.platform
  let libc = ''
  if (process.platform === 'linux') {
    try {
      const report = process.report?.getReport() as { sharedObjects?: string[] }
      if (report.sharedObjects?.some((path) => path.includes('musl'))) libc = '-musl'
    } catch {
      // The glibc package is the conventional Linux default when reports are unavailable.
    }
  }
  const packageName = `syncpack-${platform}-${process.arch}${libc}`
  const packageJson = requireFromMain.resolve(`${packageName}/package.json`)
  const binary = join(packageJson, '..', 'bin', process.platform === 'win32' ? 'syncpack.exe' : 'syncpack')
  return new Promise((resolve, reject) => {
    const child = spawn(binary, ['json', '--no-ansi', '--log-levels', 'off'], {
      cwd: root,
      windowsHide: true,
      detached: process.platform !== 'win32',
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let stdout = ''
    let stderr = ''
    let failure: Error | undefined
    let settled = false
    const maxOutput = 10 * 1024 * 1024
    const stopTree = (): void => {
      if (!child.pid) return
      if (process.platform === 'win32') {
        execFile('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true }, () => undefined)
      } else {
        try {
          process.kill(-child.pid, 'SIGKILL')
        } catch {
          child.kill('SIGKILL')
        }
      }
    }
    const timeout = setTimeout(() => {
      failure = new Error('syncpack timed out after 30 seconds')
      stopTree()
    }, 30_000)
    const append = (target: 'stdout' | 'stderr', chunk: Buffer): void => {
      if (target === 'stdout') stdout += chunk.toString('utf8')
      else stderr += chunk.toString('utf8')
      if (stdout.length + stderr.length > maxOutput && !failure) {
        failure = new Error('syncpack output exceeded 10 MiB')
        stopTree()
      }
    }
    child.stdout.on('data', (chunk: Buffer) => append('stdout', chunk))
    child.stderr.on('data', (chunk: Buffer) => append('stderr', chunk))
    child.on('error', (error) => {
      clearTimeout(timeout)
      if (!settled) {
        settled = true
        reject(new Error(`syncpack failed to start: ${error.message}`))
      }
    })
    child.on('close', (code) => {
      clearTimeout(timeout)
      if (settled) return
      settled = true
      if (failure) reject(failure)
      else if (code === 0 || code === 1) resolve(stdout)
      else reject(new Error(`syncpack failed with exit code ${String(code)}: ${stderr.trim()}`))
    })
  })
}

async function auditVersionDrift(root: string, rules: ResolvedRule[]): Promise<OrganizerViolation[]> {
  const rule = enabledRule(rules, 'dependencies/version-drift')
  if (!rule || !await pathExists(join(root, 'package.json'))) return []
  // Lazy by design: syncpack's platform binary runs only when audit is invoked.
  const output = await runSyncpack(root)
  const violations: OrganizerViolation[] = []
  for (const line of output.split(/\r?\n/).filter(Boolean)) {
    let row: SyncpackRow
    try {
      row = JSON.parse(line) as SyncpackRow
    } catch {
      throw new Error(`syncpack returned invalid JSON: ${line.slice(0, 120)}`)
    }
    if (row.statusType === 'Valid' || typeof row.package !== 'string' || typeof row.dependency !== 'string') continue
    const projectPath = toPosix(relative(root, row.package))
    const actual = typeof row.actual?.raw === 'string' ? row.actual.raw : 'unknown'
    const expected = typeof row.expected?.raw === 'string' ? row.expected.raw : 'unknown'
    violations.push({
      rule: rule.id,
      path: projectPath,
      detail: `${row.dependency} uses ${actual}; syncpack expects ${expected} (${String(row.statusCode)}).`,
      cite: rule.cite
    })
  }
  return violations
}

export async function organizerAudit(inputRoot: string): Promise<OrganizerViolation[]> {
  const root = await resolveOrganizerRoot(inputRoot)
  const rules = await resolveRules(root)
  const tree = await listTree(root)
  const violations = [
    ...auditNativeRules(tree, rules),
    ...await auditDependencyGraph(root, rules),
    ...await auditVersionDrift(root, rules)
  ]
  return violations.sort((left, right) =>
    left.rule.localeCompare(right.rule) || left.path.localeCompare(right.path)
  )
}

export { listTree }
