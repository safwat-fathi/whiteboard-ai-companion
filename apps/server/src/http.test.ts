import { mkdtempSync, rmSync } from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { createDiskBlobStore } from './blobs'
import { BoardService } from './board-service'
import { loadConfig } from './config'
import {
  createBlobsDb,
  createBoardsDb,
  openDatabase,
  schemaVersion,
} from './db'
import { checkOrigin, createHttpServer } from './http'

const ORIGIN = 'http://localhost:3000'
const cleanup: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f()
})

type Res = {
  status: number
  headers: http.IncomingHttpHeaders
  text: string
  // biome-ignore lint/suspicious/noExplicitAny: a test helper that reads arbitrary JSON
  json: any
}
async function boot() {
  const root = mkdtempSync(join(tmpdir(), 'wb-http-'))
  const dataDir = join(root, 'data')
  const db: Database.Database = openDatabase({ dataDir })
  let clock = 1_000
  const boards = new BoardService(createBoardsDb(db), { now: () => ++clock })
  const config = loadConfig({
    PUBLIC_ORIGIN: ORIGIN,
    DATA_DIR: dataDir,
    META_API_KEY: 'sk-secret-meta-value',
  })
  const server = createHttpServer({
    config,
    boards,
    blobs: createDiskBlobStore({ dataDir, db: createBlobsDb(db) }),
    schemaVersion: () => schemaVersion(db),
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  cleanup.push(async () => {
    server.closeAllConnections()
    await new Promise((r) => server.close(r))
    db.close()
    rmSync(root, { recursive: true, force: true })
  })
  const port = (server.address() as AddressInfo).port
  function call(
    method: string,
    path: string,
    o: {
      headers?: Record<string, string>
      body?: string | Buffer
      origin?: string | null
    } = {},
  ): Promise<Res> {
    const headers: Record<string, string> = { ...o.headers }
    if (o.origin !== null && o.origin !== undefined) headers.Origin = o.origin
    return new Promise((resolve, reject) => {
      const req = http.request(
        { host: '127.0.0.1', port, method, path, headers },
        (res) => {
          const chunks: Buffer[] = []
          res.on('data', (c) => chunks.push(c))
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8')
            // biome-ignore lint/suspicious/noExplicitAny: a test helper that reads arbitrary JSON
            let json: any
            try {
              json = text ? JSON.parse(text) : undefined
            } catch {}
            resolve({
              status: res.statusCode ?? 0,
              headers: res.headers,
              text,
              json,
            })
          })
        },
      )
      req.on('error', reject)
      if (o.body !== undefined) req.write(o.body)
      req.end()
    })
  }
  const json = (
    method: string,
    path: string,
    body: unknown,
    origin: string | null = ORIGIN,
  ) =>
    call(method, path, {
      origin,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  return { call, json, boards, config }
}

describe('checkOrigin', () => {
  const ok = (method: string, origin?: string) =>
    checkOrigin(
      { method, headers: origin === undefined ? {} : { origin } },
      ORIGIN,
    )
  it('lets GET, HEAD and OPTIONS through without an Origin', () => {
    expect(ok('GET')).toBe(true)
    expect(ok('HEAD')).toBe(true)
    expect(ok('OPTIONS')).toBe(true)
  })
  it('requires the exact origin for everything else (R3)', () => {
    for (const m of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      expect(ok(m, ORIGIN)).toBe(true)
      expect(ok(m)).toBe(false)
      expect(ok(m, 'null')).toBe(false)
      expect(ok(m, `${ORIGIN}/`)).toBe(false)
      expect(ok(m, 'http://localhost:3001')).toBe(false)
      expect(ok(m, 'http://evil.test')).toBe(false)
      expect(ok(m, 'https://localhost:3000')).toBe(false)
    }
  })
})

describe('health and routing', () => {
  it('reports the schema version and key presence, never a key value', async () => {
    const { call } = await boot()
    const r = await call('GET', '/api/health')
    expect(r.status).toBe(200)
    expect(r.json).toEqual({
      ok: true,
      migrations: 1,
      keys: { meta: true, openrouter: false },
    })
    expect(r.text).not.toContain('sk-secret-meta-value')
  })

  it('answers unknown routes with the not_found envelope', async () => {
    const { call } = await boot()
    for (const [m, p] of [
      ['GET', '/nope'],
      ['GET', '/api'],
      ['GET', '/api/boards/x/y/z'],
    ] as const) {
      const r = await call(m, p)
      expect(r.status).toBe(404)
      expect(r.json.error.code).toBe('not_found')
    }
  })
})

describe('boards REST', () => {
  it('creates, lists newest first, reads, patches and deletes', async () => {
    const { json, call } = await boot()
    const a = await json('POST', '/api/boards', { title: 'Algebra' })
    expect(a.status).toBe(201)
    expect(a.json).toMatchObject({ title: 'Algebra', scope: {}, headSeq: 0 })
    const b = await json('POST', '/api/boards', {
      title: 'Geometry',
      scope: { kind: 'book', bookId: 'k1' },
    })
    expect(b.status).toBe(201)
    const list = await call('GET', '/api/boards')
    expect(list.json.boards.map((x: { title: string }) => x.title)).toEqual([
      'Geometry',
      'Algebra',
    ])
    const one = await call('GET', `/api/boards/${a.json.id}`)
    expect(one.json.title).toBe('Algebra')
    const patched = await json('PATCH', `/api/boards/${a.json.id}`, {
      title: 'Algebra 2',
    })
    expect(patched.status).toBe(200)
    expect(patched.json.title).toBe('Algebra 2')
    const del = await call('DELETE', `/api/boards/${a.json.id}`, {
      origin: ORIGIN,
    })
    expect(del.status).toBe(204)
    expect((await call('GET', `/api/boards/${a.json.id}`)).status).toBe(404)
    expect((await call('GET', '/api/boards')).json.boards).toHaveLength(1)
  })

  it('names the offending field for an invalid body', async () => {
    const { json } = await boot()
    for (const body of [
      {},
      { title: '' },
      { title: 'x'.repeat(201) },
      { title: 5 },
      { title: 'ok', scope: { kind: 'planet' } },
    ]) {
      const r = await json('POST', '/api/boards', body)
      expect(r.status).toBe(400)
      expect(r.json.error.code).toBe('validation_failed')
      expect(typeof r.json.error.details.field).toBe('string')
    }
    const made = await json('POST', '/api/boards', { title: 'ok' })
    expect(
      (await json('PATCH', `/api/boards/${made.json.id}`, {})).status,
    ).toBe(400)
  })

  it('404s an unknown board and a traversal-shaped id on every verb', async () => {
    const { json, call } = await boot()
    for (const id of ['nope', '..%2f..%2fetc', '%00', '%zz', 'a'.repeat(500)]) {
      expect((await call('GET', `/api/boards/${id}`)).status).toBe(404)
      expect(
        (await json('PATCH', `/api/boards/${id}`, { title: 'x' })).status,
      ).toBe(404)
      expect(
        (await call('DELETE', `/api/boards/${id}`, { origin: ORIGIN })).status,
      ).toBe(404)
    }
  })
})

describe('Origin gate and CORS (R3)', () => {
  const bad: [string, string | null][] = [
    ['none', null],
    ['null', 'null'],
    ['trailing slash', `${ORIGIN}/`],
    ['other port', 'http://localhost:3001'],
    ['evil', 'http://evil.test'],
  ]
  it.each(bad)(
    'refuses POST, PATCH and DELETE with Origin %s and changes nothing',
    async (_name, origin) => {
      const { json, call, boards } = await boot()
      const made = boards.createBoard('Keep me')
      const post = await json('POST', '/api/boards', { title: 'x' }, origin)
      expect(post.status).toBe(403)
      expect(post.json.error.code).toBe('forbidden_origin')
      const patch = await json(
        'PATCH',
        `/api/boards/${made.id}`,
        { title: 'hacked' },
        origin,
      )
      expect(patch.status).toBe(403)
      const del = await call(
        'DELETE',
        `/api/boards/${made.id}`,
        origin === null ? {} : { origin },
      )
      expect(del.status).toBe(403)
      expect(boards.listBoards().map((b) => b.title)).toEqual(['Keep me'])
    },
  )

  it('answers the web origin with CORS headers and any other origin with none', async () => {
    const { call } = await boot()
    const mine = await call('GET', '/api/health', { origin: ORIGIN })
    expect(mine.headers['access-control-allow-origin']).toBe(ORIGIN)
    expect(mine.headers.vary).toContain('Origin')
    for (const o of ['http://evil.test', 'null', `${ORIGIN}/`]) {
      const r = await call('GET', '/api/health', { origin: o })
      expect(r.status).toBe(200)
      expect(r.headers['access-control-allow-origin']).toBeUndefined()
    }
  })

  it('answers a preflight from the web origin only', async () => {
    const { call } = await boot()
    const ask = (origin: string) =>
      call('OPTIONS', '/api/boards', {
        origin,
        headers: {
          'Access-Control-Request-Method': 'POST',
          'Access-Control-Request-Headers': 'content-type',
        },
      })
    const ok = await ask(ORIGIN)
    expect(ok.status).toBe(204)
    expect(ok.headers['access-control-allow-origin']).toBe(ORIGIN)
    expect(ok.headers['access-control-allow-methods']).toContain('PATCH')
    expect(ok.headers['access-control-allow-headers']).toContain('content-type')
    const foreign = await ask('http://evil.test')
    expect(foreign.headers['access-control-allow-origin']).toBeUndefined()
    expect(foreign.headers['access-control-allow-methods']).toBeUndefined()
  })
})

describe('request bodies', () => {
  it('refuses a body over 1 MB with payload_too_large', async () => {
    const { call } = await boot()
    const big = JSON.stringify({ title: 'x'.repeat(1_048_576) })
    const r = await call('POST', '/api/boards', {
      origin: ORIGIN,
      headers: { 'Content-Type': 'application/json' },
      body: big,
    })
    expect(r.status).toBe(413)
    expect(r.json?.error.code).toBe('payload_too_large')
  })

  it('refuses a non-JSON content type and malformed JSON', async () => {
    const { call } = await boot()
    const text = await call('POST', '/api/boards', {
      origin: ORIGIN,
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify({ title: 'x' }),
    })
    expect(text.status).toBe(400)
    expect(text.json.error.code).toBe('validation_failed')
    const form = await call('POST', '/api/boards', {
      origin: ORIGIN,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'title=x',
    })
    expect(form.status).toBe(400)
    const broken = await call('POST', '/api/boards', {
      origin: ORIGIN,
      headers: { 'Content-Type': 'application/json' },
      body: '{"title": ',
    })
    expect(broken.status).toBe(400)
    expect(broken.json.error.code).toBe('validation_failed')
    const arr = await call('POST', '/api/boards', {
      origin: ORIGIN,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: '[1,2]',
    })
    expect(arr.status).toBe(400)
  })
})
