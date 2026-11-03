import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { type BooksDb, createBlobsDb, createBooksDb, openDatabase } from '../db'
import { normaliseText } from './chunk'
import { stubVector } from './providers'
import { createVectorCache, rrf, search, topK } from './search'

const DIMS = 16
const dirs: string[] = []
const dbs: Database.Database[] = []
afterEach(() => {
  for (const d of dbs.splice(0)) if (d.open) d.close()
  for (const d of dirs.splice(0))
    rmSync(join(d, '..'), { recursive: true, force: true })
})
const open = () => {
  const dataDir = join(mkdtempSync(join(tmpdir(), 'wb-search-')), 'data')
  dirs.push(dataDir)
  const db = openDatabase({ dataDir })
  dbs.push(db)
  createBlobsDb(db).insert({
    id: 'a'.repeat(64),
    mime: 'application/pdf',
    bytes: 1,
    createdAt: 1,
  })
  return createBooksDb(db)
}

/** A ready book whose chunks are `texts` in order (page = position + 1), embedded with the stub. */
function seed(
  books: BooksDb,
  id: string,
  texts: string[],
  o: { sections?: number[]; embed?: boolean; model?: string } = {},
) {
  books.createBook({ id, title: id, fileBlob: 'a'.repeat(64) }, 1)
  const secRows = o.sections
    ? books.insertSections(id, [
        { title: 'S0', pageStart: 1, pageEnd: 3, children: [] },
        { title: 'S1', pageStart: 4, pageEnd: 9, children: [] },
      ])
    : []
  const ids = books.insertChunks(
    id,
    texts.map((text, i) => ({
      sectionId: o.sections
        ? (secRows[o.sections[i] as number]?.id ?? null)
        : null,
      ord: i,
      pageStart: i + 1,
      pageEnd: i + 1,
      citeLabel: `p. ${i + 1}`,
      headingPath: `H${i}`,
      text,
      textNorm: normaliseText(text),
      tokens: 5,
    })),
  )
  if (o.embed !== false)
    books.setEmbeddings(
      ids.map((chunkId, i) => ({
        chunkId,
        vector: stubVector(texts[i] as string, DIMS),
      })),
    )
  books.setEmbedModel(id, o.model ?? 'baai/bge-m3', DIMS)
  books.setStatus(id, 'ready')
  return { ids, sections: secRows }
}
const embedStub = async (q: string) => stubVector(q, DIMS)
const deps = (
  books: BooksDb,
  embed: ((q: string) => Promise<Float32Array>) | null = embedStub,
) => ({
  books,
  cache: createVectorCache(books),
  embed,
  embedModel: 'baai/bge-m3',
})

describe('rrf', () => {
  it('fuses ranked lists by the sum of 1/(60+rank), ranks from 1', () => {
    const fused = rrf([
      [1, 2, 3],
      [3, 1, 4],
    ])
    expect(fused.map((f) => f.id)).toEqual([1, 3, 2, 4])
    expect(fused[0]?.score).toBeCloseTo(1 / 61 + 1 / 62, 12)
    expect(fused[1]?.score).toBeCloseTo(1 / 63 + 1 / 61, 12)
  })
  it('uses only the first 30 of each list and keeps ties in first-seen order', () => {
    const long = Array.from({ length: 40 }, (_, i) => i)
    expect(rrf([long]).length).toBe(30)
    expect(rrf([[7], [8]]).map((f) => f.id)).toEqual([7, 8])
  })
})

describe('topK', () => {
  it('matches a full sort on random unit vectors', () => {
    const dims = 8
    const n = 300
    const v = new Float32Array(n * dims)
    let seed = 42
    const rnd = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0
      return (seed / 2 ** 32) * 2 - 1
    }
    for (let i = 0; i < v.length; i++) v[i] = rnd()
    const q = Float32Array.from({ length: dims }, rnd)
    const dot = (i: number) =>
      q.reduce((s, x, j) => s + x * (v[i * dims + j] as number), 0)
    const want = Array.from({ length: n }, (_, i) => i)
      .sort((a, b) => dot(b) - dot(a) || a - b)
      .slice(0, 5)
    expect(topK(v, dims, q, 5).map((r) => r.i)).toEqual(want)
  })
  it('handles k larger than n, k = 0 and refuses dims not divisible by 4', () => {
    const v = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0])
    const q = new Float32Array([1, 0, 0, 0])
    expect(topK(v, 4, q, 10).map((r) => r.i)).toEqual([0, 1])
    expect(topK(v, 4, q, 0)).toEqual([])
    expect(() => topK(new Float32Array(6), 3, new Float32Array(3), 1)).toThrow(
      /multiple of 4/,
    )
  })
})

