import type Database from 'better-sqlite3'

export type BookStatus =
  | 'uploaded'
  | 'queued'
  | 'extracting'
  | 'structuring'
  | 'embedding'
  | 'summarising'
  | 'ready'
  | 'failed'
export type Rung = 'R1' | 'R3' | 'R4'

/** `books.ingest_method` (json): the per-range rung choices, pages that came back truncated, and notes (e.g. failed summaries). */
export type IngestMethod = {
  ranges?: { from: number; to: number; rung: Rung }[]
  warnings?: number[]
  notes?: string[]
}

export type BookRow = {
  id: string
  title: string
  author: string | null
  lang: string | null
  format: string
  pages: number | null
  fileBlob: string
  status: BookStatus
  progress: number
  ingestMethod: IngestMethod | null
  embedModel: string | null
  dims: number | null
  error: string | null
  createdAt: number
}
export type NewBook = {
  id: string
  title: string
  author?: string
  lang?: string
  pages?: number
  fileBlob: string
}

export type PageRow = {
  bookId: string
  pageIndex: number
  label: string | null
  text: string
  method: Rung
}

export type SectionNode = {
  title: string
  pageStart: number | null
  pageEnd: number | null
  children: SectionNode[]
}
export type SectionRow = {
  id: number
  bookId: string
  parentId: number | null
  ord: number
  level: number
  title: string
  pageStart: number | null
  pageEnd: number | null
  summary: string | null
  tokens: number | null
}

export type ChunkIn = {
  sectionId: number | null
  ord: number
  pageStart: number | null
  pageEnd: number | null
  citeLabel: string
  headingPath: string
  text: string
  textNorm: string
  tokens: number
}
export type ChunkRow = ChunkIn & {
  id: number
  bookId: string
  embedding?: Float32Array | null
}

export type BooksDb = ReturnType<typeof createBooksDb>

/** Rows per write transaction while ingesting, so a board append never waits long on the single writer (database.md). */
const WRITE_BATCH = 200

type RawBook = {
  id: string
  title: string
  author: string | null
  lang: string | null
  format: string
  pages: number | null
  file_blob: string
  status: BookStatus
  progress: number
  ingest_method: string | null
  embed_model: string | null
  dims: number | null
  error: string | null
  created_at: number
}
type RawSection = {
  id: number
  book_id: string
  parent_id: number | null
  ord: number
  level: number
  title: string
  page_start: number | null
  page_end: number | null
  summary: string | null
  tokens: number | null
}
type RawChunk = {
  id: number
  book_id: string
  section_id: number | null
  ord: number
  page_start: number | null
  page_end: number | null
  cite_label: string
  heading_path: string
  text: string
  text_norm: string
  tokens: number
  embedding?: Buffer | null
}

const toBook = (r: RawBook): BookRow => ({
  id: r.id,
  title: r.title,
  author: r.author,
  lang: r.lang,
  format: r.format,
  pages: r.pages,
  fileBlob: r.file_blob,
  status: r.status,
  progress: r.progress,
  ingestMethod: r.ingest_method ? JSON.parse(r.ingest_method) : null,
  embedModel: r.embed_model,
  dims: r.dims,
  error: r.error,
  createdAt: r.created_at,
})
const toSection = (r: RawSection): SectionRow => ({
  id: r.id,
  bookId: r.book_id,
  parentId: r.parent_id,
  ord: r.ord,
  level: r.level,
  title: r.title,
  pageStart: r.page_start,
  pageEnd: r.page_end,
  summary: r.summary,
  tokens: r.tokens,
})
const toChunk = (r: RawChunk): ChunkRow => ({
  id: r.id,
  bookId: r.book_id,
  sectionId: r.section_id,
  ord: r.ord,
  pageStart: r.page_start,
  pageEnd: r.page_end,
  citeLabel: r.cite_label,
  headingPath: r.heading_path,
  text: r.text,
  textNorm: r.text_norm,
  tokens: r.tokens,
  ...(r.embedding === undefined
    ? {}
    : { embedding: r.embedding ? toVector(r.embedding) : null }),
})

/** Float32 little-endian, as stored (database.md). Copies, so the result never aliases SQLite's buffer. */
const toVector = (b: Buffer): Float32Array =>
  new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength))
const toBlob = (v: Float32Array): Buffer =>
  Buffer.from(v.buffer, v.byteOffset, v.byteLength)

