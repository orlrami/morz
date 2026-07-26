import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { afterEach, test } from 'node:test'
import { createConfigWriter, ConfigWriterError } from './config-writer'
import { createContextHubService } from './context-hub'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function tempProject(name: string): string {
  const root = mkdtempSync(join(tmpdir(), `morz-context-${name}-`))
  roots.push(root)
  return root
}

function git(root: string, args: string[], env?: NodeJS.ProcessEnv): string {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, ...env }
  }).trim()
}

function commitSourceHistory(root: string, count: number): void {
  mkdirSync(join(root, 'src'), { recursive: true })
  git(root, ['init'])
  for (let index = 1; index <= count; index += 1) {
    writeFileSync(join(root, 'src', 'index.ts'), `export const version = ${index}\n`)
    git(root, ['add', 'src/index.ts'])
    const date = new Date(Date.UTC(2026, 0, index, 12)).toISOString()
    git(
      root,
      ['-c', 'user.name=Morz E2E', '-c', 'user.email=morz@example.invalid', 'commit', '-m', `src ${index}`],
      { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date }
    )
  }
}

test('scan reports fixed candidates, project type, missing files, and the 20-commit stale cutoff', async () => {
  const root = tempProject('scan')
  writeFileSync(join(root, 'package.json'), '{"name":"fixture"}\n')
  mkdirSync(join(root, 'docs'))
  writeFileSync(join(root, 'docs', 'AGENTS.md'), '# Agents\n')
  writeFileSync(join(root, 'STATUS.md'), '# Status\n')
  commitSourceHistory(root, 20)

  const old = new Date(Date.UTC(2025, 0, 1))
  const fresh = new Date(Date.UTC(2026, 1, 1))
  utimesSync(join(root, 'docs', 'AGENTS.md'), old, old)
  utimesSync(join(root, 'STATUS.md'), fresh, fresh)

  const service = createContextHubService()
  const matrix = await service.scan([{ id: 'fixture', name: 'Fixture', root }])
  const space = matrix.spaces[0]

  assert.equal(space.projectType, 'node')
  assert.equal(space.files.length, 9)
  assert.deepEqual(
    space.files.map((file) => file.kind),
    ['claude', 'agents', 'gemini', 'status', 'readme', 'claude-settings', 'mcp', 'codex-config', 'opencode']
  )
  assert.equal(space.files.find((file) => file.kind === 'claude')?.state, 'missing')
  assert.equal(space.files.find((file) => file.kind === 'agents')?.state, 'stale')
  assert.equal(space.files.find((file) => file.kind === 'agents')?.relativePath, 'docs/AGENTS.md')
  assert.equal(space.files.find((file) => file.kind === 'status')?.state, 'present')
  assert.equal(space.staleCutoffAt, '2026-01-01T12:00:00.000Z')
})

test('scan detects Python projects and does not recurse outside known locations', async () => {
  const root = tempProject('python')
  writeFileSync(join(root, 'pyproject.toml'), '[project]\nname = "fixture"\n')
  mkdirSync(join(root, 'nested', 'deep'), { recursive: true })
  writeFileSync(join(root, 'nested', 'deep', 'CLAUDE.md'), '# Hidden from fixed scanner\n')

  const service = createContextHubService()
  const matrix = await service.scan([{ id: 'python', name: 'Python', root }])
  const space = matrix.spaces[0]

  assert.equal(space.projectType, 'python')
  assert.equal(space.files.find((file) => file.kind === 'claude')?.state, 'missing')
  assert.equal(matrix.scannedAt.length > 0, true)
})

test('scan detects rust and go projects, outranking a sidecar package.json', async () => {
  const service = createContextHubService()

  const rustRoot = tempProject('rust')
  writeFileSync(join(rustRoot, 'Cargo.toml'), '[package]\nname = "fixture"\n')
  writeFileSync(join(rustRoot, 'package.json'), '{"name":"docs-site"}\n')
  const rust = await service.scan([{ id: 'rust', name: 'Rust', root: rustRoot }])
  assert.equal(rust.spaces[0].projectType, 'rust')

  const goRoot = tempProject('go')
  writeFileSync(join(goRoot, 'go.mod'), 'module fixture\n')
  const go = await service.scan([{ id: 'go', name: 'Go', root: goRoot }])
  assert.equal(go.spaces[0].projectType, 'go')
})

