import net from 'node:net'
import { describe, expect, it } from 'vitest'
import { checkHost, checkOrigin } from './http'
import { boot, ORIGIN } from './http-test-utils'

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

describe('checkHost (DNS rebinding)', () => {
  const cfg = { publicOrigin: 'https://study.example.com', host: '127.0.0.1' }
  it('allows loopback names, the public origin host and a specific bind host, with or without a port', () => {
    for (const h of [
      'localhost',
      'localhost:4000',
      '127.0.0.1:4000',
      '[::1]:4000',
      'LOCALHOST:4000',
      'study.example.com',
      'study.example.com:443',
    ])
      expect(checkHost(h, cfg), h).toBe(true)
    expect(checkHost('10.0.0.5:4000', { ...cfg, host: '10.0.0.5' })).toBe(true)
  })
  it('refuses any other name, a missing or empty Host, and values that only parse as an allowed name', () => {
    for (const h of [
      undefined,
      '',
      'evil.test',
      'evil.test:4000',
      'localhost.evil.test',
      'evil.test@localhost',
      'localhost@evil.test',
      'localhost:4000@evil.test',
      'localhost:abc',
      'localhost:4000/path',
      'local host',
      '10.0.0.5:4000',
    ])
      expect(checkHost(h, cfg), String(h)).toBe(false)
  })
  it('does not treat a wildcard bind address as an allowed Host', () => {
    expect(checkHost('0.0.0.0:4000', { ...cfg, host: '0.0.0.0' })).toBe(false)
  })
})

describe('Host gate on the server (DNS rebinding)', () => {
  it('refuses a rebinding Host on GET, preflight and POST, and accepts the loopback names', async () => {
    const { call, boards, port } = await boot()
    boards.createBoard('private')
    for (const host of [
      'evil.test:4000',
      'evil.test@localhost',
      'localhost.evil.test',
    ]) {
      const get = await call('GET', '/api/boards', { headers: { Host: host } })
      expect(get.status, host).toBe(403)
      expect(get.json.error.code).toBe('forbidden_origin')
      expect(get.text).not.toContain('private')
      expect(
        (
          await call('OPTIONS', '/api/boards', {
            origin: ORIGIN,
            headers: { Host: host },
          })
        ).status,
      ).toBe(403)
      expect(
        (await call('GET', '/api/health', { headers: { Host: host } })).status,
      ).toBe(403)
    }
    // An empty or absent Host never reaches the handler through Node's http client, so send it raw.
    const raw = (head: string) =>
      new Promise<string>((resolve, reject) => {
        const sock = net.connect(port, '127.0.0.1', () =>
          sock.write(
            `GET /api/boards HTTP/1.1\r\n${head}Connection: close\r\n\r\n`,
          ),
        )
        let out = ''
        sock.on('data', (d) => {
          out += d
        })
        sock.on('close', () => resolve(out))
        sock.on('error', reject)
      })
    expect(await raw('Host: \r\n')).toMatch(/^HTTP\/1\.1 403 /)
    expect(await raw('')).toMatch(/^HTTP\/1\.1 400 /) // Node itself refuses an HTTP/1.1 request with no Host
    expect(await raw('Host: evil.test\r\n')).toMatch(/^HTTP\/1\.1 403 /)
    for (const host of ['localhost:4000', '127.0.0.1:4000', '[::1]:4000'])
      expect(
        (await call('GET', '/api/boards', { headers: { Host: host } })).status,
        host,
      ).toBe(200)
  })
})

describe('health and routing', () => {
  it('reports the schema version and key presence, never a key value', async () => {
    const { call } = await boot()
    const r = await call('GET', '/api/health')
    expect(r.status).toBe(200)
    expect(r.json).toEqual({
      ok: true,
      migrations: 2,
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
