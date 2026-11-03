import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadConfig } from '../config'
import { type BooksDb, createBooksDb, openDatabase } from '../db'
import { ftsQuery } from './chunk'
import { createProviders, stubProviders } from './providers'
import { createVectorCache, search, topK, type VectorCache } from './search'

/** The M4 gate (PLAN §17): the expected page is among the top 8 for at least this share of the questions. */
export const TARGET_RECALL = 0.8
const POOL = 30

export type EvalItem = {
  q: string
  /** the pages that hold the answer */
  pages: number[]
  /** "printed": the numbers on the pages (matched through the labels); default: positions in the file */
  numbering?: 'printed' | 'file'
}
export type Metrics = { recall: number; mrr: number }
export type MethodName = 'keyword' | 'vector' | 'hybrid' | 'hybridNeighbors'
export type EvalResult = {
  questions: number
  k: number
  methods: Record<MethodName, Metrics>
  /** questions the hybrid ranking missed */
  misses: { q: string; expected: number[]; got: (number | null)[] }[]
  /** questions left out because none of their printed pages exist in the book */
  unmapped: string[]
}

export function loadEvalItems(path: string): EvalItem[] {
  const items: EvalItem[] = []
  readFileSync(path, 'utf8')
    .split('\n')
    .forEach((line, i) => {
      if (!line.trim()) return
      const bad = (why: string) => new Error(`${path} line ${i + 1}: ${why}`)
      let v: Partial<EvalItem>
      try {
        v = JSON.parse(line)
      } catch {
        throw bad('not JSON')
      }
      if (typeof v.q !== 'string' || !v.q.trim()) throw bad('"q" must be text')
      if (
        !Array.isArray(v.pages) ||
        v.pages.length === 0 ||
        !v.pages.every((p) => Number.isInteger(p))
      )
        throw bad('"pages" must be a list of whole numbers')
      if (
        v.numbering !== undefined &&
        v.numbering !== 'printed' &&
        v.numbering !== 'file'
      )
        throw bad('"numbering" must be "printed" or "file"')
      items.push({
        q: v.q,
        pages: v.pages,
        ...(v.numbering ? { numbering: v.numbering } : {}),
      })
    })
  return items
}

/**
 * Recall@k and MRR of keyword-only, vector-only, hybrid and hybrid-with-neighbours over one book (the S4b measures, now on
 * what was really ingested). A question is a hit at rank r when the r-th chunk's page range holds an expected page; with
 * neighbours, when the chunk before or after it does.
 */
export async function evaluate(
  o: {
    books: BooksDb
    cache: VectorCache
    embedQueries: (queries: string[]) => Promise<Float32Array[]>
    embedModel: string
  },
  bookId: string,
  items: EvalItem[],
  k = 8,
): Promise<EvalResult> {
  const { books } = o
  const book = books.getBook(bookId)
  if (!book) throw new Error(`no book ${bookId}`)

  const labelToPage = new Map<string, number>()
  for (const p of books.pagesOf(bookId))
    if (p.label !== null && !labelToPage.has(p.label))
      labelToPage.set(p.label, p.pageIndex)
  const questions: { q: string; expected: number[] }[] = []
  const unmapped: string[] = []
  for (const it of items) {
    const expected =
      it.numbering === 'printed'
        ? it.pages.flatMap((p) => {
            const i = labelToPage.get(String(p))
            return i === undefined ? [] : [i]
          })
        : it.pages
    if (expected.length === 0) unmapped.push(it.q)
    else questions.push({ q: it.q, expected })
  }

  const vectors = await o.embedQueries(questions.map((x) => x.q))
  const dims = book.dims ?? vectors[0]?.length ?? 0
  const entry = dims ? o.cache.get(bookId, dims) : undefined
  const ranges = new Map<number, { start: number; end: number }>()
  const range = (id: number) => {
    let r = ranges.get(id)
    if (!r) {
      const c = books.chunkById(id)
      r = { start: c?.pageStart ?? -1, end: c?.pageEnd ?? -2 }
      ranges.set(id, r)
    }
    return r
  }
  const covers = (id: number, expected: number[]) => {
    const r = range(id)
    return expected.some((p) => p >= r.start && p <= r.end)
  }
  const firstHit = (ids: number[], expected: number[]) => {
    const r = ids.findIndex((id) => covers(id, expected))
    return r < 0 ? 0 : 1 / (r + 1)
  }

  const sums: Record<MethodName, { hits: number; rr: number }> = {
    keyword: { hits: 0, rr: 0 },
    vector: { hits: 0, rr: 0 },
    hybrid: { hits: 0, rr: 0 },
    hybridNeighbors: { hits: 0, rr: 0 },
  }
  const add = (m: MethodName, rr: number) => {
    if (rr > 0) sums[m].hits++
    sums[m].rr += rr
  }
  const misses: EvalResult['misses'] = []

  for (const [i, { q, expected }] of questions.entries()) {
    const qv = vectors[i] as Float32Array
    add(
      'keyword',
      firstHit(
        books.ftsSearch(bookId, ftsQuery(q), undefined, POOL).slice(0, k),
        expected,
      ),
    )
    add(
      'vector',
      entry
        ? firstHit(
            topK(entry.vectors, entry.dims, qv, k).map(
              (r) => entry.ids[r.i] as number,
            ),
            expected,
          )
        : 0,
    )
    const { hits } = await search(
      {
        books,
        cache: o.cache,
        embed: async () => qv,
        embedModel: o.embedModel,
      },
      { query: q, bookId, k, neighbors: true },
    )
    const top = hits.filter((h) => !h.neighbor)
    const beside = hits.filter((h) => h.neighbor)
    const rr = firstHit(
      top.map((h) => h.chunkId),
      expected,
    )
    add('hybrid', rr)
    if (rr === 0) misses.push({ q, expected, got: top.map((h) => h.pageStart) })
    const win = top.findIndex(
      (h) =>
        covers(h.chunkId, expected) ||
        beside.some(
          (n) => Math.abs(n.ord - h.ord) === 1 && covers(n.chunkId, expected),
        ),
    )
    add('hybridNeighbors', win < 0 ? 0 : 1 / (win + 1))
  }

  const n = questions.length
  const metrics = (m: MethodName): Metrics => ({
    recall: n ? sums[m].hits / n : 0,
    mrr: n ? sums[m].rr / n : 0,
  })
  return {
    questions: n,
    k,
    methods: {
      keyword: metrics('keyword'),
      vector: metrics('vector'),
      hybrid: metrics('hybrid'),
      hybridNeighbors: metrics('hybridNeighbors'),
    },
    misses,
    unmapped,
  }
}

