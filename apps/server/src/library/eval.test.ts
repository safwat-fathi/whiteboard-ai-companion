import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { type BooksDb, createBlobsDb, createBooksDb, openDatabase } from '../db'
import { normaliseText } from './chunk'
import { type EvalItem, evaluate, loadEvalItems, main } from './eval'
import { stubVector } from './providers'
import { createVectorCache } from './search'

const DIMS = 16
const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const TEXTS = [
  'photosynthesis happens in the chloroplast using light',
  'the cover up method finds the intercepts of a line',
  'absolute value equations split into two cases',
  'the discriminant of a quadratic tells how many roots it has',
]
const LABELS = ['i', 'ii', '1', '2']

/** A ready book of four one-page chunks (page n = chunk n), labels roman then decimal. */
function rig() {
  const root = mkdtempSync(join(tmpdir(), 'wb-eval-'))
  dirs.push(root)
  const dataDir = join(root, 'data')
  const db = openDatabase({ dataDir })
  createBlobsDb(db).insert({
    id: 'a'.repeat(64),
    mime: 'application/pdf',
    bytes: 1,
    createdAt: 1,
  })
  const books = createBooksDb(db)
  books.createBook(
    { id: 'book-1', title: 'Algebra Test', fileBlob: 'a'.repeat(64) },
    1,
  )
  const ids = books.insertChunks(
    'book-1',
    TEXTS.map((text, i) => ({
      sectionId: null,
      ord: i,
      pageStart: i + 1,
      pageEnd: i + 1,
      citeLabel: `p. ${LABELS[i]}`,
      headingPath: '',
      text,
      textNorm: normaliseText(text),
      tokens: 8,
    })),
  )
  books.setEmbeddings(
    ids.map((chunkId, i) => ({
      chunkId,
      vector: stubVector(TEXTS[i] as string, DIMS),
    })),
  )
  for (const [i, text] of TEXTS.entries())
    books.upsertPage({
      bookId: 'book-1',
      pageIndex: i + 1,
      label: LABELS[i] as string,
      text,
      method: 'R1',
    })
  books.setEmbedModel('book-1', 'baai/bge-m3', DIMS)
  books.setStatus('book-1', 'ready')
  const run = (items: EvalItem[], k = 8) =>
    evaluate(
      {
        books,
        cache: createVectorCache(books),
        embedQueries: async (qs: string[]) =>
          qs.map((q) => stubVector(q, DIMS)),
        embedModel: 'baai/bge-m3',
      },
      'book-1',
      items,
      k,
    )
  const env = { DATA_DIR: dataDir, EMBED_DIMS: String(DIMS), INGEST_STUB: '1' }
  return { root, db, books: books as BooksDb, run, env }
}

const ITEMS: EvalItem[] = [
  { q: 'how does the cover up method work', pages: [2] },
  { q: 'why split absolute value equations into cases', pages: [3] },
  { q: 'what does the discriminant tell us', pages: [4] },
  { q: 'tell me about volcanoes', pages: [1] }, // no word in common with its page: only the vectors can try
]

describe('evaluate', () => {
  it('scores keyword, vector, hybrid and hybrid with neighbours', async () => {
    const { run } = rig()
    const r = await run(ITEMS, 8)
    expect(r.questions).toBe(4)
    expect(r.methods.keyword.recall).toBe(0.75) // finds the three that share words, not the volcano one
    expect(r.methods.keyword.mrr).toBe(0.75)
    expect(r.methods.vector.recall).toBe(1) // four chunks, k = 8: everything is returned
    expect(r.methods.hybrid.recall).toBe(1)
    expect(r.methods.hybridNeighbors.recall).toBe(1)
    expect(r.methods.hybrid.mrr).toBeGreaterThan(0.25)
    expect(r.misses).toEqual([])
  })

  it('counts a miss when the expected page is outside the top k, and lists it', async () => {
    const { run } = rig()
    const r = await run(ITEMS, 1)
    expect(r.methods.hybrid.recall).toBe(0.75)
    expect(r.misses.map((m) => m.q)).toEqual(['tell me about volcanoes'])
    expect(r.misses[0]).toMatchObject({ expected: [1] })
    expect(r.methods.hybridNeighbors.recall).toBeGreaterThanOrEqual(
      r.methods.hybrid.recall,
    )
  })

  it('credits a neighbour when it holds the page, at the rank of the hit beside it', async () => {
    const { run } = rig()
    // asks about page 3; the best hit is the cover-up page 2 or 3, its neighbour covers the rest
    const r = await run([{ q: 'cover up method intercepts', pages: [3] }], 1)
    expect(r.methods.hybrid.recall).toBe(0)
    expect(r.methods.hybridNeighbors.recall).toBe(1)
    expect(r.methods.hybridNeighbors.mrr).toBe(1)
  })

  it('maps printed page numbers to file pages through the labels', async () => {
    const { run } = rig()
    const r = await run(
      [
        {
          q: 'how does the cover up method work',
          pages: [1],
          numbering: 'printed',
        },
      ],
      8,
    )
    // printed "1" is the third file page ('i', 'ii', '1'), the absolute value page; the question is about page 2
    expect(r.methods.keyword.recall).toBe(0)
    const ok = await run(
      [{ q: 'absolute value cases', pages: [1], numbering: 'printed' }],
      1,
    )
    expect(ok.methods.hybrid.recall).toBe(1)
  })

  it('leaves out, and reports, a question whose printed page does not exist', async () => {
    const { run } = rig()
    const r = await run(
      [
        { q: 'absolute value cases', pages: [1], numbering: 'printed' },
        { q: 'anything', pages: [99], numbering: 'printed' },
      ],
      8,
    )
    expect(r.questions).toBe(1)
    expect(r.unmapped).toEqual(['anything'])
  })
})

