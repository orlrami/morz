import { test, expect } from '@playwright/test'
import { colors } from '../src/renderer/src/lib/tokens'
import { isKnownTuiProcess, TUI_PROCESSES } from '../src/main/pty-host/tui-registry'
import {
  closeMorz,
  closeWindow,
  launchMorz,
  PANE_1,
  PROMPT_RE,
  reopenWindow,
  runInPane,
  termText,
  waitForTerm,
  type MorzApp
} from './app'

const OSC_133_RE = /\x1b\]133;([ABCD])(?:;(-?\d+))?;nonce=([0-9a-f-]+)\x07/g

test('known TUI registry matches normalized executable names only', () => {
  expect(TUI_PROCESSES.length).toBeGreaterThan(10)

  for (const command of [
    'vim',
    'nvim.exe',
    'nano',
    'htop',
    'btop.exe',
    '"C:\\Tools\\lazygit.exe" --debug',
    '/usr/bin/less',
    'ssh user@example.com',
    'python3',
    'node.exe',
    'claude.cmd',
    'codex.ps1'
  ]) {
    expect(isKnownTuiProcess(command), command).toBe(true)
  }

  for (const command of ['pwsh.exe', 'powershell.exe', 'cmd.exe', 'npm.cmd', 'git.exe', '']) {
    expect(isKnownTuiProcess(command), command).toBe(false)
  }
})