const CHUNK_COLS =
  'id, book_id, section_id, ord, page_start, page_end, cite_label, heading_path, text, text_norm, tokens'
const placeholders = (n: number) => Array(n).fill('?').join(',')

/** The `books`, `book_pages`, `book_sections`, `book_chunks` (+ FTS) and `spend` tables. */
export function createBooksDb(db: Database.Database) {
  const insertBook = db.prepare(
    `INSERT INTO books (id, title, author, lang, pages, file_blob, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'uploaded', ?)`,
  )
  const selectBook = db.prepare('SELECT * FROM books WHERE id = ?')
  const selectBooks = db.prepare(
    'SELECT * FROM books ORDER BY created_at DESC, rowid DESC',
  )
  const updStatus = db.prepare(
    'UPDATE books SET status = ?, progress = COALESCE(?, progress), error = ? WHERE id = ?',
  )
  const updMethod = db.prepare(
    'UPDATE books SET ingest_method = ? WHERE id = ?',
  )
  const updEmbed = db.prepare(
    'UPDATE books SET embed_model = ?, dims = ? WHERE id = ?',
  )
  const delBook = db.prepare('DELETE FROM books WHERE id = ?')
  const blobUsers = db.prepare(
    'SELECT count(*) AS n FROM books WHERE file_blob = ?',
  )

  const upsertPage = db.prepare(
    `INSERT INTO book_pages (book_id, page_index, label, text, method) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (book_id, page_index) DO UPDATE SET label = excluded.label, text = excluded.text, method = excluded.method`,
  )
  const selPage = db.prepare(
    'SELECT book_id, page_index, label, text, method FROM book_pages WHERE book_id = ? AND page_index = ?',
  )
  const selPages = db.prepare(
    'SELECT book_id, page_index, label, text, method FROM book_pages WHERE book_id = ? ORDER BY page_index',
  )
  const selDone = db.prepare(
    'SELECT page_index FROM book_pages WHERE book_id = ? ORDER BY page_index',
  )

  const insSection = db.prepare(
    `INSERT INTO book_sections (book_id, parent_id, ord, level, title, page_start, page_end)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
  const selSections = db.prepare(
    'SELECT * FROM book_sections WHERE book_id = ? ORDER BY id',
  )
  const updSummary = db.prepare(
    'UPDATE book_sections SET summary = ?, tokens = ? WHERE id = ?',
  )

  const insChunk = db.prepare(
    `INSERT INTO book_chunks (book_id, section_id, ord, page_start, page_end, cite_label, heading_path, text, text_norm, tokens)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  const selChunks = db.prepare(
    `SELECT ${CHUNK_COLS} FROM book_chunks WHERE book_id = ? ORDER BY ord`,
  )
  const selChunksEmb = db.prepare(
    `SELECT ${CHUNK_COLS}, embedding FROM book_chunks WHERE book_id = ? ORDER BY ord`,
  )
  const selNoEmb = db.prepare(
    `SELECT ${CHUNK_COLS} FROM book_chunks WHERE book_id = ? AND embedding IS NULL ORDER BY ord`,
  )
  const selChunk = db.prepare(
    `SELECT ${CHUNK_COLS} FROM book_chunks WHERE id = ?`,
  )
  const updEmb = db.prepare('UPDATE book_chunks SET embedding = ? WHERE id = ?')
  const delChunks = db.prepare('DELETE FROM book_chunks WHERE book_id = ?')
  const delSections = db.prepare('DELETE FROM book_sections WHERE book_id = ?')

  const fts = (sections: boolean, n = 0) =>
    db.prepare(
      `SELECT c.id FROM book_chunks_fts JOIN book_chunks c ON c.id = book_chunks_fts.rowid
       WHERE book_chunks_fts MATCH ? AND c.book_id = ?
       ${sections ? `AND c.section_id IN (${placeholders(n)})` : ''}
       ORDER BY bm25(book_chunks_fts), c.id LIMIT ?`,
    )
  const ftsAll = fts(false)

  const selMethods = db.prepare(
    'SELECT method, count(*) AS n FROM book_pages WHERE book_id = ? GROUP BY method',
  )
  const selChunkCount = db.prepare(
    'SELECT count(*) AS n FROM book_chunks WHERE book_id = ?',
  )
  const failMidJob = db.prepare(
    `UPDATE books SET status = 'failed', error = ?
     WHERE status IN ('queued', 'extracting', 'structuring', 'embedding', 'summarising')`,
  )

  const insSpend = db.prepare(
    'INSERT INTO spend (at, kind, ref, cost_usd) VALUES (?, ?, ?, ?)',
  )
  const sumSpend = db.prepare(
    'SELECT COALESCE(SUM(cost_usd), 0) AS total FROM spend WHERE at >= ?',
  )

  const tx = <T>(fn: () => T): T => db.transaction(fn)()

  return {
    createBook(b: NewBook, now: number): BookRow {
      insertBook.run(
        b.id,
        b.title,
        b.author ?? null,
        b.lang ?? null,
        b.pages ?? null,
        b.fileBlob,
        now,
      )
      return toBook(selectBook.get(b.id) as RawBook)
    },
    getBook(id: string): BookRow | undefined {
      const r = selectBook.get(id) as RawBook | undefined
      return r && toBook(r)
    },
    listBooks: (): BookRow[] => (selectBooks.all() as RawBook[]).map(toBook),
    /** Sets the status; progress is kept unless given; the error is cleared unless given. */
    setStatus(
      id: string,
      status: BookStatus,
      o: { progress?: number; error?: string } = {},
    ): void {
      updStatus.run(status, o.progress ?? null, o.error ?? null, id)
    },
    setIngestMethod: (id: string, m: IngestMethod): void =>
      void updMethod.run(JSON.stringify(m), id),
    setEmbedModel: (id: string, model: string, dims: number): void =>
      void updEmbed.run(model, dims, id),

    /** Deletes the book and everything under it. `orphanBlob` is its file's blob id when no other book uses it. */
    deleteBook(id: string): { existed: boolean; orphanBlob: string | null } {
      return tx(() => {
        const b = selectBook.get(id) as RawBook | undefined
        if (!b) return { existed: false, orphanBlob: null }
        delBook.run(id)
        const users = (blobUsers.get(b.file_blob) as { n: number }).n
        return { existed: true, orphanBlob: users === 0 ? b.file_blob : null }
      })
    },
    /** Whether any book still uses this file blob. */
    blobInUse: (blobId: string): boolean =>
      (blobUsers.get(blobId) as { n: number }).n > 0,
    /** Books that were queued or running when the server went away can never finish: mark them failed so they can be retried or deleted. */
    failInterrupted: (message: string): number =>
      failMidJob.run(message).changes,
    methodCounts(bookId: string): Record<Rung, number> {
      const out: Record<Rung, number> = { R1: 0, R3: 0, R4: 0 }
      for (const r of selMethods.all(bookId) as { method: Rung; n: number }[])
        out[r.method] = r.n
      return out
    },
    chunkCount: (bookId: string): number =>
      (selChunkCount.get(bookId) as { n: number }).n,
    /** Drops sections and chunks (and their FTS rows) but keeps the extracted pages, the expensive part. */
    clearStructure(bookId: string): void {
      tx(() => {
        delChunks.run(bookId)
        delSections.run(bookId)
      })
    },

    upsertPage(p: PageRow): void {
      upsertPage.run(p.bookId, p.pageIndex, p.label, p.text, p.method)
    },
    getPage(bookId: string, pageIndex: number): PageRow | undefined {
      const r = selPage.get(bookId, pageIndex) as
        | {
            book_id: string
            page_index: number
            label: string | null
            text: string
            method: Rung
          }
        | undefined
      return (
        r && {
          bookId: r.book_id,
          pageIndex: r.page_index,
          label: r.label,
          text: r.text,
          method: r.method,
        }
      )
    },
    pagesOf: (bookId: string): PageRow[] =>
      (
        selPages.all(bookId) as {
          book_id: string
          page_index: number
          label: string | null
          text: string
          method: Rung
        }[]
      ).map((r) => ({
        bookId: r.book_id,
        pageIndex: r.page_index,
        label: r.label,
        text: r.text,
        method: r.method,
      })),
    pagesDone: (bookId: string): number[] =>
      (selDone.all(bookId) as { page_index: number }[]).map(
        (r) => r.page_index,
      ),

    /** Inserts the tree depth-first (document order); returns every row, flat, in that order. */
    insertSections(bookId: string, tree: SectionNode[]): SectionRow[] {
      return tx(() => {
        const out: SectionRow[] = []
        const walk = (
          nodes: SectionNode[],
          parentId: number | null,
          level: number,
        ) =>
          nodes.forEach((n, ord) => {
            const id = Number(
              insSection.run(
                bookId,
                parentId,
                ord,
                level,
                n.title,
                n.pageStart,
                n.pageEnd,
              ).lastInsertRowid,
            )
            out.push({
              id,
              bookId,
              parentId,
              ord,
              level,
              title: n.title,
              pageStart: n.pageStart,
              pageEnd: n.pageEnd,
              summary: null,
              tokens: null,
            })
            walk(n.children, id, level + 1)
          })
        walk(tree, null, 1)
        return out
      })
    },
    sectionsOf: (bookId: string): SectionRow[] =>
      (selSections.all(bookId) as RawSection[]).map(toSection),
    /** The given section ids plus every section below them. */
    withDescendants(bookId: string, ids: number[]): number[] {
      if (ids.length === 0) return []
      const rows = db
        .prepare(
          `WITH RECURSIVE d(id) AS (
             SELECT id FROM book_sections WHERE book_id = ? AND id IN (${placeholders(ids.length)})
             UNION SELECT s.id FROM book_sections s JOIN d ON s.parent_id = d.id
           ) SELECT id FROM d`,
        )
        .all(bookId, ...ids) as { id: number }[]
      return rows.map((r) => r.id)
    },
    setSectionSummary: (id: number, summary: string, tokens: number): void =>
      void updSummary.run(summary, tokens, id),

    /** Inserts in transactions of at most 200 rows; returns the new chunk ids in input order. */
    insertChunks(bookId: string, rows: ChunkIn[]): number[] {
      const ids: number[] = []
      for (let i = 0; i < rows.length; i += WRITE_BATCH)
        tx(() => {
          for (const c of rows.slice(i, i + WRITE_BATCH))
            ids.push(
              Number(
                insChunk.run(
                  bookId,
                  c.sectionId,
                  c.ord,
                  c.pageStart,
                  c.pageEnd,
                  c.citeLabel,
                  c.headingPath,
                  c.text,
                  c.textNorm,
                  c.tokens,
                ).lastInsertRowid,
              ),
            )
        })
      return ids
    },
    chunksOf(bookId: string, o: { withEmbedding?: boolean } = {}): ChunkRow[] {
      const stmt = o.withEmbedding ? selChunksEmb : selChunks
      return (stmt.all(bookId) as RawChunk[]).map(toChunk)
    },
    /** The chunks of one book at the given positions (`ord`), in order; positions that do not exist are skipped. */
    chunksByOrd(bookId: string, ords: number[]): ChunkRow[] {
      if (ords.length === 0) return []
      return (
        db
          .prepare(
            `SELECT ${CHUNK_COLS} FROM book_chunks WHERE book_id = ? AND ord IN (${placeholders(ords.length)}) ORDER BY ord`,
          )
          .all(bookId, ...ords) as RawChunk[]
      ).map(toChunk)
    },
    chunksWithoutEmbedding: (bookId: string): ChunkRow[] =>
      (selNoEmb.all(bookId) as RawChunk[]).map(toChunk),
    chunkById(id: number): ChunkRow | undefined {
      const r = selChunk.get(id) as RawChunk | undefined
      return r && toChunk(r)
    },
    setEmbeddings(pairs: { chunkId: number; vector: Float32Array }[]): void {
      tx(() => {
        for (const p of pairs) updEmb.run(toBlob(p.vector), p.chunkId)
      })
    },

    /** Chunk ids of one book ranked by BM25 over `text_norm` and `heading_path`; `match` is an FTS5 expression (see `ftsQuery`). */
    ftsSearch(
      bookId: string,
      match: string,
      sectionIds: number[] | undefined,
      limit: number,
    ): number[] {
      if (!match.trim()) return []
      const rows = (
        sectionIds
          ? sectionIds.length === 0
            ? []
            : fts(true, sectionIds.length).all(
                match,
                bookId,
                ...sectionIds,
                limit,
              )
          : ftsAll.all(match, bookId, limit)
      ) as { id: number }[]
      return rows.map((r) => r.id)
    },

    addSpend: (s: {
      at: number
      kind: 'turn' | 'embed' | 'summary' | 'ocr' | 'vision'
      ref: string | null
      costUsd: number
    }): void => void insSpend.run(s.at, s.kind, s.ref, s.costUsd),
    spentSince: (ts: number): number =>
      (sumSpend.get(ts) as { total: number }).total,
  }
}
