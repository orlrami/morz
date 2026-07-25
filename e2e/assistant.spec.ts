import { expect, test } from '@playwright/test'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { closeMorz, launchMorz, ROOT, type MorzApp } from './app'

test.describe.serial('Bring-your-own assistant', () => {
  let morz: MorzApp
  const fakeBin = join(ROOT, 'e2e', '.tmp', 'assistant-cli')
  const injectionMarker = join(ROOT, 'assistant-injected.txt')
  let originalPath = ''

  test.beforeAll(async () => {
    process.env.MORZ_E2E = '1'
    originalPath = process.env.PATH ?? ''
    rmSync(fakeBin, { recursive: true, force: true })
    rmSync(injectionMarker, { force: true })
    const packageRoot = join(fakeBin, 'node_modules', 'openclaw')
    mkdirSync(packageRoot, { recursive: true })
    writeFileSync(
      join(fakeBin, 'openclaw.cmd'),
      '@ECHO OFF\r\nnode "%~dp0\\node_modules\\openclaw\\cli.js" %*\r\n'
    )
    writeFileSync(
      join(packageRoot, 'package.json'),
      JSON.stringify({ name: 'openclaw', bin: { openclaw: 'cli.js' } })
    )
    writeFileSync(
      join(packageRoot, 'cli.js'),
      String.raw`const args = process.argv.slice(2)
if (args[0] === 'status') {
  process.stdout.write('{"ok":true}')
  process.exit(0)
}
const prompt = args[args.indexOf('--prompt') + 1] || ''
const field = (name) => JSON.parse(prompt.match(new RegExp('^- ' + name + ': exactly (.+)$', 'm'))[1])
const id = field('id')
const goal = field('goal')
const plan = {
  version: '1.0', id, goal,
  agents: [{ agentId: 'safe-openclaw', cli: 'codex', role: 'Planner', branch: 'run/openclaw/' + id.slice(0, 8), worktree: null, cwd: '', promptSeed: goal, dependsOn: [], port: null }],
  spaceRoot: field('spaceRoot'), caps: { maxUsd: null, maxTokens: null }, createdAt: field('createdAt'), planHash: '0'.repeat(64)
}
process.stdout.write(JSON.stringify({ ok: true, outputs: [{ text: '\`\`\`json\n' + JSON.stringify(plan) + '\n\`\`\`' }] }))
`
    )
    process.env.PATH = `${fakeBin}${delimiter}${originalPath}`
    morz = await launchMorz()
  })

  test.afterAll(async () => {
    delete process.env.MORZ_E2E
    process.env.PATH = originalPath
    if (morz) await closeMorz(morz.app)
    rmSync(fakeBin, { recursive: true, force: true })
    rmSync(injectionMarker, { force: true })
  })

  test('is inert in Manual and proposes an approval-gated plan through the stub', async () => {
    const { page, app } = morz

    await page.getByRole('button', { name: 'Settings' }).evaluate((button: HTMLButtonElement) => button.click())
    await page.getByRole('button', { name: 'Planner' }).click()

    await expect(page.getByRole('textbox', { name: 'Ask your assistant' })).toHaveCount(0)
    const before = await app.evaluate(() =>
      (globalThis as unknown as { __morzAssistantCalls?: number }).__morzAssistantCalls ?? 0
    )
    expect(before).toBe(0)

    await page.getByRole('radio', { name: 'Orchestrated' }).click()
    await expect(page.getByRole('textbox', { name: 'Ask your assistant' })).toHaveCount(0)
    const notConfigured = await app.evaluate(() =>
      (globalThis as unknown as { __morzAssistantCalls?: number }).__morzAssistantCalls ?? 0
    )
    expect(notConfigured).toBe(0)

    await page.getByLabel('Assistant provider').selectOption('stub')
    await page.getByRole('button', { name: 'Connect assistant' }).click()
    await expect(page.getByText('Connected', { exact: true })).toBeVisible()

    await page.getByRole('textbox', { name: 'Ask your assistant' }).fill('Ship the assistant bridge safely')
    await page.getByRole('button', { name: 'Ask assistant' }).click()

    const card = page.getByRole('region', { name: 'Spawn plan' })
    await expect(card).toBeVisible()
    await expect(card).toContainText('PROPOSED')
    await expect(card).toContainText('Ship the assistant bridge safely')
    await expect(page.getByRole('button', { name: 'Approve & Run' })).toBeVisible()
    await expect(page.getByText(/Run stub-/)).toHaveCount(0)

    const stored = await page.evaluate(() =>
      (window as unknown as {
        morzPlanner: { listOpen(): Promise<{ plans: { state: string; plan: { goal: string } }[] }> }
      }).morzPlanner.listOpen()
    )
    expect(stored.plans[0]).toMatchObject({
      state: 'PROPOSED',
      plan: { goal: 'Ship the assistant bridge safely' }
    })

    const after = await app.evaluate(() =>
      (globalThis as unknown as { __morzAssistantCalls?: number }).__morzAssistantCalls ?? 0
    )
    expect(after).toBe(1)

    await page.getByRole('radio', { name: 'Manual' }).click()
    await expect(page.getByRole('textbox', { name: 'Ask your assistant' })).toHaveCount(0)
    const afterManual = await app.evaluate(() =>
      (globalThis as unknown as { __morzAssistantCalls?: number }).__morzAssistantCalls ?? 0
    )
    expect(afterManual).toBe(1)
  })

  test('passes hostile goals to an npm-shim provider without a shell reparse', async () => {
    const { page } = morz
    await page.getByRole('radio', { name: 'Orchestrated' }).click()
    const assistantRegion = page.getByLabel('Assistant proposals')
    await assistantRegion.getByRole('button', { name: 'Discard' }).click()
    await expect(assistantRegion.getByRole('region', { name: 'Spawn plan' })).toHaveCount(0)
    await page.getByRole('button', { name: 'Disconnect and sign out assistant' }).click()
    await page.getByLabel('Assistant provider').selectOption('openclaw')
    await page.getByRole('button', { name: 'Connect assistant' }).click()
    await expect(page.getByText('Connected', { exact: true })).toBeVisible()

    const hostileGoal = `Plan safely\" & echo MORZ_INJECTED > \"${injectionMarker}\" & rem \"`
    await page.getByRole('textbox', { name: 'Ask your assistant' }).fill(hostileGoal)
    await page.getByRole('button', { name: 'Ask assistant' }).click()

    const card = assistantRegion.getByRole('region', { name: 'Spawn plan' })
    await expect(card).toContainText('PROPOSED')
    await expect(card).toContainText('Plan safely')
    expect(existsSync(injectionMarker)).toBe(false)
  })
})
