import { test, expect } from '@playwright/test'
import { createServer, type IncomingMessage, type ServerResponse } from 'http'
import { readFileSync } from 'fs'
import { join } from 'path'
import { closeMorz, launchMorz, type MorzApp } from './app'

const API_KEY = 'fixture-secret-key-never-store-plaintext'
const REDIRECT_API_KEY = 'fixture-key-that-triggers-a-redirect'

interface Fixture {
  baseUrl: string
  requests: () => number
  searchMethods: () => string[]
  notes: Map<string, string>
  raceOnNextCreate: (path: string) => void
  close: () => Promise<void>
}

function body(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let value = ''
    req.setEncoding('utf8')
    req.on('data', (chunk) => {
      value += chunk
    })
    req.on('end', () => resolve(value))
    req.on('error', reject)
  })
}

function json(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(value))
}

async function startFixture(): Promise<Fixture> {
  const notes = new Map<string, string>([['Notes/hello.md', '# Hello\n\nA searchable needle.']])
  let requestCount = 0
  const searchMethods: string[] = []
  let racePath: string | null = null

  const server = createServer(async (req, res) => {
    requestCount += 1
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (req.method === 'GET' && url.pathname === '/') {
      if (req.headers.authorization === `Bearer ${REDIRECT_API_KEY}`) {
        res.writeHead(302, { location: '/redirect-target' })
        res.end()
        return
      }
      json(res, 200, { ok: 'OK', authenticated: req.headers.authorization === `Bearer ${API_KEY}` })
      return
    }
    if (req.method === 'GET' && url.pathname === '/redirect-target') {
      json(res, 200, { ok: 'OK', authenticated: true })
      return
    }
    if (req.headers.authorization !== `Bearer ${API_KEY}`) {
      json(res, 401, { error: 'unauthorized' })
      return
    }

    if ((req.method === 'GET' || req.method === 'POST') && url.pathname === '/search/simple/') {
      searchMethods.push(req.method)
      if (req.method === 'GET') {
        json(res, 405, { error: 'use POST' })
        return
      }
      const query = (url.searchParams.get('query') ?? '').toLowerCase()
      const matches = [...notes.entries()]
        .filter(([, content]) => content.toLowerCase().includes(query))
        .map(([filename]) => ({ filename, score: 1, matches: [] }))
      json(res, 200, matches)
      return
    }

    if (url.pathname.startsWith('/vault/')) {
      const notePath = url.pathname
        .slice('/vault/'.length)
        .split('/')
        .map(decodeURIComponent)
        .join('/')
      if (req.method === 'GET') {
        const content = notes.get(notePath)
        if (content === undefined) {
          json(res, 404, { error: 'not found' })
          return
        }
        res.writeHead(200, { 'content-type': 'text/markdown' })
        res.end(content)
        return
      }
      if (req.method === 'PUT') {
        notes.set(notePath, await body(req))
        res.writeHead(204)
        res.end()
        return
      }
      if (req.method === 'MOVE') {
        const rawDestination = req.headers.destination
        if (typeof rawDestination !== 'string') {
          json(res, 400, { error: 'destination required' })
          return
        }
        const destination = decodeURIComponent(rawDestination).replaceAll('\\', '/')
        if (racePath === destination) {
          notes.set(destination, '# External decision\n')
          racePath = null
        }
        if (req.headers['allow-overwrite'] !== 'false' || notes.has(destination)) {
          json(res, 409, { error: 'destination exists' })
          return
        }
        const content = notes.get(notePath)
        if (content === undefined) {
          json(res, 404, { error: 'source not found' })
          return
        }
        notes.delete(notePath)
        notes.set(destination, content)
        res.writeHead(204, { 'content-location': encodeURI(destination) })
        res.end()
        return
      }
    }

    json(res, 404, { error: 'not found' })
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('fixture did not bind a TCP port')

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests: () => requestCount,
    searchMethods: () => searchMethods,
    notes,
    raceOnNextCreate: (path) => {
      racePath = path
    },
    close: () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())))
  }
}

