import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { organizerAudit, resolveSyncpackBinary } from './audit'

const roots: string[] = []

after(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })))
})

test('Windows packaging unpacks syncpack platform packages', async () => {
  const config = await readFile(join(process.cwd(), 'electron-builder.yml'), 'utf8')
  assert.match(config, /asarUnpack:[\s\S]*node_modules\/syncpack\*\/\*\*/)
})

test('syncpack binary resolution rewrites an app.asar result to app.asar.unpacked', () => {
  const resourcesPath = 'C:\\Program Files\\Morz\\resources'
  const packageJson = join(resourcesPath, 'app.asar', 'node_modules', 'syncpack-windows-x64', 'package.json')

  const binary = resolveSyncpackBinary({
    packageName: 'syncpack-windows-x64',
    binaryName: 'syncpack.exe',
    appPath: join(resourcesPath, 'app.asar'),
    resourcesPath,
    resolvePackage: () => packageJson
  })

  assert.equal(
    binary,
    join(resourcesPath, 'app.asar.unpacked', 'node_modules', 'syncpack-windows-x64', 'bin', 'syncpack.exe')
  )
})

test('syncpack binary resolution retries from the unpacked application root', () => {
  const resourcesPath = 'C:\\Program Files\\Morz\\resources'
  const unpackedRoot = join(resourcesPath, 'app.asar.unpacked')
  const attempts: Array<string[] | undefined> = []

  const binary = resolveSyncpackBinary({
    packageName: 'syncpack-windows-x64',
    binaryName: 'syncpack.exe',
    appPath: join(resourcesPath, 'app.asar'),
    resourcesPath,
    resolvePackage: (_request, options) => {
      attempts.push(options?.paths)
      if (options?.paths?.includes(unpackedRoot)) {
        return join(unpackedRoot, 'node_modules', 'syncpack-windows-x64', 'package.json')
      }
      throw Object.assign(new Error('package.json ENOENT'), { code: 'ENOENT' })
    }
  })

  assert.equal(binary, join(unpackedRoot, 'node_modules', 'syncpack-windows-x64', 'bin', 'syncpack.exe'))
  assert.ok(attempts.some((paths) => paths?.includes(unpackedRoot)))
})

test('optional audit ENOENT failures preserve native findings and degrade without raw errors', async () => {
  const root = await mkdtemp(join(tmpdir(), 'morz-organizer-audit-'))
  roots.push(root)
  const unavailable = Object.assign(new Error('spawn syncpack.exe ENOENT'), { code: 'ENOENT' })

  const violations = await organizerAudit(root, {
    auditDependencyGraph: async () => { throw unavailable },
    auditVersionDrift: async () => { throw unavailable }
  })

  assert.ok(violations.some((violation) => violation.rule === 'required-file/readme'))
  assert.ok(violations.some((violation) => violation.rule === 'required-file/license'))
  const skipped = violations.filter((violation) => violation.detail.startsWith('Skipped'))
  assert.equal(skipped.length, 2)
  assert.ok(skipped.every((violation) => violation.detail === 'Skipped — this check could not run here.'))
  assert.ok(violations.every((violation) => !/ENOENT|syncpack\.exe/i.test(violation.detail)))
})

test('audit setup failures become clean notices without raw filesystem errors', async () => {
  const root = await mkdtemp(join(tmpdir(), 'morz-organizer-audit-'))
  roots.push(root)
  const unavailable = Object.assign(new Error('readdir ENOENT C:\\private\\missing'), { code: 'ENOENT' })

  await assert.rejects(
    organizerAudit(root, { listTree: async () => { throw unavailable } }),
    (error: Error) => {
      assert.equal(error.message, 'Organizer audit could not read this folder.')
      assert.doesNotMatch(error.message, /ENOENT|C:\\private/i)
      return true
    }
  )
})

test('unexpected audit setup exceptions are also replaced by a clean notice', async () => {
  const root = await mkdtemp(join(tmpdir(), 'morz-organizer-audit-'))
  roots.push(root)

  await assert.rejects(
    organizerAudit(root, {
      resolveRules: async () => { throw new TypeError('Cannot read properties of undefined') }
    }),
    (error: Error) => {
      assert.equal(error.message, 'Organizer audit could not load rules for this folder.')
      assert.doesNotMatch(error.message, /TypeError|undefined/i)
      return true
    }
  )
})
