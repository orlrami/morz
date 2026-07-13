import { expect, test } from '@playwright/test'
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { parse as parseJsonc } from 'jsonc-parser'
import { parse as parseToml } from 'smol-toml'
import {
  ConfigWriterError,
  createConfigWriter,
  type ConfigWriterPaths
} from '../src/main/services/config-writer'

const fixtureRoot = join(process.cwd(), 'e2e', 'fixtures', 'configs')
const installSpec = {
  name: 'fixture-server',
  command: 'npx',
  args: ['-y', '@fixture/mcp'],
  env: { FIXTURE_KEY: 'fixture-value' }
}

async function copyFixture(source: string, destination: string): Promise<void> {
  await writeFile(destination, await readFile(source))
}

async function createFixturePaths(): Promise<ConfigWriterPaths> {
  const root = await mkdtemp(join(tmpdir(), 'morz-config-writer-'))
  const paths = {
    claude: join(root, '.mcp.json'),
    codex: join(root, 'config.toml'),
    opencode: join(root, 'opencode.json')
  } satisfies ConfigWriterPaths

  await Promise.all([
    copyFixture(join(fixtureRoot, 'claude', '.mcp.json'), paths.claude),
    copyFixture(join(fixtureRoot, 'codex', 'config.toml'), paths.codex),
    copyFixture(join(fixtureRoot, 'opencode', 'opencode.json'), paths.opencode)
  ])
  return paths
}

test('detect reports only config files that exist', async () => {
  const paths = await createFixturePaths()
  const missingOpenCode = join(dirname(paths.opencode), 'missing-opencode.json')
  const writer = createConfigWriter({ paths: { ...paths, opencode: missingOpenCode } })

  await expect(writer.detect()).resolves.toEqual([
    { target: 'claude', path: paths.claude },
    { target: 'codex', path: paths.codex }
  ])
})

test('propose returns reviewable unified diffs without changing files', async () => {
  const paths = await createFixturePaths()
  const writer = createConfigWriter({ paths })
  const before = await Promise.all(Object.values(paths).map((path) => readFile(path, 'utf8')))

  const proposals = await writer.propose(installSpec, ['claude', 'codex', 'opencode'])

  expect(proposals).toHaveLength(3)
  for (const proposal of proposals) {
    expect(proposal.proposalId).toMatch(/^[a-f0-9-]+$/)
    expect(proposal.hash).toMatch(/^[a-f0-9]{64}$/)
    expect(proposal.unifiedDiff).toContain('fixture-server')
    expect(proposal.unifiedDiff).toContain('--- ')
    expect(proposal.unifiedDiff).toContain('+++ ')
  }
  await expect(Promise.all(Object.values(paths).map((path) => readFile(path, 'utf8')))).resolves.toEqual(before)
})

test('apply merges all formats, preserves existing keys, and creates adjacent backups', async () => {
  const paths = await createFixturePaths()
  const writer = createConfigWriter({ paths, now: () => new Date('2026-07-13T12:34:56.789Z') })
  const originals = new Map(
    await Promise.all(Object.values(paths).map(async (path) => [path, await readFile(path, 'utf8')] as const))
  )
  const proposals = await writer.propose(installSpec, ['claude', 'codex', 'opencode'])

  const results = await Promise.all(proposals.map((proposal) => writer.apply(proposal.proposalId)))

  for (const result of results) {
    expect(result.backupPath).toBe(`${result.path}.morz-backup-20260713T123456789Z`)
    await expect(readFile(result.backupPath, 'utf8')).resolves.toBe(originals.get(result.path))
  }

  const claude = parseJsonc(await readFile(paths.claude, 'utf8'))
  expect(claude.projectSetting).toBe('keep-me')
  expect(claude.mcpServers.existing.args).toEqual(['--existing'])
  expect(claude.mcpServers['fixture-server']).toEqual({
    command: 'npx',
    args: ['-y', '@fixture/mcp'],
    env: { FIXTURE_KEY: 'fixture-value' }
  })

  const codex = parseToml(await readFile(paths.codex, 'utf8')) as Record<string, any>
  expect(codex.model).toBe('fixture-model')
  expect(codex.features.fixture_feature).toBe(true)
  expect(codex.mcp_servers.existing.command).toBe('existing-command')
  expect(codex.mcp_servers['fixture-server']).toEqual({
    command: 'npx',
    args: ['-y', '@fixture/mcp'],
    env: { FIXTURE_KEY: 'fixture-value' }
  })

  const opencode = parseJsonc(await readFile(paths.opencode, 'utf8'))
  expect(await readFile(paths.opencode, 'utf8')).toContain('Fixture comment must survive')
  expect(opencode.$schema).toBe('https://opencode.ai/config.json')
  expect(opencode.permission.bash).toBe('ask')
  expect(opencode.mcp.existing.enabled).toBe(false)
  expect(opencode.mcp['fixture-server']).toEqual({
    type: 'local',
    command: ['npx', '-y', '@fixture/mcp'],
    enabled: true,
    environment: { FIXTURE_KEY: 'fixture-value' }
  })
})

test('apply aborts if the source mtime changes after propose', async () => {
  const paths = await createFixturePaths()
  const writer = createConfigWriter({ paths })
  const [proposal] = await writer.propose(installSpec, ['claude'])
  const originalStat = await stat(paths.claude)

  await writeFile(paths.claude, `${await readFile(paths.claude, 'utf8')}\n`)
  const changedStat = await stat(paths.claude)
  expect(changedStat.mtimeMs).not.toBe(originalStat.mtimeMs)

  await expect(writer.apply(proposal.proposalId)).rejects.toMatchObject<Partial<ConfigWriterError>>({
    code: 'CONFIG_CHANGED',
    message: expect.stringMatching(/re-propose/i)
  })
  await expect(readFile(paths.claude, 'utf8')).resolves.toContain('\n\n')
})

test('propose fails closed when an MCP container has the wrong shape', async () => {
  const paths = await createFixturePaths()
  const invalid = '{\n  "mcpServers": "do-not-replace"\n}\n'
  await writeFile(paths.claude, invalid)
  const writer = createConfigWriter({ paths })

  await expect(writer.propose(installSpec, ['claude'])).rejects.toMatchObject<Partial<ConfigWriterError>>({
    code: 'CONFIG_INVALID'
  })
  await expect(readFile(paths.claude, 'utf8')).resolves.toBe(invalid)
})