test('scan rejects malformed or non-directory roots', async () => {
  const root = tempProject('invalid')
  const file = join(root, 'not-a-directory')
  writeFileSync(file, 'nope')
  const service = createContextHubService()

  await assert.rejects(
    service.scan([{ id: 'bad', name: 'Bad', root: 'relative/path' }]),
    /absolute/
  )
  await assert.rejects(
    service.scan([{ id: 'bad', name: 'Bad', root: file }]),
    /directory/
  )
})

// w16 — space-store roots are the authority; the scan path enforces the same
// structural hygiene as fs:list instead of a picker-only allowlist.
test('scan rejects roots that fail path hygiene (traversal, nonexistent)', async () => {
  const good = tempProject('hygiene')
  const service = createContextHubService()

  await service.scan([{ id: 'good', name: 'Good', root: good }])
  await assert.rejects(
    service.scan([{ id: 'traversal', name: 'Traversal', root: `..${sep}..${sep}etc` }]),
    /absolute/
  )
  await assert.rejects(
    service.scan([{ id: 'ghost', name: 'Ghost', root: join(good, 'does-not-exist') }]),
    /does not exist/
  )
})

test('scan fails closed when a known context file is a symbolic link', async (t) => {
  const root = tempProject('symlink')
  const outside = tempProject('symlink-target')
  const target = join(outside, 'CLAUDE.md')
  writeFileSync(target, '# Outside\n')
  try {
    symlinkSync(target, join(root, 'CLAUDE.md'), 'file')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EPERM') {
      t.skip('Windows symbolic-link creation is not permitted for this user')
      return
    }
    throw error
  }

  await assert.rejects(
    createContextHubService().scan([{ id: 'fixture', name: 'Fixture', root }]),
    /symbolic link/
  )
})

test('context file proposals reject a Windows junction that escapes the space root', async (t) => {
  if (process.platform !== 'win32') {
    t.skip('Windows junction coverage')
    return
  }
  const root = tempProject('junction')
  const outside = tempProject('junction-target')
  writeFileSync(join(outside, 'CLAUDE.md'), '# Outside\n')
  try {
    symlinkSync(outside, join(root, 'docs'), 'junction')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EPERM') {
      t.skip('Windows junction creation is not permitted for this user')
      return
    }
    throw error
  }

  const writer = createConfigWriter()
  await assert.rejects(
    writer.proposeFile(
      join(root, 'docs', 'CLAUDE.md'),
      '# Replaced\n',
      'Fixture / CLAUDE.md',
      '# Outside\n',
      root
    ),
    /symbolic link|junction|escaped/
  )
  await assert.rejects(
    writer.proposeFile(
      join(root, 'docs', 'STATUS.md'),
      '# Status\n',
      'Fixture / STATUS.md',
      '',
      root
    ),
    /symbolic link|junction|escaped/
  )
})

test('config writer proposes and exclusively creates a missing context file', async () => {
  const root = tempProject('proposal-create')
  const path = join(root, 'CLAUDE.md')
  const writer = createConfigWriter()

  const proposal = await writer.proposeFile(path, '# Project context\n', 'Fixture / CLAUDE.md')

  assert.equal(proposal.path, path)
  assert.equal(proposal.label, 'Fixture / CLAUDE.md')
  assert.match(proposal.unifiedDiff, /Project context/)
  const result = await writer.applyFile(proposal.proposalId)
  assert.deepEqual(result, { path, backupPath: null, created: true })
})

test('config writer file proposals fail closed after a concurrent edit', async () => {
  const root = tempProject('proposal-race')
  const path = join(root, 'STATUS.md')
  writeFileSync(path, '# Before\n')
  const writer = createConfigWriter()
  const proposal = await writer.proposeFile(path, '# Proposed\n', 'Fixture / STATUS.md')
  writeFileSync(path, '# User edit\n')

  await assert.rejects(
    writer.applyFile(proposal.proposalId),
    (error: unknown) => error instanceof ConfigWriterError && error.code === 'CONFIG_CHANGED'
  )
})

