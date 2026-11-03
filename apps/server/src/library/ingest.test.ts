import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { loadConfig } from '../config'
import { createBlobsDb, createBooksDb, openDatabase } from '../db'
import { ApiError } from '../errors'
import { putPdf } from './files'
import { type IngestDeps, runIngest } from './ingest'
import { openPdf } from './pdf'
import { type Providers, stubProviders } from './providers'
import { makeTestPdf, type TestPdfOptions } from './test-pdf'

const dirs: string[] = []
const dbs: Database.Database[] = []
afterEach(() => {
  for (const d of dbs.splice(0)) if (d.open) d.close()
  for (const d of dirs.splice(0))
    rmSync(join(d, '..'), { recursive: true, force: true })
})

const PROSE =
  'The quick brown fox jumps over the lazy dog and keeps running through the long green meadow beside the river.'
const MATH = 'x = 2 + 3 × 4 ÷ 5 = 6 + 7 - 8 + 9 = 10 + 11 × 12 '.repeat(2)
const DAY = Date.UTC(2026, 10, 3, 12)

async function setup(
  pdf: TestPdfOptions,
  o: {
    providers?: Partial<Providers>
    budget?: string
    deps?: Partial<IngestDeps>
  } = {},
) {
  const dataDir = join(mkdtempSync(join(tmpdir(), 'wb-ingest-')), 'data')
  dirs.push(dataDir)
  const db = openDatabase({ dataDir })
  dbs.push(db)
  const blobs = createBlobsDb(db)
  const books = createBooksDb(db)
  const bytes = makeTestPdf(pdf)
  async function* one() {
    yield bytes
  }
  const { id } = await putPdf(one(), { dataDir, blobs })
  books.createBook(
    { id: 'b', title: 'B', pages: pdf.pages.length, fileBlob: id },
    DAY,
  )
  const providers: Providers = {
    ...stubProviders({ dims: 16 }),
    ...o.providers,
  }
  const deps: IngestDeps = {
    books,
    providers,
    dataDir,
    config: loadConfig({ EMBED_DIMS: '16', DAILY_BUDGET_USD: o.budget ?? '5' }),
    now: () => DAY,
    r4Concurrency: 1,
    ...o.deps,
  }
  return { books, deps, db, dataDir }
}
const fail = async (p: Promise<unknown>) =>
  (await p.catch((e) => e)) as ApiError

