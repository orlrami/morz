import { expect, test, type Page } from '@playwright/test'
import { execFileSync } from 'child_process'
import { mkdirSync, rmSync } from 'fs'
import { basename, join } from 'path'
import {
  closeMorz,
  launchMorz,
  PANE_1,
  PANE_2,
  PROMPT_RE,
  runInPane,
  termText,
  waitForTerm,
  type MorzApp
} from './app'

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

async function typeLine(page: Page, paneId: string, command: string): Promise<void> {
  const input = page.locator(`[data-pane-id="${paneId}"] .xterm-helper-textarea`)
  await input.focus()
  await page.keyboard.type(command)
  await page.keyboard.press('Enter')
}

async function seedEmptySpaceLaunch(): Promise<MorzApp> {
  const bootstrap = await launchMorz()
  const { app, page, appDataDir } = bootstrap
  try {
    await page.evaluate(() => {
      localStorage.setItem(
        'morz.spaces',
        JSON.stringify({
          version: 2,
          state: { spaces: [], activeSpaceId: null, initialized: true }
        })
      )
    })
    const closed = page.waitForEvent('close')
    await app.evaluate(({ BrowserWindow }) => {
      setTimeout(() => {
        for (const window of BrowserWindow.getAllWindows()) window.close()
      }, 0)
    })
    await closed

    await app.evaluate(({ app: electronApp }) => {
      const getBuiltinModule = (process as typeof process & {
        getBuiltinModule(id: string): unknown
      }).getBuiltinModule
      const { join: joinPath } = getBuiltinModule('node:path') as typeof import('node:path')
      const { createRequire } = getBuiltinModule('node:module') as typeof import('node:module')
      const requireFromApp = createRequire(joinPath(process.cwd(), 'package.json'))
      const Database = requireFromApp('better-sqlite3') as typeof import('better-sqlite3')
      const panes = [
        { paneId: 'term-1', kind: 'terminal', cwd: '', shell: '', touched: false },
        { paneId: 'term-2', kind: 'terminal', cwd: '', shell: '', touched: false }
      ]
      const snapshot = {
        layout: {
          tree: {
            type: 'split',
            id: 'space-cwd-default-split',
            dir: 'row',
            ratio: 0.5,
            a: { type: 'leaf', pane: panes[0] },
            b: { type: 'leaf', pane: panes[1] }
          },
          panes
        },
        panes: panes.map(({ paneId, cwd, shell }) => ({ paneId, cwd, shell, scrollback: '' }))
      }
      const db = new Database(joinPath(electronApp.getPath('appData'), 'Morz', 'morz.db'))
      db.prepare(
        `INSERT INTO snapshot (id, json, updated_at) VALUES (1, ?, ?)
         ON CONFLICT(id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at`
      ).run(JSON.stringify(snapshot), Date.now())
      db.close()
    })

    await closeMorz(app)
    return launchMorz({ appDataDir })
  } catch (error) {
    await closeMorz(app)
    throw error
  }
}

async function cwdFromPane(page: Page, paneId: string, marker: string): Promise<string> {
  await runInPane(page, paneId, `"${marker.slice(0, 8)}" + "${marker.slice(8)}=$((Get-Location).Path)"`)
  const buffer = await waitForTerm(page, paneId, new RegExp(`${marker}=[^\\r\\n]+`))
  return new RegExp(`${marker}=([^\\r\\n]+)`).exec(buffer)![1].trim()
}

test.describe.serial('active space terminal cwd (w13/space-cwd)', () => {
  let morz: MorzApp | undefined
  const firstRoot = join(__dirname, '.tmp', 'space-cwd-first-$literal-`tick-' + Date.now())
  const secondRoot = join(__dirname, '.tmp', `space-cwd-second-${Date.now()}`)

  test.beforeAll(() => {
    for (const root of [firstRoot, secondRoot]) {
      mkdirSync(root, { recursive: true })
      execFileSync('git', ['init', '-b', basename(root)], { cwd: root, windowsHide: true })
    }
    process.env.MORZ_E2E = '1'
    process.env.MORZ_E2E_PICK_FOLDER = firstRoot
  })

  test.afterAll(async () => {
    if (morz) await closeMorz(morz.app)
    delete process.env.MORZ_E2E
    delete process.env.MORZ_E2E_PICK_FOLDER
    rmSync(firstRoot, { recursive: true, force: true })
    rmSync(secondRoot, { recursive: true, force: true })
  })

  test('moves only pristine defaults and starts new panes at the active root', async () => {
    morz = await seedEmptySpaceLaunch()
    const { app, page } = morz
    await waitForTerm(page, PANE_1, PROMPT_RE, 90_000)
    await waitForTerm(page, PANE_2, PROMPT_RE, 90_000)

    await typeLine(page, PANE_1, '"MORZ_USE" + "D_CWD=$((Get-Location).Path)"')
    const usedBuffer = await waitForTerm(page, PANE_1, /MORZ_USED_CWD=[^\r\n]+/)
    const usedCwd = /MORZ_USED_CWD=([^\r\n]+)/.exec(usedBuffer)![1].trim()

    const paneTwoBeforeFirstSpace = (await termText(page, PANE_2)).length
    await page.getByRole('button', { name: 'Add space' }).click()
    await expect(page.locator(`[data-space-name="${basename(firstRoot)}"]`)).toHaveAttribute(
      'data-active',
      'true'
    )
    await expect
      .poll(async () => (await termText(page, PANE_2)).slice(paneTwoBeforeFirstSpace), {
        timeout: 20_000
      })
      .toMatch(new RegExp(escapeRegExp(firstRoot), 'i'))
    expect((await cwdFromPane(page, PANE_2, 'MORZ_FIRST_CWD')).toLowerCase()).toBe(
      firstRoot.toLowerCase()
    )
    expect((await cwdFromPane(page, PANE_1, 'MORZ_USED_AFTER_FIRST')).toLowerCase()).toBe(
      usedCwd.toLowerCase()
    )

    await app.evaluate((_electron, root) => {
      process.env.MORZ_E2E_PICK_FOLDER = root
    }, secondRoot)
    const paneTwoBeforeSecondSpace = (await termText(page, PANE_2)).length
    await page.getByRole('button', { name: 'Add space' }).click()
    await expect(page.locator(`[data-space-name="${basename(secondRoot)}"]`)).toHaveAttribute(
      'data-active',
      'true'
    )
    await expect
      .poll(async () => (await termText(page, PANE_2)).slice(paneTwoBeforeSecondSpace), {
        timeout: 20_000
      })
      .toMatch(new RegExp(escapeRegExp(secondRoot), 'i'))
    expect((await cwdFromPane(page, PANE_1, 'MORZ_USED_AFTER_SWITCH')).toLowerCase()).toBe(
      usedCwd.toLowerCase()
    )

    const paneTwo = page.locator(`[data-pane-id="${PANE_2}"] .xterm`)
    await paneTwo.click({ button: 'right' })
    await page.getByRole('button', { name: 'Split right' }).click()
    const paneIds = await page.locator('section[data-pane-id^="term-"]').evaluateAll((panes) =>
      panes.map((pane) => pane.getAttribute('data-pane-id')).filter((id): id is string => !!id)
    )
    const newPaneId = paneIds.find((id) => id !== PANE_1 && id !== PANE_2)
    expect(newPaneId).toBeTruthy()
    await waitForTerm(page, newPaneId!, PROMPT_RE, 90_000)
    expect((await cwdFromPane(page, newPaneId!, 'MORZ_NEW_CWD')).toLowerCase()).toBe(
      secondRoot.toLowerCase()
    )
  })
})
