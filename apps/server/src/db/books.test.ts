import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { type ChunkIn, createBooksDb } from './books'
import { createBlobsDb, openDatabase } from './index'

const dirs: string[] = []
const dbs: Database.Database[] = []
const open = () => {
  const dataDir = join(mkdtempSync(join(tmpdir(), 'wb-books-')), 'data')
  dirs.push(dataDir)
  const db = openDatabase({ dataDir })
  dbs.push(db)
  const blobs = createBlobsDb(db)
  const blob = (id: string) =>
    blobs.insert({ id, mime: 'application/pdf', bytes: 1, createdAt: 1 })
  return { db, books: createBooksDb(db), blob }
}
afterEach(() => {
  for (const d of dbs.splice(0)) if (d.open) d.close()
  for (const d of dirs.splice(0))
    rmSync(join(d, '..'), { recursive: true, force: true })
})

const H = (c: string) => c.repeat(64)
const chunk = (ord: number, over: Partial<ChunkIn> = {}): ChunkIn => ({
  sectionId: null,
  ord,
  pageStart: ord + 1,
  pageEnd: ord + 1,
  citeLabel: `p. ${ord + 1}`,
  headingPath: 'Ch 1',
  text: `text ${ord}`,
  textNorm: `text ${ord}`,
  tokens: 5,
  ...over,
})