describe('loadEvalItems', () => {
  it('reads jsonl, skips blank lines and checks the fields', () => {
    const root = mkdtempSync(join(tmpdir(), 'wb-evalfile-'))
    dirs.push(root)
    const f = join(root, 'e.jsonl')
    writeFileSync(
      f,
      '{"q":"a","pages":[1,2]}\n\n{"q":"b","pages":[3],"numbering":"printed"}\n',
    )
    expect(loadEvalItems(f)).toEqual([
      { q: 'a', pages: [1, 2] },
      { q: 'b', pages: [3], numbering: 'printed' },
    ])
    writeFileSync(f, '{"q":"a"}\n')
    expect(() => loadEvalItems(f)).toThrow(/line 1/)
  })
})

describe('eval CLI', () => {
  const sink = () => {
    const out: string[] = []
    const err: string[] = []
    return {
      out,
      err,
      io: { log: (s: string) => out.push(s), err: (s: string) => err.push(s) },
    }
  }
  const file = (root: string) => {
    const f = join(root, 'q.jsonl')
    writeFileSync(f, ITEMS.map((i) => JSON.stringify(i)).join('\n'))
    return f
  }

  it('prints the table and exits 0 when hybrid recall@k meets the 80% target', async () => {
    const r = rig()
    r.db.close()
    const s = sink()
    const code = await main(
      ['--book', 'Algebra', '--eval', file(r.root)],
      r.env,
      s.io,
      r.root,
    )
    expect(code).toBe(0)
    const text = s.out.join('\n')
    expect(text).toMatch(/keyword/)
    expect(text).toMatch(/hybrid\+neighbours/)
    expect(text).toMatch(/PASS/)
  })

  it('exits 1 below the target and says FAIL', async () => {
    const r = rig()
    r.db.close()
    const s = sink()
    const code = await main(
      ['--book', 'book-1', '--eval', file(r.root), '--k', '1'],
      r.env,
      s.io,
      r.root,
    )
    expect(code).toBe(1)
    expect(s.out.join('\n')).toMatch(/FAIL/)
    expect(s.out.join('\n')).toMatch(/volcanoes/)
  })

  it('refuses an unknown book, an ambiguous title, a missing file and missing arguments', async () => {
    const r = rig()
    r.books.createBook(
      { id: 'book-2', title: 'Algebra Two', fileBlob: 'a'.repeat(64) },
      2,
    )
    r.db.close()
    const f = file(r.root)
    const s = sink()
    expect(
      await main(['--book', 'nope', '--eval', f], r.env, s.io, r.root),
    ).toBe(1)
    expect(
      await main(['--book', 'Algebra', '--eval', f], r.env, s.io, r.root),
    ).toBe(1)
    expect(s.err.join('\n')).toMatch(/more than one/i)
    expect(
      await main(
        ['--book', 'book-1', '--eval', join(r.root, 'x.jsonl')],
        r.env,
        s.io,
        r.root,
      ),
    ).toBe(1)
    expect(await main(['--book', 'book-1'], r.env, s.io, r.root)).toBe(1)
  })
})
