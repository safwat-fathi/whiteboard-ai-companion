import type { BooksDb, ChunkRow } from '../db'
import { ftsQuery } from './chunk'

const POOL = 30 // candidates each side contributes to the fusion (rag-context-engineering.md)
const RRF_K = 60
const MAX_K = 50
const DEFAULT_CACHE_BYTES = 512 * 2 ** 20 // database.md: 512 MB

/**
 * Exact top-k by dot product (= cosine on unit vectors). `vectors` is row-major, `dims` per row, which must be a
 * multiple of 4 (four independent accumulators; a scalar tail cost 15% in S4a). Descending score, ties keep the lower row.
 */
export function topK(
  vectors: Float32Array,
  dims: number,
  query: Float32Array,
  k: number,
): { i: number; score: number }[] {
  if (dims % 4 !== 0) throw new Error(`dims ${dims} is not a multiple of 4`)
  if (k <= 0) return []
  const n = Math.floor(vectors.length / dims)
  const ids = new Int32Array(k)
  const scores = new Float64Array(k) // kept sorted descending; k is small, so insertion beats a heap
  let size = 0
  for (let i = 0, base = 0; i < n; i++, base += dims) {
    let a = 0
    let b = 0
    let c = 0
    let d = 0
    for (let j = 0; j < dims; j += 4) {
      a += (vectors[base + j] as number) * (query[j] as number)
      b += (vectors[base + j + 1] as number) * (query[j + 1] as number)
      c += (vectors[base + j + 2] as number) * (query[j + 2] as number)
      d += (vectors[base + j + 3] as number) * (query[j + 3] as number)
    }
    const s = a + b + c + d
    if (size === k && s <= (scores[k - 1] as number)) continue
    let p = size < k ? size++ : k - 1
    while (p > 0 && (scores[p - 1] as number) < s) {
      scores[p] = scores[p - 1] as number
      ids[p] = ids[p - 1] as number
      p--
    }
    scores[p] = s
    ids[p] = i
  }
  return Array.from({ length: size }, (_, r) => ({
    i: ids[r] as number,
    score: scores[r] as number,
  }))
}

/** Reciprocal-rank fusion: score = sum of 1/(60 + rank), ranks from 1, first 30 of each list; ties in first-seen order. */
export function rrf(lists: number[][]): { id: number; score: number }[] {
  const scores = new Map<number, number>()
  for (const list of lists)
    for (const [idx, id] of list.slice(0, POOL).entries())
      scores.set(id, (scores.get(id) ?? 0) + 1 / (RRF_K + idx + 1))
  return [...scores.entries()]
    .map(([id, score]) => ({ id, score }))
    .sort((x, y) => y.score - x.score)
}

export type VectorEntry = {
  dims: number
  /** chunk id of each row */
  ids: number[]
  /** section id of each row, for scoping */
  sectionIds: (number | null)[]
  vectors: Float32Array
}
export type VectorCache = ReturnType<typeof createVectorCache>

/** One `Float32Array` per book, loaded on first use from the chunk BLOBs, least recently used out beyond `maxBytes`. */
export function createVectorCache(
  books: BooksDb,
  maxBytes = DEFAULT_CACHE_BYTES,
) {
  const entries = new Map<string, VectorEntry>()
  let total = 0
  const drop = (bookId: string) => {
    const e = entries.get(bookId)
    if (e) total -= e.vectors.byteLength
    entries.delete(bookId)
  }
  return {
    get(bookId: string, dims: number): VectorEntry | undefined {
      const hit = entries.get(bookId)
      if (hit && hit.dims === dims) {
        entries.delete(bookId) // refresh recency
        entries.set(bookId, hit)
        return hit
      }
      drop(bookId)
      const rows = books
        .chunksOf(bookId, { withEmbedding: true })
        .filter((c) => c.embedding && c.embedding.length === dims)
      if (rows.length === 0) return undefined
      const vectors = new Float32Array(rows.length * dims)
      for (const [i, r] of rows.entries())
        vectors.set(r.embedding as Float32Array, i * dims)
      const entry: VectorEntry = {
        dims,
        ids: rows.map((r) => r.id),
        sectionIds: rows.map((r) => r.sectionId),
        vectors,
      }
      entries.set(bookId, entry)
      total += vectors.byteLength
      for (const oldest of entries.keys()) {
        if (total <= maxBytes || entries.size <= 1) break
        drop(oldest)
      }
      return entry
    },
    invalidate: drop,
    has: (bookId: string) => entries.has(bookId),
    bytes: () => total,
  }
}

