import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { blobPath } from './blobs'
import { boot, ORIGIN } from './http-test-utils'
import { makeTestPdf } from './library/test-pdf'

const PROSE =
  'The quick brown fox jumps over the lazy dog and keeps running through the long green meadow.'
const MATH = 'x = 2 + 3 × 4 ÷ 5 = 6 + 7 - 8 + 9 = 10 + 11 × 12 '.repeat(2)
const PDF = Buffer.from(
  makeTestPdf({
    pages: [PROSE, '', MATH],
    outline: [
      { title: 'Chapter 1', page: 1 },
      { title: 'Chapter 2', page: 3 },
    ],
    labels: [{ from: 1, style: 'r' }],
  }),
)
type H = Awaited<ReturnType<typeof boot>>

const upload = (
  h: H,
  body: Buffer | string = PDF,
  query = '?title=My%20Book',
  contentType = 'application/pdf',
  origin: string | null = ORIGIN,
) =>
  h.call('POST', `/api/books${query}`, {
    origin,
    headers: { 'Content-Type': contentType },
    body: typeof body === 'string' ? Buffer.from(body) : body,
  })
const post = (
  h: H,
  path: string,
  body?: unknown,
  origin: string | null = ORIGIN,
) =>
  h.call('POST', path, {
    origin,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
/** An uploaded book (not yet indexed) and its id. */
const addBook = async (h: H) => (await upload(h)).json.id as string
/** An indexed, ready book. */
async function readyBook(h: H) {
  const id = await addBook(h)
  expect((await post(h, `/api/books/${id}/index`)).status).toBe(202)
  await h.queue.whenIdle()
  expect(h.booksDb.getBook(id)?.status).toBe('ready')
  return id
}

describe('POST /api/books', () => {
  it('stores a PDF and returns the book, uploaded and not yet indexed', async () => {
    const h = await boot()
    const r = await upload(h)
    expect(r.status).toBe(201)
    expect(r.json).toMatchObject({
      title: 'My Book',
      pages: 3,
      status: 'uploaded',
      progress: 0,
      error: null,
    })
    expect(r.json.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(r.json).not.toHaveProperty('fileBlob')
    const list = await h.call('GET', '/api/books')
    expect(list.json.books.map((b: { id: string }) => b.id)).toEqual([
      r.json.id,
    ])
    const one = await h.call('GET', `/api/books/${r.json.id}`)
    expect(one.json).toMatchObject({
      id: r.json.id,
      chunks: 0,
      methods: { R1: 0, R3: 0, R4: 0 },
    })
    expect((await h.call('GET', '/api/books/nope')).status).toBe(404)
  })

  it('uses a default title when none is given and refuses an empty or over-long one', async () => {
    const h = await boot()
    expect((await upload(h, PDF, '')).json.title).toBe('Untitled book')
    expect((await upload(h, PDF, '?title=')).status).toBe(400)
    expect((await upload(h, PDF, `?title=${'x'.repeat(201)}`)).status).toBe(400)
  })

  it('refuses what is not a PDF: wrong type, HTML named pdf, empty, corrupt, too many pages', async () => {
    const h = await boot()
    const wrongType = await upload(h, PDF, '', 'application/json')
    expect(wrongType.status).toBe(400)
    expect(wrongType.json.error.code).toBe('validation_failed')
    const html = await upload(h, '<html>not a pdf</html>'.repeat(100))
    expect(html.status).toBe(400)
    expect((await upload(h, '')).status).toBe(400)
    const corrupt = await upload(h, '%PDF-1.7 garbage')
    expect(corrupt.status).toBe(422)
    expect(corrupt.json.error.code).toBe('ingest_failed')
    const big = await upload(
      h,
      Buffer.from(makeTestPdf({ pages: Array(2001).fill('') })),
    )
    expect(big.status).toBe(422)
    expect(big.json.error.details).toMatchObject({ limit: 2000 })
    expect(h.booksDb.listBooks()).toEqual([])
    const stored = existsSync(join(h.dataDir, 'blobs'))
      ? readdirSync(join(h.dataDir, 'blobs'))
      : []
    expect(stored).toEqual([]) // refused files are not kept
    expect(readdirSync(join(h.dataDir, 'tmp'))).toEqual([])
  })

  it('refuses a body over the limit with 413 and leaves nothing behind', async () => {
    const h = await boot({ maxPdfBytes: 2000 })
    const r = await upload(
      h,
      Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(5000, 65)]),
    )
    expect(r.status).toBe(413)
    expect(r.json.error.code).toBe('payload_too_large')
    expect(readdirSync(join(h.dataDir, 'tmp'))).toEqual([])
  })

  it('answers a foreign or missing Origin with forbidden_origin on every non-GET route', async () => {
    const h = await boot()
    const id = await addBook(h)
    for (const origin of ['http://evil.test', null]) {
      const calls = [
        upload(h, PDF, '', 'application/pdf', origin),
        post(h, `/api/books/${id}/index`, {}, origin),
        post(h, `/api/books/${id}/retry`, {}, origin),
        post(h, `/api/books/${id}/preview`, { pages: [1] }, origin),
        post(h, '/api/search', { query: 'fox' }, origin),
        h.call('DELETE', `/api/books/${id}`, { origin: origin ?? undefined }),
      ]
      for (const r of await Promise.all(calls)) {
        expect(r.status).toBe(403)
        expect(r.json.error.code).toBe('forbidden_origin')
      }
    }
    expect(h.booksDb.listBooks()).toHaveLength(1)
    expect(h.booksDb.getBook(id)?.status).toBe('uploaded')
  })
})

describe('estimate and preview', () => {
  it('estimates routing and cost without spending anything or changing the book', async () => {
    const h = await boot()
    const id = await addBook(h)
    const r = await h.call('GET', `/api/books/${id}/estimate`)
    expect(r.status).toBe(200)
    expect(r.json).toMatchObject({
      pages: 3,
      r1: 1,
      r4: 2,
      scanned: 1,
      mathDense: 1,
      dailyRemainingUsd: 5,
    })
    expect(r.json.embedUsd).toBeGreaterThan(0)
    expect(h.booksDb.spentSince(0)).toBe(0)
    expect(h.booksDb.getBook(id)?.status).toBe('uploaded')
    expect((await h.call('GET', '/api/books/nope/estimate')).status).toBe(404)
  })

  it('previews up to three pages as the local text beside the vision text, for free', async () => {
    const h = await boot()
    const id = await addBook(h)
    const r = await post(h, `/api/books/${id}/preview`, { pages: [1, 2] })
    expect(r.status).toBe(200)
    expect(r.json.pages).toHaveLength(2)
    expect(r.json.pages[0]).toMatchObject({
      page: 1,
      label: 'i',
      imageUrl: `/api/books/${id}/pages/1/image`,
      r1: { text: expect.stringContaining('quick brown fox') },
      r4: { text: 'stub transcription', truncated: false },
    })
    expect(h.booksDb.spentSince(0)).toBe(0)
    expect(h.booksDb.getBook(id)?.status).toBe('uploaded')
    expect(h.booksDb.pagesDone(id)).toEqual([])
  })

  it('reports a failed vision call inside the preview instead of failing it', async () => {
    const h = await boot({
      providers: {
        async transcribePage() {
          throw new Error('META_API_KEY is not set')
        },
      },
    })
    const id = await addBook(h)
    const r = await post(h, `/api/books/${id}/preview`, { pages: [1] })
    expect(r.status).toBe(200)
    expect(r.json.pages[0].r4).toEqual({
      error: expect.stringContaining('META_API_KEY'),
    })
    expect(r.json.pages[0].r1.text).toContain('quick')
  })

  it('refuses more than three pages, none, or pages outside the book', async () => {
    const h = await boot()
    const id = await addBook(h)
    for (const pages of [[1, 2, 3, 3], [], [0], [4], [1.5], 'x']) {
      const r = await post(h, `/api/books/${id}/preview`, { pages })
      expect(r.status).toBe(400)
      expect(r.json.error.code).toBe('validation_failed')
    }
  })
})

describe('index, retry, delete', () => {
  it('indexes a book in the background and then serves its outline, pages, chunks and search', async () => {
    const h = await boot()
    const id = await addBook(h)
    const idx = await post(h, `/api/books/${id}/index`)
    expect(idx.status).toBe(202)
    expect(idx.json).toMatchObject({ id, status: 'queued' })
    await h.queue.whenIdle()

    const book = (await h.call('GET', `/api/books/${id}`)).json
    expect(book).toMatchObject({
      status: 'ready',
      progress: 1,
      methods: { R1: 1, R4: 2, R3: 0 },
    })
    expect(book.chunks).toBeGreaterThan(0)

    const outline = (await h.call('GET', `/api/books/${id}/outline`)).json
    expect(outline.sections.map((s: { title: string }) => s.title)).toEqual([
      'Chapter 1',
      'Chapter 2',
    ])
    expect(outline.sections[0]).toMatchObject({
      level: 1,
      pageStart: 1,
      pageEnd: 2,
      parentId: null,
    })
    expect(outline.sections[0].summary).toMatch(/^summary:/)

    const page = (await h.call('GET', `/api/books/${id}/pages/1`)).json
    expect(page).toMatchObject({ page: 1, label: 'i', method: 'R1' })
    expect(page.text).toContain('quick brown fox')
    expect((await h.call('GET', `/api/books/${id}/pages/99`)).status).toBe(404)
    expect((await h.call('GET', `/api/books/${id}/pages/abc`)).status).toBe(404)

    const found = await post(h, '/api/search', {
      query: 'quick brown fox',
      bookId: id,
      k: 3,
    })
    expect(found.status).toBe(200)
    expect(found.json.mode).toBe('hybrid')
    const top = found.json.hits[0]
    expect(top).toMatchObject({
      bookId: id,
      pageStart: 1,
      citeLabel: 'pp. i\u2013ii',
    })
    expect(top.text).toContain('quick brown fox')

    const chunk = await h.call('GET', `/api/books/${id}/chunks/${top.chunkId}`)
    expect(chunk.json).toMatchObject({
      id: top.chunkId,
      bookId: id,
      pageStart: 1,
      citeLabel: 'pp. i\u2013ii',
    })
    expect((await h.call('GET', `/api/books/${id}/chunks/999999`)).status).toBe(
      404,
    )
    const other = await readyBook(h)
    expect(
      (await h.call('GET', `/api/books/${other}/chunks/${top.chunkId}`)).status,
    ).toBe(404) // a chunk of another book
  })

  it('takes page-range overrides for the opt-in R3 and refuses ones outside the book', async () => {
    const h = await boot()
    const id = await addBook(h)
    const bad = await post(h, `/api/books/${id}/index`, {
      methods: [{ from: 1, to: 9, rung: 'R3' }],
    })
    expect(bad.status).toBe(400)
    expect(
      (
        await post(h, `/api/books/${id}/index`, {
          methods: [{ from: 1, to: 1, rung: 'R2' }],
        })
      ).status,
    ).toBe(400)
    expect(h.booksDb.getBook(id)?.status).toBe('uploaded')
    const ok = await post(h, `/api/books/${id}/index`, {
      methods: [{ from: 1, to: 1, rung: 'R3' }],
    })
    expect(ok.status).toBe(202)
    await h.queue.whenIdle()
    expect(h.booksDb.getPage(id, 1)?.method).toBe('R3')
  })

  it('refuses an R3 run that would pass the daily cap before queueing anything', async () => {
    const h = await boot({ dailyBudget: '0.001' })
    const id = await addBook(h)
    const r = await post(h, `/api/books/${id}/index`, {
      methods: [{ from: 1, to: 3, rung: 'R3' }],
    })
    expect(r.status).toBe(429)
    expect(r.json.error).toMatchObject({
      code: 'budget_exceeded',
      details: { cap: 'daily' },
    })
    expect(h.queue.size()).toBe(0)
    expect(h.booksDb.getBook(id)?.status).toBe('uploaded')
  })

  it('answers conflict while a book is being indexed, and lets a failed one be retried', async () => {
    const h = await boot()
    const id = await addBook(h)
    h.booksDb.setStatus(id, 'extracting', { progress: 0.3 })
    for (const path of [`/api/books/${id}/index`, `/api/books/${id}/retry`]) {
      const r = await post(h, path)
      expect(r.status).toBe(409)
      expect(r.json.error.code).toBe('conflict')
    }
    expect(
      (await h.call('DELETE', `/api/books/${id}`, { origin: ORIGIN })).status,
    ).toBe(409)
    h.booksDb.setStatus(id, 'failed', { error: 'embedding: boom' })
    expect((await post(h, `/api/books/${id}/retry`)).status).toBe(202)
    await h.queue.whenIdle()
    expect(h.booksDb.getBook(id)).toMatchObject({
      status: 'ready',
      error: null,
    })
    expect((await post(h, `/api/books/${id}/retry`)).status).toBe(202) // a ready book may be retried too (missing summaries)
    expect((await post(h, '/api/books/nope/retry')).status).toBe(404)
  })

  it('refuses a retry of a book that was never indexed', async () => {
    const h = await boot()
    const id = await addBook(h)
    expect((await post(h, `/api/books/${id}/retry`)).status).toBe(409)
  })

  it('deletes a ready book with its file, its page images and its vectors', async () => {
    const h = await boot()
    const id = await readyBook(h)
    await h.call('GET', `/api/books/${id}/pages/1/image?w=300`)
    const blob = h.booksDb.getBook(id)?.fileBlob as string
    const cache = join(h.dataDir, 'cache', 'pages', id)
    expect(existsSync(blobPath(h.dataDir, blob))).toBe(true)
    expect(existsSync(cache)).toBe(true)
    const del = await h.call('DELETE', `/api/books/${id}`, { origin: ORIGIN })
    expect(del.status).toBe(204)
    expect((await h.call('GET', `/api/books/${id}`)).status).toBe(404)
    expect(existsSync(blobPath(h.dataDir, blob))).toBe(false)
    expect(existsSync(cache)).toBe(false)
    expect(
      (await h.call('DELETE', `/api/books/${id}`, { origin: ORIGIN })).status,
    ).toBe(404)
  })

  it('keeps a shared file until its last book is deleted, and deletes an unindexed book freely', async () => {
    const h = await boot()
    const a = await addBook(h)
    const b = await addBook(h)
    const blob = h.booksDb.getBook(a)?.fileBlob as string
    expect(h.booksDb.getBook(b)?.fileBlob).toBe(blob)
    await h.call('DELETE', `/api/books/${a}`, { origin: ORIGIN })
    expect(existsSync(blobPath(h.dataDir, blob))).toBe(true)
    await h.call('DELETE', `/api/books/${b}`, { origin: ORIGIN })
    expect(existsSync(blobPath(h.dataDir, blob))).toBe(false)
  })
})

describe('GET /api/books/:id/file', () => {
  it('serves the PDF whole, as a range, as a suffix range, and refuses an unsatisfiable one', async () => {
    const h = await boot()
    const id = await addBook(h)
    const url = `/api/books/${id}/file`
    const full = await h.call('GET', url)
    expect(full.status).toBe(200)
    expect(full.raw.equals(PDF)).toBe(true)
    expect(full.headers['content-type']).toBe('application/pdf')
    expect(full.headers['accept-ranges']).toBe('bytes')
    expect(full.headers['x-content-type-options']).toBe('nosniff')
    const part = await h.call('GET', url, { headers: { Range: 'bytes=0-9' } })
    expect(part.status).toBe(206)
    expect(part.headers['content-range']).toBe(`bytes 0-9/${PDF.length}`)
    expect(part.raw.equals(PDF.subarray(0, 10))).toBe(true)
    const tail = await h.call('GET', url, { headers: { Range: 'bytes=-5' } })
    expect(tail.status).toBe(206)
    expect(tail.raw.equals(PDF.subarray(PDF.length - 5))).toBe(true)
    const open = await h.call('GET', url, {
      headers: { Range: `bytes=${PDF.length - 3}-` },
    })
    expect(open.raw.equals(PDF.subarray(PDF.length - 3))).toBe(true)
    const past = await h.call('GET', url, {
      headers: { Range: `bytes=${PDF.length + 10}-` },
    })
    expect(past.status).toBe(416)
    expect(past.headers['content-range']).toBe(`bytes */${PDF.length}`)
    const head = await h.call('HEAD', url)
    expect(head.status).toBe(200)
    expect(head.headers['content-length']).toBe(String(PDF.length))
    expect(head.text).toBe('')
  })

  it('answers 404 for an unknown book and for an id that tries to be a path', async () => {
    const h = await boot()
    for (const id of [
      'nope',
      '..%2F..%2Fetc%2Fpasswd',
      '%2e%2e',
      'a'.repeat(300),
    ])
      expect((await h.call('GET', `/api/books/${id}/file`)).status).toBe(404)
  })
})

describe('GET /api/books/:id/pages/:n/image', () => {
  it('renders the page at the width asked, caches it on disk and serves the cache', async () => {
    const h = await boot()
    const id = await addBook(h)
    const r = await h.call('GET', `/api/books/${id}/pages/1/image?w=300`)
    expect(r.status).toBe(200)
    expect(r.headers['content-type']).toBe('image/png')
    expect(r.headers['x-content-type-options']).toBe('nosniff')
    expect(new DataView(r.raw.buffer, r.raw.byteOffset).getUint32(16)).toBe(300)
    const file = join(h.dataDir, 'cache', 'pages', id, '1@300.png')
    expect(existsSync(file)).toBe(true)
    const again = await h.call('GET', `/api/books/${id}/pages/1/image?w=300`)
    expect(again.raw.equals(r.raw)).toBe(true)
  })

  it('clamps the width to 256..2048 and refuses pages outside the book', async () => {
    const h = await boot()
    const id = await addBook(h)
    const width = async (w: string) => {
      const r = await h.call('GET', `/api/books/${id}/pages/1/image?w=${w}`)
      return new DataView(r.raw.buffer, r.raw.byteOffset).getUint32(16)
    }
    expect(await width('10')).toBe(256)
    expect(await width('99999')).toBe(2048)
    expect(await width('abc')).toBe(1000)
    for (const n of ['0', '4', 'x', '-1'])
      expect(
        (await h.call('GET', `/api/books/${id}/pages/${n}/image`)).status,
      ).toBe(404)
  })
})

describe('POST /api/search', () => {
  it('validates the body and names the field', async () => {
    const h = await boot()
    for (const body of [
      {},
      { query: '' },
      { query: 'x'.repeat(501) },
      { query: 'a', k: 0 },
      { query: 'a', k: 51 },
      { query: 'a', sectionIds: ['x'] },
    ]) {
      const r = await post(h, '/api/search', body)
      expect(r.status).toBe(400)
      expect(r.json.error.code).toBe('validation_failed')
    }
    expect(
      (await post(h, '/api/search', { query: 'a', bookId: 'nope' })).status,
    ).toBe(404)
  })

  it('searches the whole library when no book is named, and honours sections and neighbours', async () => {
    const h = await boot()
    const id = await readyBook(h)
    const all = await post(h, '/api/search', { query: 'quick brown fox' })
    expect(all.json.hits[0].bookId).toBe(id)
    const sections = (await h.call('GET', `/api/books/${id}/outline`)).json
      .sections
    const second = sections[1].id
    const scoped = await post(h, '/api/search', {
      query: 'quick brown fox',
      bookId: id,
      sectionIds: [second],
    })
    expect(
      scoped.json.hits.every(
        (x: { sectionId: number }) => x.sectionId === second,
      ),
    ).toBe(true)
    const nb = await post(h, '/api/search', {
      query: 'quick brown fox',
      bookId: id,
      k: 1,
      neighbors: true,
    })
    expect(nb.json.hits.length).toBeGreaterThan(1)
    expect(
      nb.json.hits.slice(1).every((x: { neighbor: boolean }) => x.neighbor),
    ).toBe(true)
  })

  it('falls back to keywords and says so when the embedding provider is down', async () => {
    const h = await boot({
      providers: {
        async embed(texts) {
          if (texts.length === 1) throw new Error('down')
          return { vectors: texts.map(() => new Float32Array(16)), costUsd: 0 }
        },
      },
    })
    const id = await addBook(h)
    await post(h, `/api/books/${id}/index`)
    await h.queue.whenIdle()
    const r = await post(h, '/api/search', {
      query: 'quick brown fox',
      bookId: id,
    })
    expect(r.json.mode).toBe('keyword')
    expect(r.json.hits[0].text).toContain('quick brown fox')
  })
})