describe('books', () => {
  it('creates, reads, lists newest first and tracks status, method and embed model', () => {
    const { books, blob } = open()
    blob(H('a'))
    books.createBook(
      { id: 'b1', title: 'One', pages: 10, fileBlob: H('a') },
      100,
    )
    const b2 = books.createBook(
      { id: 'b2', title: 'Two', fileBlob: H('a'), lang: 'ar' },
      200,
    )
    expect(b2).toMatchObject({
      id: 'b2',
      status: 'uploaded',
      progress: 0,
      format: 'pdf',
      lang: 'ar',
      pages: null,
      error: null,
      ingestMethod: null,
    })
    expect(books.listBooks().map((b) => b.id)).toEqual(['b2', 'b1'])
    books.setStatus('b1', 'extracting', { progress: 0.5 })
    books.setIngestMethod('b1', { ranges: [], warnings: [3] })
    books.setEmbedModel('b1', 'baai/bge-m3', 1024)
    expect(books.getBook('b1')).toMatchObject({
      status: 'extracting',
      progress: 0.5,
      ingestMethod: { ranges: [], warnings: [3] },
      embedModel: 'baai/bge-m3',
      dims: 1024,
    })
    books.setStatus('b1', 'failed', { error: 'embedding: boom' })
    expect(books.getBook('b1')?.error).toBe('embedding: boom')
    books.setStatus('b1', 'queued')
    expect(books.getBook('b1')?.error).toBeNull()
    expect(books.getBook('nope')).toBeUndefined()
  })

  it('upserts a page once and lists done pages in order', () => {
    const { books, blob } = open()
    blob(H('a'))
    books.createBook({ id: 'b', title: 'B', fileBlob: H('a') }, 1)
    const p = { bookId: 'b', label: 'iv', text: 'one', method: 'R1' as const }
    books.upsertPage({ ...p, pageIndex: 3 })
    books.upsertPage({ ...p, pageIndex: 1, label: '1' })
    books.upsertPage({ ...p, pageIndex: 3, text: 'two', method: 'R4' })
    expect(books.pagesDone('b')).toEqual([1, 3])
    expect(books.pagesOf('b')).toHaveLength(2)
    expect(books.getPage('b', 3)).toMatchObject({
      text: 'two',
      method: 'R4',
      label: 'iv',
    })
    expect(books.getPage('b', 2)).toBeUndefined()
  })

  it('inserts a section tree in document order with levels, parents and descendants', () => {
    const { books, blob } = open()
    blob(H('a'))
    books.createBook({ id: 'b', title: 'B', fileBlob: H('a') }, 1)
    const rows = books.insertSections('b', [
      {
        title: 'Ch 1',
        pageStart: 1,
        pageEnd: 20,
        children: [
          { title: '1.1', pageStart: 1, pageEnd: 10, children: [] },
          { title: '1.2', pageStart: 11, pageEnd: 20, children: [] },
        ],
      },
      { title: 'Ch 2', pageStart: 21, pageEnd: 30, children: [] },
    ])
    expect(rows.map((r) => [r.title, r.level, r.ord])).toEqual([
      ['Ch 1', 1, 0],
      ['1.1', 2, 0],
      ['1.2', 2, 1],
      ['Ch 2', 1, 1],
    ])
    const [ch1, s11, s12, ch2] = rows
    expect(s11?.parentId).toBe(ch1?.id)
    expect(ch1?.parentId).toBeNull()
    expect(books.sectionsOf('b').map((r) => r.id)).toEqual(
      rows.map((r) => r.id),
    )
    expect(
      books.withDescendants('b', [ch1?.id as number]).sort((a, b) => a - b),
    ).toEqual([ch1?.id, s11?.id, s12?.id].sort())
    expect(books.withDescendants('b', [ch2?.id as number])).toEqual([ch2?.id])
    books.setSectionSummary(ch1?.id as number, 'about things', 12)
    expect(books.sectionsOf('b')[0]).toMatchObject({
      summary: 'about things',
      tokens: 12,
    })
  })

  it('inserts hundreds of chunks, keeps FTS in step, and round-trips embeddings', () => {
    const { books, blob } = open()
    blob(H('a'))
    books.createBook({ id: 'b', title: 'B', fileBlob: H('a') }, 1)
    const ids = books.insertChunks(
      'b',
      Array.from({ length: 450 }, (_, i) =>
        chunk(i, { textNorm: i === 77 ? 'cover up method' : `filler ${i}` }),
      ),
    )
    expect(ids).toHaveLength(450)
    expect(new Set(ids).size).toBe(450)
    expect(books.chunksOf('b')).toHaveLength(450)
    expect(books.ftsSearch('b', '"cover" OR "method"', undefined, 8)).toEqual([
      ids[77],
    ])
    expect(books.ftsSearch('b', '', undefined, 8)).toEqual([])

    expect(books.chunksWithoutEmbedding('b')).toHaveLength(450)
    const v = new Float32Array([0.5, -0.5, 0.5, -0.5])
    books.setEmbeddings([{ chunkId: ids[0] as number, vector: v }])
    expect(books.chunksWithoutEmbedding('b')).toHaveLength(449)
    const first = books.chunksOf('b', { withEmbedding: true })[0]
    expect(first?.embedding).toEqual(v)
    expect(books.chunkById(ids[77] as number)?.text).toBe('text 77')
    expect(books.chunkById(999999)).toBeUndefined()
  })

  it('scopes FTS to a book and to sections', () => {
    const { books, blob } = open()
    blob(H('a'))
    for (const id of ['x', 'y'])
      books.createBook({ id, title: id, fileBlob: H('a') }, 1)
    const [s1, s2] = books.insertSections('x', [
      { title: 'A', pageStart: 1, pageEnd: 1, children: [] },
      { title: 'B', pageStart: 2, pageEnd: 2, children: [] },
    ])
    const [c1, c2] = books.insertChunks('x', [
      chunk(0, { sectionId: s1?.id as number, textNorm: 'alpha beta' }),
      chunk(1, { sectionId: s2?.id as number, textNorm: 'alpha gamma' }),
    ])
    books.insertChunks('y', [chunk(0, { textNorm: 'alpha delta' })])
    const q = '"alpha"'
    expect(books.ftsSearch('x', q, undefined, 10).sort()).toEqual(
      [c1, c2].sort(),
    )
    expect(books.ftsSearch('x', q, [s2?.id as number], 10)).toEqual([c2])
    expect(books.ftsSearch('y', q, undefined, 10)).toHaveLength(1)
  })

  it('clears structure and cascades a delete, leaving no orphan rows or FTS entries', () => {
    const { db, books, blob } = open()
    blob(H('a'))
    blob(H('b'))
    books.createBook({ id: 'x', title: 'X', fileBlob: H('a') }, 1)
    books.createBook({ id: 'y', title: 'Y', fileBlob: H('a') }, 1)
    books.createBook({ id: 'z', title: 'Z', fileBlob: H('b') }, 1)
    const [s] = books.insertSections('x', [
      { title: 'A', pageStart: 1, pageEnd: 1, children: [] },
    ])
    books.insertChunks('x', [
      chunk(0, { sectionId: s?.id as number, textNorm: 'needle' }),
    ])
    books.upsertPage({
      bookId: 'x',
      pageIndex: 1,
      label: null,
      text: 't',
      method: 'R1',
    })

    books.clearStructure('x')
    expect(books.sectionsOf('x')).toEqual([])
    expect(books.chunksOf('x')).toEqual([])
    expect(books.ftsSearch('x', '"needle"', undefined, 5)).toEqual([])
    expect(books.pagesDone('x')).toEqual([1]) // pages are kept: they are the expensive part

    books.insertChunks('x', [chunk(0, { textNorm: 'needle' })])
    expect(books.deleteBook('x')).toEqual({ existed: true, orphanBlob: null }) // y still uses blob a
    expect(books.deleteBook('y')).toEqual({ existed: true, orphanBlob: H('a') })
    expect(books.deleteBook('z')).toEqual({ existed: true, orphanBlob: H('b') })
    expect(books.deleteBook('z')).toEqual({ existed: false, orphanBlob: null })
    expect(db.pragma('foreign_key_check')).toEqual([])
    const left = db
      .prepare(
        "SELECT count(*) AS n FROM book_chunks_fts WHERE book_chunks_fts MATCH 'needle'",
      )
      .get() as { n: number }
    expect(left.n).toBe(0)
    for (const t of ['book_pages', 'book_sections', 'book_chunks']) {
      const n = db.prepare(`SELECT count(*) AS n FROM ${t}`).get() as {
        n: number
      }
      expect(n.n).toBe(0)
    }
  })

  it('sums spend since a time', () => {
    const { books } = open()
    books.addSpend({ at: 100, kind: 'embed', ref: 'b', costUsd: 0.01 })
    books.addSpend({ at: 200, kind: 'ocr', ref: 'b', costUsd: 0.02 })
    books.addSpend({ at: 300, kind: 'embed', ref: null, costUsd: 0.04 })
    expect(books.spentSince(150)).toBeCloseTo(0.06, 10)
    expect(books.spentSince(0)).toBeCloseTo(0.07, 10)
    expect(books.spentSince(1000)).toBe(0)
  })

  it('fetches chunks of a book by position, for neighbours', () => {
    const { books, blob } = open()
    blob(H('a'))
    for (const id of ['x', 'y'])
      books.createBook({ id, title: id, fileBlob: H('a') }, 1)
    books.insertChunks(
      'x',
      Array.from({ length: 5 }, (_, i) => chunk(i, { text: `x${i}` })),
    )
    books.insertChunks('y', [chunk(2, { text: 'y2' })])
    expect(books.chunksByOrd('x', [1, 3, 9]).map((c) => c.text)).toEqual([
      'x1',
      'x3',
    ])
    expect(books.chunksByOrd('x', [])).toEqual([])
    expect(books.chunksByOrd('y', [2]).map((c) => c.text)).toEqual(['y2'])
  })
})
