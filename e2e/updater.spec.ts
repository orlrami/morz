import { createHash } from 'crypto'
import { createServer, type Server } from 'http'
import { expect, test } from '@playwright/test'
import type { UpdaterBridge, UpdaterSnapshot } from '../src/shared/ipc'
import { closeMorz, launchMorz, type MorzApp } from './app'

const FAKE_INSTALLER = Buffer.from('morz-e2e-update-fixture')
const FAKE_SHA512 = createHash('sha512').update(FAKE_INSTALLER).digest('base64')

test.describe.serial('Morz updater', () => {
  let feed: Server
  let feedUrl: string
  let morz: MorzApp | undefined
  let requests: string[]

  test.beforeAll(async () => {
    requests = []
    feed = createServer((request, response) => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1')
      requests.push(url.pathname)
      if (url.pathname === '/latest.yml') {
        response.writeHead(200, { 'content-type': 'text/yaml' })
        response.end([
          'version: 0.0.5',
          'files:',
          '  - url: morz-0.0.5-setup.exe',
          `    sha512: ${FAKE_SHA512}`,
          `    size: ${FAKE_INSTALLER.length}`,
          'path: morz-0.0.5-setup.exe',
          `sha512: ${FAKE_SHA512}`,
          `releaseDate: '${new Date().toISOString()}'`,
          ''
        ].join('\n'))
        return
      }
      if (url.pathname === '/morz-0.0.5-setup.exe') {
        response.writeHead(200, {
          'content-type': 'application/octet-stream',
          'content-length': String(FAKE_INSTALLER.length)
        })
        response.end(FAKE_INSTALLER)
        return
      }
      response.writeHead(404).end()
    })
    await new Promise<void>((resolve) => feed.listen(0, '127.0.0.1', resolve))
    const address = feed.address()
    if (!address || typeof address === 'string') throw new Error('Updater feed did not bind')
    feedUrl = `http://127.0.0.1:${address.port}`
  })

  test.afterEach(async () => {
    if (morz) await closeMorz(morz.app)
    morz = undefined
    delete process.env.MORZ_E2E
    delete process.env.MORZ_UPDATE_FEED_URL
    delete process.env.MORZ_UPDATE_PUBLIC
    delete process.env.MORZ_UPDATE_TOKEN
  })

  test.afterAll(async () => {
    await new Promise<void>((resolve, reject) =>
      feed.close((error) => error ? reject(error) : resolve())
    )
  })

  test('stays silent-off when the private feed has no token', async () => {
    process.env.MORZ_E2E = '1'
    morz = await launchMorz()

    const snapshot = await morz.page.evaluate(() =>
      (window as unknown as { morzUpdater: UpdaterBridge }).morzUpdater.status()
    )
    expect(snapshot).toMatchObject<Partial<UpdaterSnapshot>>({
      enabled: false,
      status: 'disabled',
      version: '0.0.4',
      channel: 'stable'
    })

    const checked = await morz.page.evaluate(() =>
      (window as unknown as { morzUpdater: UpdaterBridge }).morzUpdater.check()
    )
    expect(checked.status).toBe('disabled')
    const notices = await morz.page.evaluate(() => window.morz.notify?.list())
    expect(notices?.filter((notice) => notice.id.startsWith('app:update'))).toEqual([])
    expect(requests).toEqual([])

    await morz.page.getByRole('button', { name: 'Settings' }).click()
    await morz.page.getByRole('button', { name: 'About' }).click()
    const settings = morz.page.getByRole('region', { name: 'Update settings' })
    await expect(settings).toContainText('Version 0.0.4 · Stable channel')
    await expect(settings.getByRole('button', { name: 'Check for updates' })).toBeDisabled()
  })

  test('manual check surfaces an available update from the E2E generic feed', async () => {
    process.env.MORZ_E2E = '1'
    process.env.MORZ_UPDATE_FEED_URL = feedUrl
    morz = await launchMorz()

    const checked = await morz.page.evaluate(() =>
      (window as unknown as { morzUpdater: UpdaterBridge }).morzUpdater.check()
    )

    expect({ checked, requests }).toMatchObject({
      checked: { enabled: true },
      requests: expect.arrayContaining(['/latest.yml'])
    })

    await expect.poll(async () => {
      const notices = await morz!.page.evaluate(() => window.morz.notify?.list())
      return notices?.find((notice) => notice.id === 'app:update-available')?.title ?? null
    }).toBe('Morz 0.0.5 is available')
    await expect.poll(async () => {
      const state = await morz!.page.evaluate(async () => ({
        snapshot: await (window as unknown as { morzUpdater: UpdaterBridge }).morzUpdater.status(),
        notices: await window.morz.notify?.list()
      }))
      return {
        status: state.snapshot.status,
        readyActions: state.notices?.find((notice) => notice.id === 'app:update-ready')?.actions ?? null
      }
    }).toEqual({
      status: 'ready',
      readyActions: [{ id: 'restart-update', label: 'Restart to update' }]
    })
    expect(requests).toContain('/latest.yml')
  })
})