test.describe.serial('optional Obsidian integration', () => {
  let fixture: Fixture
  let morz: MorzApp

  test.beforeAll(async () => {
    fixture = await startFixture()
    morz = await launchMorz()
  })

  test.afterAll(async () => {
    if (morz) await closeMorz(morz.app)
    if (fixture) await fixture.close()
  })

  test('connects, reads, searches, previews, and writes without clobbering', async () => {
    const { page } = morz
    const initial = await page.evaluate(() =>
      (window as unknown as { morzObsidian: { status(): Promise<{ state: string }> } }).morzObsidian.status()
    )
    expect(initial.state).toBe('not-connected')
    expect(fixture.requests()).toBe(0)

    const rejectedCredentials = await page.evaluate(async ({ baseUrl, apiKey }) => {
      const api = (window as unknown as {
        morzObsidian: {
          connect(url: string, key: string): Promise<unknown>
          status(): Promise<{ state: string }>
        }
      }).morzObsidian
      try {
        await api.connect(baseUrl, apiKey)
        return { error: 'accepted', status: await api.status() }
      } catch (error) {
        return { error: String(error), status: await api.status() }
      }
    }, { baseUrl: fixture.baseUrl, apiKey: 'wrong-key' })
    expect(rejectedCredentials.error).toContain('rejected')
    expect(rejectedCredentials.status.state).toBe('not-connected')

    const rejectedRedirect = await page.evaluate(async ({ baseUrl, apiKey }) => {
      const api = (window as unknown as {
        morzObsidian: { connect(url: string, key: string): Promise<unknown> }
      }).morzObsidian
      try {
        await api.connect(baseUrl, apiKey)
        return 'accepted'
      } catch (error) {
        return String(error)
      }
    }, { baseUrl: fixture.baseUrl, apiKey: REDIRECT_API_KEY })
    expect(rejectedRedirect).toContain('Could not reach Obsidian')

    await page.getByRole('button', { name: 'Settings' }).evaluate((button: HTMLButtonElement) => button.click())
    await page.getByRole('button', { name: 'Integrations' }).evaluate((button: HTMLButtonElement) => button.click())
    await expect(page.getByText('Not connected', { exact: true })).toBeVisible()
    await page.getByLabel('Obsidian base URL').fill(fixture.baseUrl)
    await page.getByLabel('Obsidian API key').fill(API_KEY)
    await page.getByRole('button', { name: 'Connect to Obsidian' }).evaluate((button: HTMLButtonElement) => button.click())
    await expect(page.getByText('Connected', { exact: true })).toBeVisible()

    await page.getByLabel('Test note path').fill('Notes/hello.md')
    await page.getByRole('button', { name: 'Test read' }).evaluate((button: HTMLButtonElement) => button.click())
    await expect(page.getByTestId('obsidian-test-read-result')).toContainText('A searchable needle.')

    const requestsBeforeRejectedRemote = fixture.requests()
    const rejectedRemote = await page.evaluate(async () => {
      const api = (window as unknown as {
        morzObsidian: { connect(url: string, key: string): Promise<unknown> }
      }).morzObsidian
      try {
        await api.connect('https://example.com', 'not-sent')
        return 'accepted'
      } catch (error) {
        return String(error)
      }
    })
    expect(rejectedRemote).toContain('loopback URL')
    expect(fixture.requests()).toBe(requestsBeforeRejectedRemote)

    const result = await page.evaluate(async () => {
      const api = (window as unknown as {
        morzObsidian: {
          readNote(path: string): Promise<string>
          searchNotes(query: string): Promise<{ filename: string }[]>
          prepareAdr(
            folder: string,
            title: string,
            body: { status: string; context: string; decision: string; consequences: string }
          ): Promise<{ preview: string; draftId: string }>
          writeAdr(draftId: string): Promise<{ path: string }>
        }
      }).morzObsidian
      const adrBody = {
        status: 'Accepted',
        context: 'Morz needs optional local notes.',
        decision: 'Use the user-owned Obsidian vault.',
        consequences: 'Morz never creates or deletes a vault.'
      }
      const prepared = await api.prepareAdr('Decisions', 'Use Obsidian', adrBody)
      const first = await api.writeAdr(prepared.draftId)
      let replayError = ''
      try {
        await api.writeAdr(prepared.draftId)
      } catch (error) {
        replayError = String(error)
      }
      const secondDraft = await api.prepareAdr('Decisions', 'Use Obsidian', adrBody)
      return {
        note: await api.readNote('Notes/hello.md'),
        search: await api.searchNotes('needle'),
        prepared,
        first,
        replayError,
        second: await api.writeAdr(secondDraft.draftId)
      }
    })

    expect(result.note).toContain('searchable needle')
    expect(result.search).toEqual([{ filename: 'Notes/hello.md', score: 1, matches: [] }])
    expect(result.prepared.preview).toContain('## Status\nAccepted')
    expect(result.prepared.preview).toContain('## Context\nMorz needs optional local notes.')
    expect(result.prepared.preview).toContain('## Decision\nUse the user-owned Obsidian vault.')
    expect(result.prepared.preview).toContain('## Consequences\nMorz never creates or deletes a vault.')
    expect(result.first.path).toBe('Decisions/Use Obsidian.md')
    expect(result.replayError).toContain('expired or already used')
    expect(result.second.path).toBe('Decisions/Use Obsidian-2.md')
    expect(fixture.notes.get(result.first.path)).toBe(result.prepared.preview)
    expect(fixture.notes.get(result.second.path)).toBe(result.prepared.preview)
    expect(fixture.searchMethods()).toEqual(['POST'])

    fixture.raceOnNextCreate('Decisions/Concurrent decision.md')
    const racedWrite = await page.evaluate(async () => {
      const api = (window as unknown as {
        morzObsidian: {
          prepareAdr(folder: string, title: string, body: {
            status: string
            context: string
            decision: string
            consequences: string
          }): Promise<{ draftId: string }>
          writeAdr(draftId: string): Promise<{ path: string }>
        }
      }).morzObsidian
      const draft = await api.prepareAdr('Decisions', 'Concurrent decision', {
        status: 'Accepted',
        context: 'A note may appear between the existence check and write.',
        decision: 'Never overwrite it.',
        consequences: 'Retry with the next suffix.'
      })
      return api.writeAdr(draft.draftId)
    })
    expect(racedWrite.path).toBe('Decisions/Concurrent decision-2.md')
    expect(fixture.notes.get('Decisions/Concurrent decision.md')).toBe('# External decision\n')
    expect([...fixture.notes.keys()].filter((path) => path.includes('Morz temporary ADR'))).toEqual([])

    const malformedMadr = await page.evaluate(async () => {
      const api = (window as unknown as {
        morzObsidian: { prepareAdr(folder: string, title: string, body: unknown): Promise<unknown> }
      }).morzObsidian
      try {
        await api.prepareAdr('Decisions', 'Malformed', {
          status: 'Accepted',
          context: 'Context',
          decision: 'Decision',
          unexpected: 'not consequences'
        })
        return 'accepted'
      } catch (error) {
        return String(error)
      }
    })
    expect(malformedMadr).toContain('MADR body is incomplete')

    const dbDir = join(morz.appDataDir, 'Morz')
    const persistedBytes = [join(dbDir, 'morz.db'), join(dbDir, 'morz.db-wal')]
      .map((path) => {
        try {
          return readFileSync(path)
        } catch {
          return Buffer.alloc(0)
        }
      })
      .reduce((all, part) => Buffer.concat([all, part]), Buffer.alloc(0))
    expect(persistedBytes.includes(Buffer.from(API_KEY))).toBe(false)
  })
})