describe('runIngest', () => {
  const doc: TestPdfOptions = {
    pages: [PROSE, '', MATH],
    outline: [
      { title: 'Chapter 1', page: 1 },
      { title: 'Chapter 2', page: 3 },
    ],
    labels: [{ from: 1, style: 'r' }],
  }

  it('reads the book into pages, sections, chunks, vectors and summaries and ends ready', async () => {
    const { books, deps } = await setup(doc)
    await runIngest('b', deps)
    const book = books.getBook('b')
    expect(book).toMatchObject({
      status: 'ready',
      progress: 1,
      error: null,
      embedModel: 'baai/bge-m3',
      dims: 16,
    })
    expect(
      books.pagesOf('b').map((p) => [p.pageIndex, p.label, p.method]),
    ).toEqual([
      [1, 'i', 'R1'],
      [2, 'ii', 'R4'],
      [3, 'iii', 'R4'],
    ])
    expect(books.getPage('b', 1)?.text).toContain('quick brown fox')
    const chunks = books.chunksOf('b', { withEmbedding: true })
    expect(chunks.length).toBeGreaterThan(0)
    expect(chunks.every((c) => c.embedding?.length === 16)).toBe(true)
    const first = books.ftsSearch('b', '"quick" OR "fox"', undefined, 5)
    expect(first.length).toBe(1)
    const sections = books.sectionsOf('b')
    expect(sections.map((s) => s.title)).toEqual(['Chapter 1', 'Chapter 2'])
    expect(sections.every((s) => s.summary?.startsWith('summary:'))).toBe(true)
  })

  it('after a failure partway through keeps the finished pages and, re-run, asks only for the rest', async () => {
    const blank: TestPdfOptions = { pages: ['', '', '', '', '', ''] }
    let calls = 0
    const flaky: Partial<Providers> = {
      async transcribePage() {
        if (++calls === 4) throw new ApiError('upstream_error', 'provider down')
        return { text: `page text ${calls}`, truncated: false }
      },
    }
    const { books, deps } = await setup(blank, { providers: flaky })
    const err = await fail(runIngest('b', deps))
    expect(err.code).toBe('upstream_error')
    expect(books.getBook('b')).toMatchObject({ status: 'failed' })
    expect(books.getBook('b')?.error).toMatch(/^extracting: /)
    expect(books.pagesDone('b')).toEqual([1, 2, 3])

    const asked: number[] = []
    let n = 0
    deps.providers = {
      ...deps.providers,
      async transcribePage() {
        asked.push(++n)
        return { text: `second run ${n}`, truncated: false }
      },
    }
    await runIngest('b', deps)
    expect(asked).toHaveLength(3) // pages 4, 5, 6 only
    expect(books.getBook('b')).toMatchObject({ status: 'ready', error: null })
    expect(books.pagesDone('b')).toEqual([1, 2, 3, 4, 5, 6])
    expect(books.getPage('b', 1)?.text).toBe('page text 1') // untouched by the second run

    const clean = await setup(blank)
    await runIngest('b', clean.deps)
    expect(books.chunksOf('b').length).toBe(clean.books.chunksOf('b').length)
  })

  it('lists a page whose transcription was cut off, and keeps its text', async () => {
    const { books, deps } = await setup(
      { pages: ['', PROSE] },
      {
        providers: {
          async transcribePage() {
            return { text: 'partial text', truncated: true }
          },
        },
      },
    )
    await runIngest('b', deps)
    expect(books.getBook('b')?.ingestMethod?.warnings).toEqual([1])
    expect(books.getPage('b', 1)?.text).toBe('partial text')
    expect(books.getBook('b')?.status).toBe('ready')
  })

  it('runs an opt-in R3 page through a one-page slice and records its cost', async () => {
    const slices: number[] = []
    const { books, deps } = await setup(
      { pages: [PROSE, PROSE] },
      {
        providers: {
          async ocrPages(pdf, count) {
            slices.push((await openPdf(pdf)).numPages)
            return { pages: ['r3 text'.repeat(count)], costUsd: 0.002 }
          },
        },
      },
    )
    books.setIngestMethod('b', { ranges: [{ from: 2, to: 2, rung: 'R3' }] })
    await runIngest('b', deps)
    expect(slices).toEqual([1])
    expect(books.getPage('b', 2)).toMatchObject({
      method: 'R3',
      text: 'r3 text',
    })
    expect(books.getPage('b', 1)?.method).toBe('R1')
    expect(books.spentSince(0)).toBeCloseTo(0.002, 10)
  })

  it('refuses a paid rung that would pass the daily cap before calling any provider', async () => {
    const touched: string[] = []
    const trap: Partial<Providers> = {
      async ocrPages() {
        touched.push('ocr')
        return { pages: [''], costUsd: 0 }
      },
      async embed() {
        touched.push('embed')
        return { vectors: [], costUsd: 0 }
      },
      async transcribePage() {
        touched.push('r4')
        return { text: '', truncated: false }
      },
    }
    const { books, deps } = await setup(
      { pages: [PROSE] },
      { providers: trap, budget: '0.001' },
    )
    books.setIngestMethod('b', { ranges: [{ from: 1, to: 1, rung: 'R3' }] })
    const err = await fail(runIngest('b', deps))
    expect(err.code).toBe('budget_exceeded')
    expect(touched).toEqual([])
    expect(books.getBook('b')).toMatchObject({ status: 'failed' })
    expect(books.getBook('b')?.error).toMatch(/budget/i)
  })

  it('stops before embedding when today is already spent', async () => {
    const calls: string[] = []
    const { books, deps } = await setup(
      { pages: [PROSE] },
      {
        budget: '1',
        providers: {
          async embed() {
            calls.push('embed')
            return { vectors: [], costUsd: 0 }
          },
        },
      },
    )
    books.addSpend({ at: DAY - 1000, kind: 'embed', ref: null, costUsd: 1 })
    const err = await fail(runIngest('b', deps))
    expect(err.code).toBe('budget_exceeded')
    expect(calls).toEqual([])
    expect(books.chunksOf('b').length).toBeGreaterThan(0) // chunks are kept: only the embedding was refused
    books.addSpend({
      at: DAY - 3 * 86_400_000,
      kind: 'embed',
      ref: null,
      costUsd: 99,
    }) // yesterday's spend does not count
  })

  it('writes one spend row per embedding batch and resumes embedding where it stopped', async () => {
    // lines that fit the page: pdfjs drops text that runs past its edge
    const line = 'The quick brown fox jumps over the lazy dog near the river.'
    const long = Array.from({ length: 12 }, () =>
      Array(30).fill(line).join('\n'),
    )
    let call = 0
    const stub = stubProviders({ dims: 16 })
    const { books, deps } = await setup(
      { pages: long },
      {
        providers: {
          async embed(texts) {
            if (++call === 3)
              throw new ApiError('upstream_error', 'provider down')
            const r = await stub.embed(texts)
            return { ...r, costUsd: 0.001 }
          },
        },
        deps: { embedBatch: 2 },
      },
    )
    const err = await fail(runIngest('b', deps))
    expect(err.code).toBe('upstream_error')
    expect(books.getBook('b')?.error).toMatch(/^embedding: /)
    expect(books.spentSince(0)).toBeCloseTo(0.002, 10)
    const total = books.chunksOf('b').length
    expect(books.chunksWithoutEmbedding('b').length).toBe(total - 4)

    const sizes: number[] = []
    deps.providers = {
      ...deps.providers,
      async embed(texts) {
        sizes.push(texts.length)
        const r = await stub.embed(texts)
        return { ...r, costUsd: 0.001 }
      },
    }
    await runIngest('b', deps)
    expect(sizes.reduce((a, b) => a + b, 0)).toBe(total - 4)
    expect(books.chunksWithoutEmbedding('b')).toEqual([])
    expect(books.chunksOf('b').length).toBe(total) // no chunk was duplicated by the re-run
  })

  it('leaves the book ready when summaries fail, notes it, and a re-run fills only the missing ones', async () => {
    let boom = true
    const { books, deps } = await setup(doc, {
      providers: {
        async complete(prompt) {
          if (boom) throw new ApiError('upstream_error', 'summaries down')
          return `fixed: ${prompt.slice(0, 20)}`
        },
      },
    })
    await runIngest('b', deps)
    expect(books.getBook('b')?.status).toBe('ready')
    expect(books.getBook('b')?.ingestMethod?.notes?.join(' ')).toMatch(
      /summar/i,
    )
    expect(books.sectionsOf('b').every((s) => s.summary === null)).toBe(true)

    boom = false
    await runIngest('b', deps)
    expect(
      books.sectionsOf('b').every((s) => s.summary?.startsWith('fixed:')),
    ).toBe(true)
  })

  it('summarises leaves first and then the sections that contain them', async () => {
    const prompts: string[] = []
    const { books, deps } = await setup(
      {
        pages: [PROSE, PROSE, PROSE],
        outline: [
          {
            title: 'Part',
            page: 1,
            children: [
              { title: 'Leaf A', page: 1 },
              { title: 'Leaf B', page: 3 },
            ],
          },
        ],
      },
      {
        providers: {
          async complete(prompt) {
            prompts.push(prompt)
            return `S${prompts.length}`
          },
        },
      },
    )
    await runIngest('b', deps)
    expect(prompts).toHaveLength(3)
    expect(prompts[2]).toContain('S1')
    expect(prompts[2]).toContain('S2')
    const byTitle = Object.fromEntries(
      books.sectionsOf('b').map((s) => [s.title, s.summary]),
    )
    expect(byTitle).toEqual({ Part: 'S3', 'Leaf A': 'S1', 'Leaf B': 'S2' })
  })

  it('re-running a finished book changes nothing and calls no provider', async () => {
    const { books, deps } = await setup(doc)
    await runIngest('b', deps)
    const before = JSON.stringify([books.chunksOf('b'), books.sectionsOf('b')])
    const spy: string[] = []
    deps.providers = new Proxy(deps.providers, {
      get(t, k) {
        spy.push(String(k))
        return t[k as keyof Providers]
      },
    })
    await runIngest('b', deps)
    expect(spy).toEqual([])
    expect(JSON.stringify([books.chunksOf('b'), books.sectionsOf('b')])).toBe(
      before,
    )
  })

  it('fails a book whose file is not a readable PDF with ingest_failed', async () => {
    const { books, deps, dataDir } = await setup({ pages: [PROSE] })
    const { writeFileSync } = await import('node:fs')
    const { blobPath } = await import('../blobs')
    writeFileSync(
      blobPath(dataDir, books.getBook('b')?.fileBlob as string),
      '%PDF-1.7 broken',
    )
    const err = await fail(runIngest('b', deps))
    expect(err.code).toBe('ingest_failed')
    expect(books.getBook('b')?.error).toMatch(/^extracting: /)
  })

  it('fails a book whose vision-read pages mostly come back empty, and clears them so a retry reads them again', async () => {
    let blankImages = true
    const { books, deps } = await setup(
      { pages: ['', '', '', '', '', ''] },
      {
        providers: {
          async transcribePage() {
            return { text: blankImages ? '' : 'real text', truncated: false }
          },
        },
      },
    )
    const err = await fail(runIngest('b', deps))
    expect(err.code).toBe('ingest_failed')
    expect(err.message).toMatch(/empty/)
    expect(books.getBook('b')).toMatchObject({ status: 'failed' })
    expect(books.getBook('b')?.error).toMatch(/^extracting: .*empty/)
    expect(books.pagesDone('b')).toEqual([]) // nothing is kept as done, so the retry asks again

    blankImages = false
    await runIngest('b', deps)
    expect(books.getBook('b')?.status).toBe('ready')
    expect(books.getPage('b', 1)?.text).toBe('real text')
  })

  it('lets a few empty pages through (a blank page in a scan is normal)', async () => {
    let n = 0
    const { books, deps } = await setup(
      { pages: ['', '', '', '', '', ''] },
      {
        providers: {
          async transcribePage() {
            return { text: ++n <= 2 ? '' : 'page text', truncated: false }
          },
        },
      },
    )
    await runIngest('b', deps)
    expect(books.getBook('b')?.status).toBe('ready')
  })
})