test.describe.serial('OSC-133 command blocks', () => {
  let morz: MorzApp

  test.beforeAll(async () => {
    morz = await launchMorz()
  })

  test.afterAll(async () => {
    if (morz) await closeMorz(morz.app)
  })

  test('signed A/B/C/D marks create token-colored block gutters', async () => {
    const { page, app } = morz
    await waitForTerm(page, PANE_1, PROMPT_RE, 90_000)

    await runInPane(page, PANE_1, 'echo hi')
    await waitForTerm(page, PANE_1, /\x1b\]133;D;0;nonce=[0-9a-f-]+\x07/)
    await runInPane(page, PANE_1, 'cmd /c exit 3')
    const buffer = await waitForTerm(page, PANE_1, /\x1b\]133;D;3;nonce=[0-9a-f-]+\x07/)
    const echoBlock = /\x1b\]133;C;nonce=([0-9a-f-]+)\x07([\s\S]*?)\x1b\]133;D;0;nonce=\1\x07/.exec(
      buffer
    )
    expect(echoBlock?.[2]).toContain('hi')

    const marks = [...buffer.matchAll(OSC_133_RE)]
    const nonce = marks.find((mark) => mark[1] === 'A')?.[3]
    expect(nonce).toBeTruthy()
    for (const kind of ['A', 'B', 'C', 'D']) {
      expect(marks.some((mark) => mark[1] === kind && mark[3] === nonce), kind).toBe(true)
    }
    expect(marks.some((mark) => mark[1] === 'D' && mark[2] === '3' && mark[3] === nonce)).toBe(
      true
    )

    await page.bringToFront()
    await app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0]
      if (!win) return
      const [width, height] = win.getSize()
      win.setSize(width - 1, height)
      win.setSize(width, height)
    })

    const gutters = page.locator('[data-morz-block-gutter="true"]')
    await expect(gutters.first()).toBeVisible()
    expect(await gutters.count()).toBeGreaterThanOrEqual(2)

    const failed = page.locator('[data-morz-block-gutter="true"][data-morz-exit-code="3"]')
    await expect(failed).toBeVisible()
    await expect(failed).toHaveCSS('border-left-color', 'rgb(239, 68, 68)')

    const succeeded = page.locator('[data-morz-block-gutter="true"][data-morz-exit-code="0"]')
    await expect(succeeded).toBeVisible()
    expect(await succeeded.evaluate((el) => getComputedStyle(el).borderLeftColor)).toBe(
      'rgb(34, 197, 94)'
    )
    expect(colors.done).toBe('#22C55E')
    expect(colors.error).toBe('#EF4444')
  })

  test('known foreground process forwards TUI state transitions', async () => {
    const { page, app } = morz
    await page.evaluate(() => {
      const w = window as unknown as {
        __morzTui?: { paneId: string; tui: boolean }[]
        morz: {
          pty: {
            onData(cb: (msg: { type?: string; paneId: string; tui?: boolean }) => void): void
          }
        }
      }
      w.__morzTui = []
      w.morz.pty.onData((msg) => {
        if (msg.type === 'tui' && typeof msg.tui === 'boolean') {
          w.__morzTui!.push({ paneId: msg.paneId, tui: msg.tui })
        }
      })
    })

    await runInPane(page, PANE_1, 'node')
    await waitForTerm(page, PANE_1, /Welcome to Node\.js/)
    await page.waitForFunction(
      (paneId) =>
        (
          window as unknown as {
            __morzTui?: { paneId: string; tui: boolean }[]
          }
        ).__morzTui?.some((event) => event.paneId === paneId && event.tui === true),
      PANE_1,
      { timeout: 10_000 }
    )

    await closeWindow(app)
    const reopened = await reopenWindow(app)
    morz.page = reopened
    await reopened.evaluate(() => {
      const w = window as unknown as {
        __morzTui?: { paneId: string; tui: boolean }[]
        morz: {
          pty: {
            attach(paneId: string): void
            onData(cb: (msg: { type?: string; paneId: string; tui?: boolean }) => void): void
          }
        }
      }
      w.__morzTui = []
      w.morz.pty.onData((msg) => {
        if (msg.type === 'tui' && typeof msg.tui === 'boolean') {
          w.__morzTui!.push({ paneId: msg.paneId, tui: msg.tui })
        }
      })
      w.morz.pty.attach('term-1')
    })
    await reopened.waitForFunction(
      (paneId) =>
        (
          window as unknown as {
            __morzTui?: { paneId: string; tui: boolean }[]
          }
        ).__morzTui?.some((event) => event.paneId === paneId && event.tui === true),
      PANE_1,
      { timeout: 10_000 }
    )

    await runInPane(reopened, PANE_1, '.exit')
    await reopened.waitForFunction(
      (paneId) => {
        const events = (
          window as unknown as {
            __morzTui?: { paneId: string; tui: boolean }[]
          }
        ).__morzTui ?? []
        const entered = events.findIndex((event) => event.paneId === paneId && event.tui)
        return entered >= 0 && events.slice(entered + 1).some((event) => event.paneId === paneId && !event.tui)
      },
      PANE_1,
      { timeout: 10_000 }
    )

    // A dead PTY must clear the combined state even if xterm is still in the
    // alternate buffer and never receives a normal leave-buffer sequence.
    await runInPane(reopened, PANE_1, 'node')
    await reopened.waitForFunction(
      (paneId) => {
        const events = (
          window as unknown as {
            __morzTui?: { paneId: string; tui: boolean }[]
          }
        ).__morzTui ?? []
        const lastFalse = events
          .map((event) => event.paneId === paneId && !event.tui)
          .lastIndexOf(true)
        return events.slice(lastFalse + 1).some((event) => event.paneId === paneId && event.tui)
      },
      PANE_1,
      { timeout: 10_000 }
    )
    await runInPane(reopened, PANE_1, "process.stdout.write('\\x1b[?1049h')")
    const paneTerminal = reopened.locator(`[data-pane-id="${PANE_1}"] .xterm`)
    await expect(paneTerminal).toHaveAttribute('data-morz-alt-screen', 'true')
    await expect(paneTerminal).toHaveAttribute('data-morz-tui', 'true')
    await reopened.evaluate((paneId) => window.morz.pty.kill(paneId), PANE_1)
    await expect(paneTerminal).toHaveAttribute('data-morz-alt-screen', 'false')
    await expect(paneTerminal).toHaveAttribute('data-morz-tui', 'false')
  })
})

test('MORZ_NO_SHELL_HOOK=1 emits no OSC-133 marks', async () => {
  const previous = process.env.MORZ_NO_SHELL_HOOK
  process.env.MORZ_NO_SHELL_HOOK = '1'
  let morz: MorzApp | undefined
  try {
    morz = await launchMorz()
    delete process.env.MORZ_NO_SHELL_HOOK
    await waitForTerm(morz.page, PANE_1, PROMPT_RE, 90_000)
    await runInPane(morz.page, PANE_1, '"MORZ_NO_HOOK_$(20+2)"')
    await waitForTerm(morz.page, PANE_1, /MORZ_NO_HOOK_22/)
    await morz.page.waitForTimeout(500)

    expect(await termText(morz.page, PANE_1)).not.toMatch(/\x1b\]133;/)
    await expect(morz.page.locator('[data-morz-block-gutter="true"]')).toHaveCount(0)
  } finally {
    if (previous === undefined) delete process.env.MORZ_NO_SHELL_HOOK
    else process.env.MORZ_NO_SHELL_HOOK = previous
    if (morz) await closeMorz(morz.app)
  }
})
