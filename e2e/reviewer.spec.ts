/*
 * Cross-model reviewer live proof (0.0.3, w5/reviewer).
 *
 * Creates a disposable git repository with a real inverted comparison,
 * records its Claude-authored commit on the real task board, and drives the
 * renderer through the real review IPC. Codex is the non-author reviewer.
 */
import { test, expect } from '@playwright/test'
import { spawnSync } from 'child_process'
import { mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { closeMorz, launchMorz, ROOT, type MorzApp } from './app'

const CODEX_AVAILABLE = spawnSync('codex', ['--version'], {
  windowsHide: true,
  stdio: 'ignore'
}).status === 0

const repo = join(ROOT, 'e2e', '.tmp', 'reviewer-planted-bug')

function git(...args: string[]): string {
  const result = spawnSync('git', args, {
    cwd: repo,
    encoding: 'utf8',
    windowsHide: true
  })
  if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(' ')} failed`)
  return result.stdout.trim()
}

test.describe.serial('cross-model reviewer', () => {
  test.skip(!CODEX_AVAILABLE, 'Codex CLI is not installed')

  let morz: MorzApp
  let headRef: string

  test.beforeAll(async () => {
    rmSync(repo, { recursive: true, force: true })
    mkdirSync(repo, { recursive: true })
    git('init')
    git('config', 'user.email', 'reviewer-e2e@morz.local')
    git('config', 'user.name', 'Morz Reviewer E2E')
    writeFileSync(
      join(repo, 'retry.ts'),
      `export function shouldRetry(attempts: number, maxAttempts: number): boolean {\n  return attempts < maxAttempts\n}\n`
    )
    git('add', 'retry.ts')
    git('commit', '-m', 'test: add retry predicate')
    writeFileSync(
      join(repo, 'retry.ts'),
      `export function shouldRetry(attempts: number, maxAttempts: number): boolean {\n  return attempts > maxAttempts\n}\n`
    )
    git('add', 'retry.ts')
    git('commit', '-m', 'feat: invert retry comparison')
    headRef = git('rev-parse', 'HEAD')

    morz = await launchMorz()
    const { page } = morz

    await page.evaluate(
      ({ root }) => {
        localStorage.setItem(
          'morz.spaces',
          JSON.stringify({
            state: {
              spaces: [
                {
                  id: 'reviewer-e2e',
                  name: 'reviewer-e2e',
                  root,
                  agents: [
                    {
                      id: 'claude-author',
                      name: 'claude-author',
                      cli: 'claude',
                      root
                    },
                    {
                      id: 'neutral-builder',
                      name: 'neutral-builder',
                      cli: 'codex',
                      root
                    }
                  ]
                }
              ]
            },
            version: 1
          })
        )
      },
      { root: repo }
    )
    await page.reload()

    await page.evaluate(
      async ({ sha }) => {
        const bus = (
          window as unknown as {
            morz: {
              bus: {
                createTask(input: { title: string; createdBy: string }): Promise<{ id: string }>
                acceptTask(taskId: string): Promise<unknown>
                claimTask(taskId: string, agentId: string): Promise<unknown>
                completeTask(
                  taskId: string,
                  agentId: string,
                  artifact: {
                    label: string
                    commits: { sha: string; branch: string; message: string }[]
                  }
                ): Promise<unknown>
              }
            }
          }
        ).morz.bus
        const task = await bus.createTask({
          title: 'Plant inverted retry comparison',
          createdBy: 'claude-author'
        })
        await bus.acceptTask(task.id)
        await bus.claimTask(task.id, 'claude-author')
        await bus.completeTask(task.id, 'claude-author', {
          label: 'inverted retry comparison',
          commits: [{ sha, branch: 'reviewer-e2e', message: 'feat: invert retry comparison' }]
        })

        const codexTask = await bus.createTask({
          title: 'Record neutral Codex artifact',
          createdBy: 'neutral-builder'
        })
        await bus.acceptTask(codexTask.id)
        await bus.claimTask(codexTask.id, 'neutral-builder')
        await bus.completeTask(codexTask.id, 'neutral-builder', {
          label: 'neutral author mapping',
          commits: [{ sha, branch: 'codex-source', message: 'feat: neutral codex artifact' }]
        })
      },
      { sha: headRef }
    )
  })

  test.afterAll(async () => {
    if (morz) await closeMorz(morz.app)
    rmSync(repo, { recursive: true, force: true })
  })

  test('uses the configured CLI as the author model', async () => {
    const { page } = morz
    await page.getByRole('tab', { name: 'Review', exact: true }).click()
    await expect(page.getByLabel('Review run')).toContainText(
      'codex-source — neutral author mapping (codex)'
    )
  })

  test('finds the planted bug, opens it, and posts a real handoff', async () => {
    test.setTimeout(420_000)
    const { page } = morz

    await page.getByRole('tab', { name: 'Review', exact: true }).click()
    await expect(page.getByLabel('Review run')).toContainText('reviewer-e2e')
    await page
      .getByLabel('Review run')
      .selectOption({ label: 'reviewer-e2e — inverted retry comparison (claude)' })
    await page.getByRole('button', { name: 'Run review' }).click()

    const finding = page.getByTestId('review-finding').first()
    await expect(finding).toBeVisible({ timeout: 300_000 })
    await expect(finding.getByTestId('severity-chip')).toHaveText(/critical|high|medium|low|info/i)
    await expect(finding).toContainText(/retry|comparison|attempt/i)
    await expect(page.getByText(/refuted by codex/i)).toBeVisible()
    await expect(page.getByText('same-model review')).toHaveCount(0)

    await page.getByRole('button', { name: 'Apply fix' }).click()
    await expect(page.getByTitle(join(repo, 'retry.ts')).first()).toBeVisible()

    await page.getByRole('button', { name: 'Send to agent' }).click()
    const posted = await page.evaluate(async () => {
      const snapshot = await (
        window as unknown as {
          morz: {
            bus: {
              snapshot(): Promise<{
                tasks: { title: string; createdBy: string }[]
                approvals: { to: string }[]
              }>
            }
          }
        }
      ).morz.bus.snapshot()
      return {
        task: snapshot.tasks.find(
          (task) => task.createdBy === 'morz-reviewer' && /review finding/i.test(task.title)
        ),
        approval: snapshot.approvals.find((approval) => approval.to === 'claude-author')
      }
    })
    expect(posted.task).toBeTruthy()
    expect(posted.approval).toBeTruthy()
  })
})