test('missing CLAUDE.md is proposed from the detected project template before creation', async () => {
  const root = tempProject('template')
  writeFileSync(join(root, 'package.json'), '{"name":"fixture"}\n')
  const service = createContextHubService({
    templatesRoot: join(process.cwd(), 'resources', 'context-templates')
  })
  await service.scan([{ id: 'fixture', name: 'Fixture App', root }])

  // w16.1 presets: AGENTS.md is the interpolated source of truth; CLAUDE.md is
  // the cross-CLI shim whose first line imports it (research-backed presets).
  const agents = await service.proposeTemplate({ spaceId: 'fixture', kind: 'agents' })
  assert.match(agents.unifiedDiff, /Fixture App/)
  assert.match(agents.unifiedDiff, /Non-negotiables/)

  const proposal = await service.proposeTemplate({ spaceId: 'fixture', kind: 'claude' })
  assert.match(proposal.unifiedDiff, /@AGENTS\.md/)
  assert.equal(readFileSync(join(root, 'package.json'), 'utf8'), '{"name":"fixture"}\n')
  const applied = await service.applyProposal(proposal.proposalId)
  assert.equal(applied.created, true)
  assert.match(readFileSync(join(root, 'CLAUDE.md'), 'utf8'), /@AGENTS\.md/)
})

test('proposal ids stay scoped to the service that produced them', async () => {
  const root = tempProject('proposal-owner')
  const writer = createConfigWriter()
  const owner = createContextHubService({
    writer,
    templatesRoot: join(process.cwd(), 'resources', 'context-templates')
  })
  const otherSender = createContextHubService({ writer })
  await owner.scan([{ id: 'fixture', name: 'Fixture', root }])
  await otherSender.scan([{ id: 'fixture', name: 'Fixture', root }])
  const proposal = await owner.proposeTemplate({ spaceId: 'fixture', kind: 'claude' })

  await assert.rejects(
    otherSender.applyProposal(proposal.proposalId),
    /missing or expired/
  )
  assert.equal((await owner.applyProposal(proposal.proposalId)).created, true)
})

test('a shared block across two spaces creates two individual idempotent proposals', async () => {
  const first = tempProject('block-first')
  const second = tempProject('block-second')
  writeFileSync(join(first, 'CLAUDE.md'), '# First\n')
  writeFileSync(join(second, 'CLAUDE.md'), '# Second\n')
  const service = createContextHubService()
  await service.scan([
    { id: 'first', name: 'First', root: first },
    { id: 'second', name: 'Second', root: second }
  ])

  const proposals = await service.proposeSharedBlock({
    name: 'quality',
    content: '## Quality gate\n\nRun the targeted tests before shipping.',
    spaceIds: ['first', 'second'],
    kind: 'claude'
  })

  assert.equal(proposals.length, 2)
  assert.notEqual(proposals[0].proposalId, proposals[1].proposalId)
  for (const proposal of proposals) {
    assert.match(proposal.unifiedDiff, /<!-- morz:block:quality -->/)
    await service.applyProposal(proposal.proposalId)
  }

  const repeated = await service.proposeSharedBlock({
    name: 'quality',
    content: '## Quality gate\n\nRun the targeted tests before shipping.',
    spaceIds: ['first', 'second'],
    kind: 'claude'
  })
  assert.equal(repeated.length, 2)
  assert.equal((readFileSync(join(first, 'CLAUDE.md'), 'utf8').match(/morz:block:quality/g) ?? []).length, 1)
  assert.equal((readFileSync(join(second, 'CLAUDE.md'), 'utf8').match(/morz:block:quality/g) ?? []).length, 1)
})

test('different named shared blocks coexist without ambiguous marker replacement', async () => {
  const root = tempProject('block-multiple')
  writeFileSync(
    join(root, 'CLAUDE.md'),
    '# Fixture\n\n<!-- morz:block:alpha -->\nAlpha\n<!-- /morz:block -->\n'
  )
  const service = createContextHubService()
  await service.scan([{ id: 'fixture', name: 'Fixture', root }])

  const [proposal] = await service.proposeSharedBlock({
    name: 'beta',
    content: 'Beta',
    spaceIds: ['fixture'],
    kind: 'claude'
  })
  await service.applyProposal(proposal.proposalId)

  const content = readFileSync(join(root, 'CLAUDE.md'), 'utf8')
  assert.match(content, /morz:block:alpha/)
  assert.match(content, /morz:block:beta/)
  assert.equal((content.match(/<!-- \/morz:block -->/g) ?? []).length, 2)
})