export type SearchDeps = {
  books: BooksDb
  cache: VectorCache
  /** Embeds a query with `embedModel`; null when no embedding provider is configured. */
  embed: ((query: string) => Promise<Float32Array>) | null
  embedModel: string
}
export type SearchOptions = {
  query: string
  /** One book; omitted = every ready book */
  bookId?: string
  /** Only these sections and the ones below them (needs `bookId`) */
  sectionIds?: number[]
  k?: number
  /** Also return the chunk before and after each hit, marked `neighbor` */
  neighbors?: boolean
}
export type SearchHit = {
  chunkId: number
  bookId: string
  sectionId: number | null
  ord: number
  pageStart: number | null
  pageEnd: number | null
  citeLabel: string
  headingPath: string
  text: string
  score: number
  neighbor: boolean
}
export type SearchResult = { mode: 'hybrid' | 'keyword'; hits: SearchHit[] }

const toHit = (c: ChunkRow, score: number, neighbor: boolean): SearchHit => ({
  chunkId: c.id,
  bookId: c.bookId,
  sectionId: c.sectionId,
  ord: c.ord,
  pageStart: c.pageStart,
  pageEnd: c.pageEnd,
  citeLabel: c.citeLabel,
  headingPath: c.headingPath,
  text: c.text,
  score,
  neighbor,
})

/**
 * Hybrid search (rag-context-engineering.md): FTS5 BM25 top 30 and exact vector top 30 inside the scope, fused by RRF.
 * Without an embedder, or when it fails, it is keyword-only and says so. A book embedded with another model than
 * `embedModel` is searched by keyword only. Across books the fused lists are merged by score.
 */
export async function search(
  deps: SearchDeps,
  opts: SearchOptions,
): Promise<SearchResult> {
  const { books } = deps
  const k = Math.min(MAX_K, Math.max(1, Math.floor(opts.k ?? 8)))
  const targets = opts.bookId
    ? [books.getBook(opts.bookId)].filter((b) => b !== undefined)
    : books.listBooks().filter((b) => b.status === 'ready')
  if (!opts.query.trim() || targets.length === 0)
    return { mode: 'keyword', hits: [] }

  let queryVector: Float32Array | null = null
  if (deps.embed) {
    try {
      queryVector = await deps.embed(opts.query)
    } catch {
      queryVector = null // a provider outage or a missing key must not take search down
    }
  }

  const match = ftsQuery(opts.query)
  const ranked: { id: number; score: number }[] = []
  for (const book of targets) {
    const scope =
      opts.bookId && opts.sectionIds?.length
        ? books.withDescendants(book.id, opts.sectionIds)
        : undefined
    if (scope && scope.length === 0) continue
    const lists: number[][] = [books.ftsSearch(book.id, match, scope, POOL)]
    if (
      queryVector &&
      book.embedModel === deps.embedModel &&
      book.dims === queryVector.length
    ) {
      const entry = deps.cache.get(book.id, queryVector.length)
      if (entry) {
        const dims = entry.dims
        let ids = entry.ids
        let vectors = entry.vectors
        if (scope) {
          const allowed = new Set(scope)
          const rows = entry.sectionIds.flatMap((s, i) =>
            s !== null && allowed.has(s) ? [i] : [],
          )
          ids = rows.map((i) => entry.ids[i] as number)
          vectors = new Float32Array(rows.length * dims)
          for (const [i, r] of rows.entries())
            vectors.set(
              entry.vectors.subarray(r * dims, (r + 1) * dims),
              i * dims,
            )
        }
        lists.push(
          topK(vectors, dims, queryVector, POOL).map((r) => ids[r.i] as number),
        )
      }
    }
    ranked.push(...rrf(lists))
  }
  ranked.sort((a, b) => b.score - a.score)

  const hits: SearchHit[] = []
  for (const r of ranked.slice(0, k)) {
    const chunk = books.chunkById(r.id)
    if (chunk) hits.push(toHit(chunk, r.score, false))
  }
  if (opts.neighbors) {
    const seen = new Set(hits.map((h) => h.chunkId))
    const extra: SearchHit[] = []
    for (const h of hits) {
      for (const n of books.chunksByOrd(h.bookId, [h.ord - 1, h.ord + 1])) {
        if (seen.has(n.id)) continue
        seen.add(n.id)
        extra.push(toHit(n, 0, true))
      }
    }
    hits.push(...extra)
  }
  return { mode: queryVector ? 'hybrid' : 'keyword', hits }
}