describe('search', () => {
  it('ranks the chunk that matches both keywords and meaning first, and says hybrid', async () => {
    const books = open()
    seed(books, 'b', [
      'photosynthesis happens in the chloroplast',
      'the cover up method finds intercepts of a line',
      'absolute value equations split into two cases',
    ])
    const r = await search(deps(books), {
      query: 'cover up method intercepts',
      bookId: 'b',
      k: 3,
    })
    expect(r.mode).toBe('hybrid')
    expect(r.hits[0]).toMatchObject({
      bookId: 'b',
      pageStart: 2,
      citeLabel: 'p. 2',
      headingPath: 'H1',
    })
    expect(r.hits[0]?.text).toContain('cover up')
  })

  it('lets the vector side find a chunk the keyword side cannot (no usable words in the query)', async () => {
    const books = open()
    const texts = ['alpha beta', 'gamma delta', 'epsilon zeta']
    seed(books, 'b', texts)
    const r = await search(
      deps(books, async () => stubVector('gamma delta', DIMS)),
      {
        query: '?!',
        bookId: 'b',
        k: 2,
      },
    )
    expect(r.mode).toBe('hybrid')
    expect(r.hits[0]?.text).toBe('gamma delta')
  })

  it('falls back to keyword only without an embedder, or when it fails, and reports it', async () => {
    const books = open()
    seed(books, 'b', ['needle in a haystack', 'plain hay'])
    const none = await search(deps(books, null), {
      query: 'needle',
      bookId: 'b',
    })
    expect(none.mode).toBe('keyword')
    expect(none.hits[0]?.text).toContain('needle')
    const boom = await search(
      deps(books, async () => {
        throw new Error('down')
      }),
      { query: 'needle', bookId: 'b' },
    )
    expect(boom.mode).toBe('keyword')
    expect(boom.hits[0]?.text).toContain('needle')
  })

  it('finds undecorated Arabic text from a query with harakat and alef variants', async () => {
    const books = open()
    seed(books, 'b', ['اذا كان المتجه صفريا فان الفضاء جزئي', 'نص اخر'], {
      embed: false,
    })
    const r = await search(deps(books, null), {
      query: 'إِذَا كَانَ المتجه',
      bookId: 'b',
    })
    expect(r.hits[0]?.pageStart).toBe(1)
  })

  it('keeps to the chosen sections and to their sub-sections', async () => {
    const books = open()
    const { sections } = seed(
      books,
      'b',
      [
        'shared word one',
        'shared word two',
        'shared word three',
        'shared word four',
      ],
      { sections: [0, 0, 1, 1] },
    )
    const s1 = sections[1]?.id as number
    const r = await search(deps(books), {
      query: 'shared word',
      bookId: 'b',
      sectionIds: [s1],
      k: 8,
    })
    expect(r.hits.map((h) => h.pageStart).sort()).toEqual([3, 4])
    const none = await search(deps(books), {
      query: 'shared word',
      bookId: 'b',
      sectionIds: [999999],
    })
    expect(none.hits).toEqual([])
  })

  it('adds the chunk before and after each hit once, marked as neighbours, and not twice', async () => {
    const books = open()
    seed(books, 'b', ['zero', 'one', 'two target', 'three', 'four'])
    const r = await search(deps(books, null), {
      query: 'target',
      bookId: 'b',
      k: 1,
      neighbors: true,
    })
    expect(r.hits.map((h) => [h.text, h.neighbor])).toEqual([
      ['two target', false],
      ['one', true],
      ['three', true],
    ])
    const edge = await search(deps(books, null), {
      query: 'zero',
      bookId: 'b',
      k: 1,
      neighbors: true,
    })
    expect(edge.hits.map((h) => h.text)).toEqual(['zero', 'one'])
    const both = await search(deps(books, null), {
      query: 'one two three',
      bookId: 'b',
      k: 3,
      neighbors: true,
    })
    const texts = both.hits.map((h) => h.text)
    expect(new Set(texts).size).toBe(texts.length)
  })

  it('searches every ready book when none is named, and only books of the current embedding model by vector', async () => {
    const books = open()
    seed(books, 'x', ['common topic from book x'])
    seed(books, 'y', ['common topic from book y'], { model: 'other/model' })
    books.createBook({ id: 'z', title: 'z', fileBlob: 'a'.repeat(64) }, 2) // uploaded, not ready
    books.insertChunks('z', [
      {
        sectionId: null,
        ord: 0,
        pageStart: 1,
        pageEnd: 1,
        citeLabel: 'p. 1',
        headingPath: '',
        text: 'common topic hidden',
        textNorm: 'common topic hidden',
        tokens: 3,
      },
    ])
    const r = await search(deps(books), { query: 'common topic', k: 8 })
    expect(r.hits.map((h) => h.bookId).sort()).toEqual(['x', 'y'])
  })

  it('returns nothing for an unknown book or an empty query', async () => {
    const books = open()
    seed(books, 'b', ['text'])
    expect(
      (await search(deps(books), { query: 'text', bookId: 'nope' })).hits,
    ).toEqual([])
    expect(
      (await search(deps(books, null), { query: '  ', bookId: 'b' })).hits,
    ).toEqual([])
  })
})

describe('vector cache', () => {
  it('serves what was loaded until invalidated, then reloads', () => {
    const books = open()
    const { ids } = seed(books, 'b', ['one'])
    const cache = createVectorCache(books)
    const first = cache.get('b', DIMS)
    expect(first?.ids).toEqual(ids)
    const v = new Float32Array(DIMS)
    v[0] = 1
    books.setEmbeddings([{ chunkId: ids[0] as number, vector: v }])
    expect(cache.get('b', DIMS)?.vectors[0]).toBe(first?.vectors[0])
    cache.invalidate('b')
    expect(cache.get('b', DIMS)?.vectors[0]).toBe(1)
  })

  it('evicts the least recently used book when over the byte cap', () => {
    const books = open()
    seed(books, 'a', ['one', 'two'])
    seed(books, 'b', ['one', 'two'])
    const cap = 2 * DIMS * 4 // exactly one book of two vectors
    const cache = createVectorCache(books, cap)
    cache.get('a', DIMS)
    expect(cache.bytes()).toBe(cap)
    cache.get('b', DIMS)
    expect(cache.bytes()).toBe(cap)
    expect(cache.has('a')).toBe(false)
    expect(cache.has('b')).toBe(true)
  })

  it('skips chunks that have no vector yet', () => {
    const books = open()
    seed(books, 'b', ['one', 'two'], { embed: false })
    const [first] = books.chunksOf('b')
    books.setEmbeddings([
      { chunkId: first?.id as number, vector: stubVector('one', DIMS) },
    ])
    const entry = createVectorCache(books).get('b', DIMS)
    expect(entry?.ids).toEqual([first?.id])
  })
})
