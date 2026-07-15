import { expect, test } from '@playwright/test'
import { createServer, type Server } from 'http'
import { existsSync } from 'fs'
import { closeMorz, launchMorz, type MorzApp } from './app'
import type { BrowserBridge, ElementContext } from '../src/shared/ipc'

type BrowserWindow = Window & { morzBrowser: BrowserBridge }

test.describe('embedded browser and element pick', () => {
  let morz: MorzApp
  let server: Server
  let fixtureUrl: string

  test.beforeEach(async () => {
    process.env.MORZ_E2E = '1'
    server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end(`<!doctype html>
        <html>
          <head>
            <title>Browser fixture</title>
            <style>
              body { margin: 24px; background: rgb(250, 248, 244); }
              button {
                color: rgb(255, 255, 255);
                background: rgb(194, 78, 50);
                font: 600 14px Arial, sans-serif;
                margin: 8px;
                padding: 12px 24px;
                border: 2px solid rgb(120, 40, 20);
              }
            </style>
          </head>
          <body>
            <button data-morz-loc="src/App.tsx:10">Pick me</button>
          </body>
        </html>`)
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('fixture server did not bind')
    fixtureUrl = `http://127.0.0.1:${address.port}`
    morz = await launchMorz()
  })

  test.afterEach(async () => {
    delete process.env.MORZ_E2E
    await closeMorz(morz.app)
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    )
  })

  test('navigates, captures a full ElementContext, and removes the view on tab switch', async () => {
    await morz.page.getByRole('tab', { name: 'Browser' }).click()
    const address = morz.page.getByRole('textbox', { name: 'Browser address' })
    await address.fill(fixtureUrl)
    await address.press('Enter')

    await expect
      .poll(() =>
        morz.page.evaluate(() => (window as unknown as BrowserWindow).morzBrowser.state())
      )
      .toMatchObject({ url: `${fixtureUrl}/`, loading: false })

    const panelRect = await morz.page.getByTestId('browser-viewport').boundingBox()
    expect(panelRect).not.toBeNull()
    await expect
      .poll(() =>
        morz.app.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows()[0]?.contentView.children.map((view) => view.getBounds()) ?? []
        )
      )
      .toContainEqual({
        x: Math.round(panelRect!.x),
        y: Math.round(panelRect!.y),
        width: Math.round(panelRect!.width),
        height: Math.round(panelRect!.height)
      })

    const pickButton = morz.page.getByRole('button', { name: 'Pick Element' })
    await pickButton.click()
    await expect
      .poll(() =>
        morz.page.evaluate(() => (window as unknown as BrowserWindow).morzBrowser.state())
      )
      .toMatchObject({ picking: true })
    await morz.page.getByRole('button', { name: 'Picking…' }).click()

    const context = await morz.page.evaluate(async () => {
      const bridge = (window as unknown as BrowserWindow).morzBrowser
      if (!bridge.testPick) throw new Error('missing MORZ_E2E testPick bridge')
      return bridge.testPick('button')
    })

    expect(context.selector).toBeTruthy()
    expect(context.a11y).toEqual({ role: 'button', name: 'Pick me' })
    expect(context.curatedStyles.color).toBe('rgb(255, 255, 255)')
    expect(context.curatedStyles.backgroundColor).toBe('rgb(194, 78, 50)')
    expect(context.curatedStyles.padding).toBe('12px 24px')
    expect(context.curatedStyles.border).toContain('2px')
    expect(context.boundingRect.width).toBeGreaterThan(0)
    expect(context.boundingRect.height).toBeGreaterThan(0)
    expect(context.croppedScreenshotDataUrl).toMatch(/^data:image\/png;base64,.+/)
    expect(context.screenshotPath).toMatch(/\.png$/)
    expect(context.sourceLoc).toBe('src/App.tsx:10')
    expect(context.html).toContain('data-morz-loc="src/App.tsx:10"')

    await expect(morz.page.getByRole('complementary', { name: 'Picked element' })).toContainText(
      'src/App.tsx:10'
    )
    expect(existsSync((context as ElementContext).screenshotPath)).toBe(true)
    await expect
      .poll(() =>
        morz.app.evaluate(({ webContents }) =>
          webContents
            .getAllWebContents()
            .filter((contents) => contents.getURL().startsWith('http://127.0.0.1:')).length
        )
      )
      .toBe(1)

    await morz.page.getByRole('button', { name: /Send to design critique/ }).click()
    await expect(morz.page.getByText('Context copied to clipboard.')).toBeVisible()
    await expect
      .poll(() => morz.app.evaluate(({ clipboard }) => clipboard.readText()))
      .toContain('Critique the visual design')
    await expect
      .poll(() =>
        morz.page.evaluate(async () => {
          const notices = await window.morz.notify?.list()
          return notices?.some((notice) => notice.title === 'design critique copied to clipboard')
        })
      )
      .toBe(true)

    await morz.page.getByRole('button', { name: /Send to builder/ }).click()
    await expect
      .poll(() => morz.app.evaluate(({ clipboard }) => clipboard.readText()))
      .toContain('Edit the implementation')
    await expect
      .poll(() =>
        morz.page.evaluate(async () => {
          const notices = await window.morz.notify?.list()
          return notices?.some((notice) => notice.title === 'builder edit copied to clipboard')
        })
      )
      .toBe(true)

    await address.fill('file:///C:/Windows/System32/drivers/etc/hosts')
    await address.press('Enter')
    await expect(
      morz.page.getByRole('alert').filter({ hasText: 'Only HTTP and HTTPS' }).first()
    ).toBeVisible()
    await expect
      .poll(() =>
        morz.page.evaluate(() => (window as unknown as BrowserWindow).morzBrowser.state())
      )
      .toMatchObject({ url: `${fixtureUrl}/` })

    await morz.page.getByRole('tab', { name: 'Terminals' }).click()
    await expect
      .poll(() =>
        morz.app.evaluate(({ webContents }) =>
          webContents
            .getAllWebContents()
            .filter((contents) => contents.getURL().startsWith('http://127.0.0.1:')).length
        )
      )
      .toBe(0)
  })
})
