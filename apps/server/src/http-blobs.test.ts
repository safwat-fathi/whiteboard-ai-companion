import { existsSync, readdirSync } from 'node:fs'
import http from 'node:http'
import { dirname } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  jpeg as coreJpeg,
  png as corePng,
} from '../../../packages/core/src/test-images'
import { boot, ORIGIN } from './http-test-utils'

const ascii = (s: string) => Buffer.from(s, 'utf8')
const HEAD = corePng(10, 10).length
/** A PNG with a valid header followed by `extra` filler bytes (the filler is not image data). */
const png = (extra = 64, fill = 7) => Buffer.from(corePng(10, 10, extra, fill))
const upload = (
  call: Awaited<ReturnType<typeof boot>>['call'],
  body: Buffer,
  contentType = 'image/png',
  origin: string | null = ORIGIN,
) =>
  call('POST', '/api/blobs', {
    origin,
    headers: { 'Content-Type': contentType },
    body,
  })

describe('POST /api/blobs and GET /api/blobs/:id', () => {
  it('stores a PNG and serves it back byte-equal with the hardened headers', async () => {
    const { call } = await boot()
    const bytes = png()
    const up = await upload(call, bytes)
    expect(up.status).toBe(201)
    expect(up.json).toMatchObject({ mime: 'image/png', bytes: bytes.length })
    expect(up.json.id).toMatch(/^[0-9a-f]{64}$/)
    const got = await call('GET', `/api/blobs/${up.json.id}`)
    expect(got.status).toBe(200)
    expect(got.raw.equals(bytes)).toBe(true)
    expect(got.headers['content-type']).toBe('image/png')
    expect(got.headers['x-content-type-options']).toBe('nosniff')
    expect(got.headers['content-security-policy']).toBe("default-src 'none'")
    expect(got.headers['cache-control']).toBe(
      'public, max-age=31536000, immutable',
    )
    expect(got.headers['content-length']).toBe(String(bytes.length))
  })

  it('answers a second identical upload with 200 and the same id, and a HEAD with headers only', async () => {
    const { call } = await boot()
    const a = await upload(call, png())
    const b = await upload(call, png())
    expect(a.status).toBe(201)
    expect(b.status).toBe(200)
    expect(b.json.id).toBe(a.json.id)
    const head = await call('HEAD', `/api/blobs/${a.json.id}`)
    expect(head.status).toBe(200)
    expect(head.text).toBe('')
    expect(head.headers['content-type']).toBe('image/png')
  })

  it('ignores the claimed Content-Type: the sniffed type wins, and no header at all works', async () => {
    const { call } = await boot()
    const jpeg = Buffer.from(coreJpeg(10, 10, 32, 1))
    const up = await upload(call, jpeg, 'text/html')
    expect(up.json.mime).toBe('image/jpeg')
    const bare = await call('POST', '/api/blobs', {
      origin: ORIGIN,
      body: png(10, 3),
    })
    expect(bare.status).toBe(201)
  })

  it('refuses SVG, HTML, text and an empty body as a validation failure and stores nothing', async () => {
    const { call, db } = await boot()
    for (const body of [
      ascii(
        '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
      ),
      ascii('<!doctype html><script>alert(1)</script>'),
      ascii('GIF'),
      Buffer.alloc(0),
    ]) {
      const r = await upload(call, body, 'image/png')
      expect(r.status).toBe(400)
      expect(r.json.error.code).toBe('validation_failed')
    }
    expect(db.prepare('SELECT count(*) AS n FROM blobs').get()).toEqual({
      n: 0,
    })
  })

  it('refuses an image whose header claims an oversized picture with 413, whatever its byte size', async () => {
    const { call, db } = await boot()
    const r = await upload(call, Buffer.from(corePng(100_000, 100_000, 64)))
    expect(r.status).toBe(413)
    expect(r.json.error.code).toBe('payload_too_large')
    expect(db.prepare('SELECT count(*) AS n FROM blobs').get()).toEqual({
      n: 0,
    })
  })

  it('accepts exactly 10 MB and refuses one byte more with 413', async () => {
    const { call } = await boot()
    const tenMB = 10 * 2 ** 20
    const ok = await upload(call, png(tenMB - HEAD))
    expect(ok.status).toBe(201)
    const tooBig = await upload(call, png(tenMB - HEAD + 1, 9))
    expect(tooBig.status).toBe(413)
    expect(tooBig.json.error.code).toBe('payload_too_large')
  })

  it('refuses an oversized upload from its Content-Length, without waiting for the body', async () => {
    const { port } = await boot()
    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          method: 'POST',
          path: '/api/blobs',
          headers: {
            Origin: ORIGIN,
            'Content-Type': 'image/png',
            'Content-Length': String(500 * 2 ** 20),
          },
        },
        (res) => {
          resolve(res.statusCode ?? 0)
          req.destroy()
        },
      )
      req.on('error', () => {})
      req.write(png(1024)) // a kilobyte of a promised 500 MB: the answer must not wait for the rest
      setTimeout(() => reject(new Error('no early answer')), 3000)
    })
    expect(status).toBe(413)
  })

  it('stores nothing and answers 403 without the exact Origin', async () => {
    const { call, db } = await boot()
    for (const origin of [null, 'http://evil.test', 'null']) {
      const r = await upload(call, png(), 'image/png', origin)
      expect(r.status).toBe(403)
    }
    expect(db.prepare('SELECT count(*) AS n FROM blobs').get()).toEqual({
      n: 0,
    })
  })

  it('never reaches outside blobs/: traversal-shaped, malformed and unknown ids are 404', async () => {
    const { call } = await boot()
    for (const id of [
      '..%2f..%2fetc%2fpasswd',
      '%2e%2e',
      'zzz',
      '%zz',
      'a'.repeat(64),
      'A'.repeat(64),
      `${'a'.repeat(63)}%2f`,
    ]) {
      const r = await call('GET', `/api/blobs/${id}`)
      expect(r.status, id).toBe(404)
      expect(r.json.error.code).toBe('not_found')
    }
  })

  it('carries CORS headers for the web origin, and refuses a rebinding Host', async () => {
    const { call } = await boot()
    const up = await upload(call, png())
    const mine = await call('GET', `/api/blobs/${up.json.id}`, {
      origin: ORIGIN,
    })
    expect(mine.headers['access-control-allow-origin']).toBe(ORIGIN)
    const evil = await call('GET', `/api/blobs/${up.json.id}`, {
      headers: { Host: 'evil.test:4000' },
    })
    expect(evil.status).toBe(403)
  })

  it('leaves exactly one file on disk for two identical uploads', async () => {
    const { call, blobs } = await boot()
    const a = await upload(call, png(100, 5))
    await upload(call, png(100, 5))
    const dir = (blobs as unknown as { path(id: string): string }).path(
      a.json.id,
    )
    expect(existsSync(dir)).toBe(true)
    expect(readdirSync(dirname(dir))).toEqual([a.json.id])
  })
})
