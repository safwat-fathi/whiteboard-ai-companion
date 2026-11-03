import { randomUUID } from 'node:crypto'
import {
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import { blobPath } from './blobs'
import type { Config } from './config'
import type { BlobsDb, BookRow, BooksDb } from './db'
import { ApiError, apiError } from './errors'
import { drain, MAX_JSON_BYTES, parse, readBody, send } from './http-util'
import { createSearcher } from './library/embed-search'
import { MAX_PDF_BYTES, putPdf } from './library/files'
import { pageRaster } from './library/page-image'
import { type OpenPdf, openPdf } from './library/pdf'
import type { Providers } from './library/providers'
import {
  analyzePdf,
  type Estimate,
  estimate,
  R3_USD_PER_PAGE,
} from './library/route'
import type { VectorCache } from './library/search'

export type LibraryDeps = {
  books: BooksDb
  blobs: BlobsDb
  dataDir: string
  config: Config
  providers: Providers
  cache: VectorCache
  /** Puts a book on the ingest queue. */
  enqueue: (bookId: string) => boolean
  maxPdfBytes?: number
  now?: () => number
}

const ID = /^[A-Za-z0-9-]{1,64}$/
const IN_PROGRESS = [
  'queued',
  'extracting',
  'structuring',
  'embedding',
  'summarising',
]
const PREVIEW_MAX_PAGES = 3
const DAY_MS = 86_400_000
const DEFAULT_WIDTH = 1000
const MIN_WIDTH = 256
const MAX_WIDTH = 2048

const Title = z.string().trim().min(1).max(200)
const Preview = z.object({
  pages: z.array(z.number().int().min(1)).min(1).max(PREVIEW_MAX_PAGES),
})
const Methods = z.object({
  methods: z
    .array(
      z.object({
        from: z.number().int().min(1),
        to: z.number().int().min(1),
        rung: z.enum(['R1', 'R3', 'R4']),
      }),
    )
    .max(200)
    .optional(),
})
const Search = z.object({
  query: z.string().trim().min(1).max(500),
  bookId: z.string().max(64).optional(),
  sectionIds: z.array(z.number().int()).max(200).optional(),
  k: z.number().int().min(1).max(50).optional(),
  neighbors: z.boolean().optional(),
})

const decode = (raw: string): string => {
  try {
    return decodeURIComponent(raw)
  } catch {
    return ''
  }
}
const notFound = (what: string) => apiError('not_found', `no such ${what}`)

/** An optional JSON body: none at all is `{}`. */
async function readOptionalJson(req: IncomingMessage): Promise<unknown> {
  const raw = await readBody(req, MAX_JSON_BYTES)
  if (raw.length === 0) return {}
  if (!/^application\/json\s*(;|$)/i.test(req.headers['content-type'] ?? ''))
    throw apiError('validation_failed', 'Content-Type must be application/json')
  try {
    return JSON.parse(raw.toString('utf8'))
  } catch {
    throw apiError('validation_failed', 'the body is not valid JSON')
  }
}

function sendBytes(
  res: ServerResponse,
  status: number,
  bytes: Buffer | null,
  headers: Record<string, string | number>,
) {
  res.writeHead(status, {
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  })
  res.end(bytes ?? undefined)
}

/** Removes empty `blobs/ab/cd` parents left behind by a deleted file. */
function pruneDirs(file: string) {
  for (const dir of [dirname(file), dirname(dirname(file))]) {
    try {
      rmdirSync(dir)
    } catch {
      return
    }
  }
}

/**
 * The library REST routes (api.md): upload, estimate, preview, index, retry, delete, outline, file with range requests,
 * pages and their images, chunks and search. Returns a handler that answers a request and returns true, or returns
 * false for a path that is not one of its own. The caller has already checked Host and Origin.
 */
export function createLibraryRoutes(lib: LibraryDeps) {
  const { books, config } = lib
  const now = lib.now ?? Date.now
  const estimates = new Map<string, Estimate>()
  const searcher = createSearcher({
    books,
    cache: lib.cache,
    providers: lib.providers,
    config,
    now,
  })

  const bookOf = (rawId: string | undefined): BookRow => {
    const id = decode(rawId ?? '')
    const book = ID.test(id) ? books.getBook(id) : undefined
    if (!book) throw notFound('book')
    return book
  }
  const bookJson = (b: BookRow) => ({
    id: b.id,
    title: b.title,
    author: b.author,
    lang: b.lang,
    pages: b.pages,
    status: b.status,
    progress: b.progress,
    error: b.error,
    createdAt: b.createdAt,
    embedModel: b.embedModel,
    ingestMethod: b.ingestMethod,
    methods: books.methodCounts(b.id),
    chunks: books.chunkCount(b.id),
  })
  const file = (b: BookRow) => blobPath(lib.dataDir, b.fileBlob)
  const openBook = (b: BookRow): Promise<OpenPdf> => {
    try {
      return openPdf(new Uint8Array(readFileSync(file(b))))
    } catch (e) {
      if (e instanceof ApiError) throw e
      throw notFound('file for this book')
    }
  }
  const remaining = () => {
    const dayStart = now() - (now() % DAY_MS)
    return Math.max(0, config.dailyBudgetUsd - books.spentSince(dayStart))
  }
  const estimateOf = async (b: BookRow): Promise<Estimate> => {
    const known = estimates.get(b.id)
    if (known) return known
    const pdf = await openBook(b)
    try {
      const e = estimate(await analyzePdf(pdf))
      estimates.set(b.id, e)
      return e
    } finally {
      await pdf.close()
    }
  }
  const dropBlob = (id: string) => {
    if (books.blobInUse(id)) return
    lib.blobs.remove(id)
    const f = blobPath(lib.dataDir, id)
    rmSync(f, { force: true })
    pruneDirs(f)
  }

  async function upload(req: IncomingMessage, res: ServerResponse) {
    if (!/^application\/pdf\s*(;|$)/i.test(req.headers['content-type'] ?? ''))
      throw apiError(
        'validation_failed',
        'Content-Type must be application/pdf',
      )
    const url = new URL(req.url ?? '/', 'http://localhost')
    const raw = url.searchParams.get('title')
    const title = raw === null ? 'Untitled book' : parse(Title, raw)
    const max = lib.maxPdfBytes ?? MAX_PDF_BYTES
    const tooLarge = () =>
      apiError('payload_too_large', `the PDF may be at most ${max} bytes`, {
        limit: max,
      })
    if (Number(req.headers['content-length']) > max) {
      drain(req)
      throw tooLarge()
    }
    let stored: { id: string; bytes: number }
    try {
      // destroyOnReturn: false, so a refusal leaves the socket alone and the client can read the 413
      stored = await putPdf(req.iterator({ destroyOnReturn: false }), {
        dataDir: lib.dataDir,
        blobs: lib.blobs,
        maxBytes: max,
        now,
      })
    } catch (e) {
      if (e instanceof ApiError) drain(req)
      throw e
    }
    let pages: number
    try {
      const pdf = await openPdf(
        new Uint8Array(readFileSync(blobPath(lib.dataDir, stored.id))),
      )
      pages = pdf.numPages
      await pdf.close()
    } catch (e) {
      dropBlob(stored.id)
      throw e
    }
    const book = books.createBook(
      { id: randomUUID(), title, pages, fileBlob: stored.id },
      now(),
    )
    send(res, 201, bookJson(book))
  }

  async function preview(
    req: IncomingMessage,
    res: ServerResponse,
    book: BookRow,
  ) {
    const body = parse(Preview, await readJsonBody(req))
    const pdf = await openBook(book)
    try {
      const bad = body.pages.find((n) => n > pdf.numPages)
      if (bad !== undefined)
        throw apiError(
          'validation_failed',
          `pages ${bad} is past the last page (${pdf.numPages})`,
          {
            field: 'pages',
          },
        )
      const out = []
      for (const n of body.pages) {
        let r4: { text: string; truncated: boolean } | { error: string }
        try {
          r4 = await lib.providers.transcribePage(await pdf.renderPage(n, 1100))
        } catch (e) {
          r4 = { error: e instanceof Error ? e.message : String(e) }
        }
        out.push({
          page: n,
          label: pdf.labels[n - 1] ?? String(n),
          imageUrl: `/api/books/${book.id}/pages/${n}/image`,
          r1: { text: await pdf.pageText(n) },
          r4,
        })
      }
      send(res, 200, { pages: out })
    } finally {
      await pdf.close()
    }
  }

  async function start(
    req: IncomingMessage,
    res: ServerResponse,
    book: BookRow,
    kind: 'index' | 'retry',
  ) {
    const allowed =
      kind === 'index' ? ['uploaded', 'failed', 'ready'] : ['failed', 'ready']
    if (!allowed.includes(book.status))
      throw apiError(
        'conflict',
        IN_PROGRESS.includes(book.status)
          ? 'this book is being indexed'
          : `a book that is ${book.status} cannot be ${kind === 'index' ? 'indexed' : 'retried'}`,
        { status: book.status },
      )
    const body = parse(Methods, await readOptionalJson(req))
    let ranges = body.methods
    if (ranges) {
      const last = book.pages ?? Number.MAX_SAFE_INTEGER
      for (const [i, r] of ranges.entries())
        if (r.to < r.from || r.to > last)
          throw apiError(
            'validation_failed',
            `methods.${i} is not a page range inside the book`,
            {
              field: `methods.${i}`,
            },
          )
    } else ranges = book.ingestMethod?.ranges
    const r3 = new Set<number>()
    for (const r of ranges ?? [])
      if (r.rung === 'R3') for (let p = r.from; p <= r.to; p++) r3.add(p)
    if (r3.size > 0) {
      const need = r3.size * R3_USD_PER_PAGE + (await estimateOf(book)).embedUsd
      if (need > remaining())
        throw apiError(
          'budget_exceeded',
          `this would cost about $${need.toFixed(4)} and $${remaining().toFixed(4)} is left of today's $${config.dailyBudgetUsd}`,
          { cap: 'daily' },
        )
    }
    if (body.methods)
      books.setIngestMethod(book.id, {
        ...book.ingestMethod,
        ranges: body.methods,
      })
    books.setStatus(book.id, 'queued', { progress: 0 })
    lib.enqueue(book.id)
    send(res, 202, { id: book.id, status: 'queued' })
  }

  function serveFile(req: IncomingMessage, res: ServerResponse, book: BookRow) {
    const path = file(book)
    let size: number
    try {
      size = statSync(path).size
    } catch {
      throw notFound('file for this book')
    }
    const base = {
      'Content-Type': 'application/pdf',
      'Accept-Ranges': 'bytes',
      'X-Content-Type-Options': 'nosniff',
      'Content-Disposition': 'inline',
      'Cache-Control': 'private, max-age=3600',
    }
    let start = 0
    let end = size - 1
    let status = 200
    const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '')
    if (m && (m[1] || m[2])) {
      if (m[1] === '') {
        start = Math.max(0, size - Number(m[2]))
      } else {
        start = Number(m[1])
        if (m[2] !== '') end = Math.min(Number(m[2]), size - 1)
      }
      if (start >= size || start > end) {
        res.writeHead(416, {
          'Content-Range': `bytes */${size}`,
          'X-Content-Type-Options': 'nosniff',
        })
        return void res.end()
      }
      status = 206
    }
    res.writeHead(status, {
      ...base,
      'Content-Length': end - start + 1,
      ...(status === 206
        ? { 'Content-Range': `bytes ${start}-${end}/${size}` }
        : {}),
    })
    if (req.method === 'HEAD') return void res.end()
    createReadStream(path, { start, end })
      .on('error', () => res.destroy())
      .pipe(res)
  }

  async function pageImage(
    req: IncomingMessage,
    res: ServerResponse,
    book: BookRow,
    n: number,
  ) {
    const q = Number(
      new URL(req.url ?? '/', 'http://localhost').searchParams.get('w'),
    )
    const w =
      Number.isFinite(q) && q > 0
        ? Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.round(q)))
        : DEFAULT_WIDTH
    const bytes = await pageRaster({ dataDir: lib.dataDir, book, n, width: w })
    sendBytes(res, 200, bytes, {
      'Content-Type': 'image/png',
      'Content-Length': bytes.length,
      'Cache-Control': 'private, max-age=86400',
    })
  }

  async function readJsonBody(req: IncomingMessage): Promise<unknown> {
    if (!/^application\/json\s*(;|$)/i.test(req.headers['content-type'] ?? ''))
      throw apiError(
        'validation_failed',
        'Content-Type must be application/json',
      )
    const raw = await readBody(req, MAX_JSON_BYTES)
    try {
      return JSON.parse(raw.toString('utf8'))
    } catch {
      throw apiError('validation_failed', 'the body is not valid JSON')
    }
  }

  return async function handle(
    req: IncomingMessage,
    res: ServerResponse,
    seg: string[],
    method: string,
  ): Promise<boolean> {
    if (seg[1] === 'search' && seg.length === 2 && method === 'POST') {
      const body = parse(Search, await readJsonBody(req))
      if (body.bookId !== undefined && !books.getBook(body.bookId))
        throw notFound('book')
      const result = await searcher(body)
      send(res, 200, result)
      return true
    }
    if (seg[1] !== 'books') return false
    if (seg.length === 2) {
      if (method === 'GET') {
        send(res, 200, { books: books.listBooks().map(bookJson) })
        return true
      }
      if (method === 'POST') {
        await upload(req, res)
        return true
      }
      return false
    }
    const book = bookOf(seg[2])
    const sub = seg[3]
    if (seg.length === 3) {
      if (method === 'GET') {
        send(res, 200, bookJson(book))
        return true
      }
      if (method === 'DELETE') {
        if (IN_PROGRESS.includes(book.status))
          throw apiError('conflict', 'this book is being indexed', {
            status: book.status,
          })
        const gone = books.deleteBook(book.id)
        if (gone.orphanBlob) dropBlob(gone.orphanBlob)
        rmSync(join(lib.dataDir, 'cache', 'pages', book.id), {
          recursive: true,
          force: true,
        })
        lib.cache.invalidate(book.id)
        estimates.delete(book.id)
        send(res, 204)
        return true
      }
      return false
    }
    if (seg.length === 4) {
      if (sub === 'estimate' && method === 'GET') {
        const e = await estimateOf(book)
        send(res, 200, { ...e, dailyRemainingUsd: remaining() })
        return true
      }
      if (sub === 'preview' && method === 'POST') {
        await preview(req, res, book)
        return true
      }
      if ((sub === 'index' || sub === 'retry') && method === 'POST') {
        await start(req, res, book, sub)
        return true
      }
      if (sub === 'outline' && method === 'GET') {
        const sections = books
          .sectionsOf(book.id)
          .map(({ bookId: _b, ...section }) => section)
        send(res, 200, { sections })
        return true
      }
      if (sub === 'file' && (method === 'GET' || method === 'HEAD')) {
        serveFile(req, res, book)
        return true
      }
      return false
    }
    const imageRoute = seg.length === 6 && seg[5] === 'image'
    if (
      sub === 'pages' &&
      method === 'GET' &&
      (seg.length === 5 || imageRoute)
    ) {
      const raw = decode(seg[4] ?? '')
      const n = /^\d+$/.test(raw) ? Number(raw) : 0
      if (n < 1 || (book.pages !== null && n > book.pages))
        throw notFound('page')
      if (imageRoute) {
        await pageImage(req, res, book, n)
        return true
      }
      const page = books.getPage(book.id, n)
      if (!page) throw notFound('page')
      send(res, 200, {
        page: n,
        label: page.label,
        text: page.text,
        method: page.method,
      })
      return true
    }
    if (sub === 'chunks' && seg.length === 5 && method === 'GET') {
      const raw = decode(seg[4] ?? '')
      const chunk = /^\d+$/.test(raw) ? books.chunkById(Number(raw)) : undefined
      if (!chunk || chunk.bookId !== book.id) throw notFound('chunk')
      const { embedding: _e, ...rest } = chunk
      send(res, 200, rest)
      return true
    }
    return false
  }
}