test('memory export replaces one managed CLAUDE.md block and re-proposes deterministically', async () => {
  const root = tempProject('memory')
  writeFileSync(join(root, 'CLAUDE.md'), '# Fixture\n')
  let title = 'Prefer focused tests'
  const service = createContextHubService({
    listMemories: () => [
      {
        id: 'focused-tests',
        scope: 'global',
        kind: 'rule',
        title,
        body: 'Run the narrow test first, then the full verification gate.',
        origin: 'user',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-02T00:00:00.000Z',
        enabled: true
      }
    ]
  })
  await service.scan([{ id: 'fixture', name: 'Fixture', root }])

  const [first] = await service.proposeMemoryBlock({ spaceIds: ['fixture'] })
  const [same] = await service.proposeMemoryBlock({ spaceIds: ['fixture'] })
  assert.equal(first.unifiedDiff, same.unifiedDiff)
  assert.notEqual(first.proposalId, same.proposalId)
  await service.applyProposal(first.proposalId)

  title = 'Prefer focused tests before broad verification'
  const [updated] = await service.proposeMemoryBlock({ spaceIds: ['fixture'] })
  assert.match(updated.unifiedDiff, /Prefer focused tests before broad verification/)
  await service.applyProposal(updated.proposalId)

  const content = readFileSync(join(root, 'CLAUDE.md'), 'utf8')
  assert.equal((content.match(/<!-- morz:memory -->/g) ?? []).length, 1)
  assert.equal((content.match(/<!-- \/morz:memory -->/g) ?? []).length, 1)
  assert.doesNotMatch(content, /\nPrefer focused tests\n/)
})

test('memory export neutralizes paired, unpaired, and nested Morz control markers', async () => {
  const root = tempProject('memory-markers')
  writeFileSync(join(root, 'CLAUDE.md'), '# Fixture\n')
  const service = createContextHubService({
    listMemories: () => [
      {
        id: 'marker-memory',
        scope: 'global',
        kind: 'rule',
        title: '<!-- morz:block:title -->',
        body: [
          '<!-- morz:block:paired -->',
          'inside',
          '<!-- /morz:block -->',
          '<!-- morz:block:unpaired -->',
          '<!-- morz:memory -->nested<!-- /morz:memory -->'
        ].join('\n'),
        origin: 'user',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-02T00:00:00.000Z',
        enabled: true
      }
    ]
  })
  await service.scan([{ id: 'fixture', name: 'Fixture', root }])

  const [memory] = await service.proposeMemoryBlock({ spaceIds: ['fixture'] })
  await service.applyProposal(memory.proposalId)
  const [shared] = await service.proposeSharedBlock({
    name: 'safe',
    content: 'Safe shared content',
    spaceIds: ['fixture'],
    kind: 'claude'
  })
  await service.applyProposal(shared.proposalId)

  const content = readFileSync(join(root, 'CLAUDE.md'), 'utf8')
  assert.equal((content.match(/<!-- morz:memory -->/g) ?? []).length, 1)
  assert.equal((content.match(/<!-- morz:block:safe -->/g) ?? []).length, 1)
  assert.doesNotMatch(content, /<!-- morz:block:(?:title|paired|unpaired) -->/)
})

test('status upkeep proposes a deterministic managed block from verified branch, run, and E2E data', async () => {
  const root = tempProject('status-upkeep')
  writeFileSync(join(root, 'STATUS.md'), '# Project status\n')
  const service = createContextHubService({
    statusSnapshot: async () => ({
      branch: 'w15/context-hub',
      recentRuns: [
        {
          runId: 'run-1',
          goal: 'Run context E2E',
          state: 'done',
          createdAt: '2026-07-24T12:00:00.000Z'
        }
      ],
      e2eState: 'done — Run context E2E'
    })
  })
  await service.scan([{ id: 'fixture', name: 'Fixture', root }])

  const [proposal] = await service.proposeStatusBlock({ spaceIds: ['fixture'] })

  assert.match(proposal.unifiedDiff, /<!-- morz:status -->/)
  assert.match(proposal.unifiedDiff, /Branch: `w15\/context-hub`/)
  assert.match(proposal.unifiedDiff, /done — Run context E2E/)
  assert.equal(readFileSync(join(root, 'STATUS.md'), 'utf8'), '# Project status\n')
})
