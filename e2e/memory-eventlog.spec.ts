import { expect, test } from '@playwright/test'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import type { MemoryInvocationEvent } from '../src/main/memory/event-log'
import type { MorzMemoryApi } from '../src/shared/memory'
import { closeMorz, launchMorz, ROOT, type MorzApp } from './app'

interface EventLogMemoryApi extends MorzMemoryApi {
  testLog(event: MemoryInvocationEvent): Promise<boolean>
}

interface EventLogWindow {
  morz: {
    memory: EventLogMemoryApi
    claude: {
      start(opts: { agentId: string; cwd: string }): Promise<{ agentId: string }>
      send(agentId: string, text: string): void
    }
  }
}

test.describe.serial('Memory invocation event log', () => {
  let morz: MorzApp
  const fixtureRoot = join(ROOT, 'e2e', '.tmp', `memory-eventlog-${Date.now()}`)
  const fakeBin = join(fixtureRoot, 'bin')

  test.beforeAll(async () => {
    mkdirSync(fakeBin, { recursive: true })
    writeFileSync(
      join(fakeBin, 'fake-claude.cjs'),
      [
        "process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'eventlog-e2e', model: 'stub' }) + '\\n')",
        "process.stdin.setEncoding('utf8')",
        "let buffer = ''",
        "process.stdin.on('data', (chunk) => {",
        '  buffer += chunk',
        "  if (!buffer.includes('\\n')) return",
        "  process.stdout.write(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tool-1', name: 'Read', input: { file_path: 'C:\\\\Users\\\\builder\\\\.env' } }] } }) + '\\n')",
        "  process.stdout.write(JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tool-1', is_error: false, content: 'secret file contents' }] } }) + '\\n')",
        "  process.stdout.write(JSON.stringify({ type: 'result', is_error: false, duration_ms: 25, total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 } }) + '\\n')",
        '  setTimeout(() => process.exit(0), 25)',
        '})'
      ].join('\n'),
      'utf8'
    )
    writeFileSync(
      join(fakeBin, 'claude.cmd'),
      `@echo off\r\n"${process.execPath}" "%~dp0fake-claude.cjs" %*\r\n`,
      'utf8'
    )
    morz = await launchMorz({
      env: {
        MORZ_E2E: '1',
        MORZ_E2E_MEMORY_EVENT_LOG: '1',
        PATH: `${fakeBin}${delimiter}${process.env.PATH ?? ''}`
      }
    })
  })

  test.afterAll(async () => {
    if (morz) await closeMorz(morz.app)
    rmSync(fixtureRoot, { recursive: true, force: true })
  })

  test('Manual mode creates no event file', async () => {
    const stats = await morz.page.evaluate(() =>
      (window as unknown as EventLogWindow).morz.memory.eventLogStats()
    )
    expect(stats).toEqual({ count: 0, bytes: 0 })
    expect(existsSync(join(morz.appDataDir, 'Morz', 'memory-events.jsonl'))).toBe(false)
  })

  test('events of every type leave memory proposals byte-identical', async () => {
    const before = await morz.page.evaluate(() =>
      (window as unknown as EventLogWindow).morz.memory.proposals()
    )
    const types: MemoryInvocationEvent['event'][] = [
      'spawn',
      'exit',
      'tool',
      'block',
      'interrupt'
    ]
    for (const [index, event] of types.entries()) {
      await morz.page.evaluate(
        ({ type, ts }) => (window as unknown as EventLogWindow).morz.memory.testLog({
          v: 1,
          ts,
          sessionKind: 'planner',
          cli: 'claude',
          event: type,
          outcome: 'unknown'
        }),
        { type: event, ts: Date.now() + index }
      )
    }
    const after = await morz.page.evaluate(() =>
      (window as unknown as EventLogWindow).morz.memory.proposals()
    )
    expect(JSON.stringify(after)).toBe(JSON.stringify(before))
    await morz.page.evaluate(() =>
      (window as unknown as EventLogWindow).morz.memory.clearEventLog()
    )
  })

  test('stubbed Claude lane logs spawn, structured tool outcome, and exit', async () => {
    await morz.page.evaluate(
      async (cwd) => {
        const api = (window as unknown as EventLogWindow).morz.claude
        await api.start({ agentId: 'eventlog-builder', cwd })
        api.send('eventlog-builder', 'Run the fixture tool.')
      },
      fixtureRoot
    )

    await expect.poll(async () =>
      morz.page.evaluate(() =>
        (window as unknown as EventLogWindow).morz.memory.eventLogStats()
      ).then((stats) => stats.count)
    ).toBeGreaterThanOrEqual(4)

    const path = join(morz.appDataDir, 'Morz', 'memory-events.jsonl')
    const events = readFileSync(path, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as MemoryInvocationEvent)
    expect(events.some((event) => event.event === 'spawn' && event.sessionKind === 'lane')).toBe(true)
    expect(events.some((event) =>
      event.event === 'tool' && event.name === 'Read' && event.outcome === 'ok'
    )).toBe(true)
    expect(events.some((event) => event.event === 'exit' && event.outcome === 'ok')).toBe(true)
    expect(readFileSync(path, 'utf8')).not.toContain('secret file contents')
    expect(readFileSync(path, 'utf8')).not.toContain('.env')
  })

  test('Memory settings shows counters and Clear empties the log', async () => {
    await morz.page.getByRole('button', { name: 'Settings' }).click()
    await morz.page.getByRole('button', { name: 'Memory', exact: true }).click()
    const settings = morz.page.getByRole('region', { name: 'Learning memory' })
    await expect(settings.getByText(/\d+ events logged · \d+\.\d{2} MB/)).toBeVisible()

    await settings.getByRole('button', { name: 'Clear memory event log' }).click()

    await expect(settings.getByText('0 events logged · 0.00 MB', { exact: true })).toBeVisible()
    expect(existsSync(join(morz.appDataDir, 'Morz', 'memory-events.jsonl'))).toBe(false)
  })
})