type Io = { log: (s: string) => void; err: (s: string) => void }
const USAGE =
  'usage: pnpm eval:retrieval --book <id|title> --eval <questions.jsonl> [--k 8] [--stub]'
const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url))
const pct = (x: number) => `${(x * 100).toFixed(1)}%`

/** `pnpm eval:retrieval`: exits 0 only when hybrid recall@k meets the 80% target. */
export async function main(
  argv: string[],
  env: Record<string, string | undefined>,
  io: Io,
  cwd: string = process.env.INIT_CWD ?? process.cwd(),
  baseDir: string = repoRoot,
): Promise<number> {
  let bookArg: string | undefined
  let evalArg: string | undefined
  let k = 8
  let stub = env.INGEST_STUB === '1'
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string
    if (a === '--book') bookArg = argv[++i]
    else if (a === '--eval') evalArg = argv[++i]
    else if (a === '--k') k = Number(argv[++i])
    else if (a === '--stub') stub = true
    else {
      io.err(`unexpected argument ${a}\n${USAGE}`)
      return 1
    }
  }
  if (!bookArg || !evalArg || !Number.isInteger(k) || k < 1) {
    io.err(USAGE)
    return 1
  }
  let items: EvalItem[]
  try {
    items = loadEvalItems(resolve(cwd, evalArg))
  } catch (e) {
    io.err((e as Error).message)
    return 1
  }
  let config: ReturnType<typeof loadConfig>
  try {
    config = loadConfig(env, baseDir)
  } catch (e) {
    io.err((e as Error).message)
    return 1
  }

  const db = openDatabase({ dataDir: config.dataDir })
  try {
    const books = createBooksDb(db)
    const byId = books.getBook(bookArg)
    const byTitle = books
      .listBooks()
      .filter((b) => b.title.toLowerCase().includes(bookArg.toLowerCase()))
    const matches = byId ? [byId] : byTitle
    if (matches.length === 0) {
      io.err(`no book matches "${bookArg}"`)
      return 1
    }
    if (matches.length > 1) {
      io.err(
        `more than one book matches "${bookArg}": ${matches.map((b) => `${b.title} (${b.id})`).join(', ')}`,
      )
      return 1
    }
    const book = matches[0]
    if (!book) return 1
    if (book.embedModel !== config.embedModel) {
      io.err(
        `the book was embedded with ${book.embedModel ?? 'nothing'}, EMBED_MODEL is ${config.embedModel}`,
      )
      return 1
    }
    const providers = stub
      ? stubProviders({ dims: config.embedDims })
      : createProviders({ config, env })
    const result = await evaluate(
      {
        books,
        cache: createVectorCache(books),
        embedQueries: async (qs) => {
          const r = await providers.embed(qs)
          if (r.costUsd > 0)
            books.addSpend({
              at: Date.now(),
              kind: 'embed',
              ref: book.id,
              costUsd: r.costUsd,
            })
          return r.vectors
        },
        embedModel: config.embedModel,
      },
      book.id,
      items,
      k,
    )
    io.log(
      `"${book.title}" (${book.id}): ${result.questions} questions, k=${k}`,
    )
    io.log(`${'method'.padEnd(20)}${`recall@${k}`.padEnd(12)}MRR`)
    for (const [name, label] of [
      ['keyword', 'keyword'],
      ['vector', 'vector'],
      ['hybrid', 'hybrid'],
      ['hybridNeighbors', 'hybrid+neighbours'],
    ] as const)
      io.log(
        `${label.padEnd(20)}${pct(result.methods[name].recall).padEnd(12)}${result.methods[name].mrr.toFixed(3)}`,
      )
    for (const m of result.misses)
      io.log(
        `miss: "${m.q}" expected page(s) ${m.expected.join(', ')}, top hits on ${m.got.join(', ') || 'nothing'}`,
      )
    if (result.unmapped.length)
      io.log(
        `WARNING: ${result.unmapped.length} question(s) left out, their printed pages are not in the book: ${result.unmapped.map((q) => `"${q}"`).join(', ')}`,
      )
    if (result.questions === 0) {
      io.err('no question could be scored')
      return 1
    }
    const ok = result.methods.hybrid.recall >= TARGET_RECALL
    io.log(
      `GATE hybrid recall@${k} >= ${TARGET_RECALL * 100}%: ${ok ? 'PASS' : 'FAIL'} (${pct(result.methods.hybrid.recall)})`,
    )
    return ok ? 0 : 1
  } finally {
    db.close()
  }
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1])
) {
  process.exit(
    await main(process.argv.slice(2), process.env, {
      log: console.log,
      err: console.error,
    }),
  )
}
