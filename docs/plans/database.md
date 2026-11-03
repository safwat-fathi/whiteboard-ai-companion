# Database

> Part of [PLAN.md](../PLAN.md) §14 (resolution R1) · Related: [deployment](./deployment.md) · [rag-context-engineering](./rag-context-engineering.md) · [library-ingestion](./library-ingestion.md) · [api](./api.md)

**One SQLite file** (`DATA_DIR/whiteboard.db`) via `better-sqlite3` 13, plus blobs on disk. No server, no ORM required.

## Why this fits

- Single owner, one server process: SQLite's single-writer model is a feature. Appending a batch is one short transaction.
- FTS5 provides BM25 keyword search in the same file; vectors are BLOBs searched exactly in memory.
- Backup is one online-backup call; restore is a file copy. Local and VPS are identical.
- Arabic note: FTS5 `unicode61` treats combining marks (harakat) as separators, so the indexed copy is normalised first (`text_norm`, see [library-ingestion](./library-ingestion.md)).

## Connection and pragmas

`journal_mode=WAL` · `synchronous=NORMAL` · `foreign_keys=ON` · `busy_timeout=5000` · `temp_store=MEMORY`.

- The server's main thread owns board writes. The ingestion worker thread opens its **own connection** and writes in short transactions (≤ ~200 rows) so board writes never wait long.
- All DB access goes through `apps/server/src/db/` (connection, migrations, typed queries). Nothing else imports `better-sqlite3`. This is also the seam for a Postgres revert.

## Schema (v1)

```sql
CREATE TABLE boards (
  id          TEXT PRIMARY KEY,                -- uuid v4
  title       TEXT NOT NULL,
  scope       TEXT NOT NULL DEFAULT '{}',      -- json: {kind:'topic'|'chapter'|'book', bookId?, sectionIds?, topic?}
  head_seq    INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,                -- epoch ms
  updated_at  INTEGER NOT NULL
);

CREATE TABLE board_ops (
  board_id     TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  seq          INTEGER NOT NULL,
  batch_id     TEXT NOT NULL,
  author_kind  TEXT NOT NULL CHECK (author_kind IN ('human','agent')),
  author_id    TEXT NOT NULL,                  -- 'owner' | 'tutor:<turnId>'
  turn_id      TEXT,                           -- set for agent batches
  label        TEXT NOT NULL,
  bounds       TEXT,                           -- json {x,y,w,h}, server-computed
  touched_ids  TEXT NOT NULL,                  -- json array of element ids
  -- migration 0002 adds: inverse TEXT (json Batch; agent batches only, for "Undo this response")
  ops          TEXT NOT NULL,                  -- json array of ops
  created_at   INTEGER NOT NULL,
  PRIMARY KEY (board_id, seq)
) WITHOUT ROWID;
CREATE INDEX board_ops_turn ON board_ops(board_id, turn_id);

CREATE TABLE board_snapshots (
  board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  seq      INTEGER NOT NULL,
  scene    BLOB NOT NULL,                      -- gzip(json), Node zlib
  PRIMARY KEY (board_id, seq)
);

CREATE TABLE blobs (
  id         TEXT PRIMARY KEY,                 -- sha256 hex (dedupe by content)
  mime       TEXT NOT NULL,
  bytes      INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);                                             -- file: DATA_DIR/blobs/<id[0:2]>/<id[2:4]>/<id>

CREATE TABLE books (
  id            TEXT PRIMARY KEY,
  title         TEXT NOT NULL,
  author        TEXT,
  lang          TEXT,
  format        TEXT NOT NULL DEFAULT 'pdf',
  pages         INTEGER,
  file_blob     TEXT NOT NULL REFERENCES blobs(id),
  status        TEXT NOT NULL,                 -- uploaded|queued|extracting|structuring|embedding|summarising|ready|failed
  progress      REAL NOT NULL DEFAULT 0,
  ingest_method TEXT,                          -- json: per-page-range rung choices
  embed_model   TEXT,
  dims          INTEGER,
  error         TEXT,
  created_at    INTEGER NOT NULL
);

CREATE TABLE book_sections (                   -- the TOC tree
  id         INTEGER PRIMARY KEY,
  book_id    TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  parent_id  INTEGER REFERENCES book_sections(id) ON DELETE CASCADE,
  ord        INTEGER NOT NULL,
  level      INTEGER NOT NULL,
  title      TEXT NOT NULL,
  page_start INTEGER, page_end INTEGER,        -- nullable for formats without pages (EPUB later)
  summary    TEXT,
  tokens     INTEGER
);

CREATE TABLE book_pages (
  book_id    TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  page_index INTEGER NOT NULL,                 -- 1-based position in the file
  label      TEXT,                             -- printed page label ("42", "xii")
  text       TEXT NOT NULL,                    -- extracted, display copy
  method     TEXT NOT NULL,                    -- R1|R2|R3|R4
  PRIMARY KEY (book_id, page_index)
);

CREATE TABLE book_chunks (
  id           INTEGER PRIMARY KEY,
  book_id      TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  section_id   INTEGER REFERENCES book_sections(id) ON DELETE SET NULL,
  ord          INTEGER NOT NULL,
  page_start   INTEGER, page_end INTEGER,
  cite_label   TEXT NOT NULL,                  -- "p. 42" or "§ 3.2 Light reactions"
  heading_path TEXT NOT NULL,
  text         TEXT NOT NULL,                  -- display copy (keeps $…$ LaTeX)
  text_norm    TEXT NOT NULL,                  -- search copy (normalised)
  tokens       INTEGER NOT NULL,
  embedding    BLOB                            -- Float32 LE, L2-normalised, books.dims long
);
CREATE INDEX book_chunks_book ON book_chunks(book_id, ord);

CREATE VIRTUAL TABLE book_chunks_fts USING fts5(
  text_norm, heading_path,
  content='book_chunks', content_rowid='id',
  tokenize='unicode61 remove_diacritics 2'
);                                             -- kept in sync by the standard external-content triggers

CREATE TABLE messages (
  id         TEXT PRIMARY KEY,
  board_id   TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  turn_id    TEXT NOT NULL,
  role       TEXT NOT NULL CHECK (role IN ('user','assistant')),
  parts      TEXT NOT NULL,                    -- json: AI SDK UI message parts
  context    TEXT,                             -- json on user messages: what was attached (see board-context)
  model      TEXT,
  usage      TEXT,                             -- json: tokens, cached tokens, cost
  created_at INTEGER NOT NULL
);
CREATE INDEX messages_board ON messages(board_id, created_at);

CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);   -- student profile, budget overrides

CREATE TABLE spend (                           -- one ledger for every paid call; daily cap sums it
  id       INTEGER PRIMARY KEY,
  at       INTEGER NOT NULL,
  kind     TEXT NOT NULL,                      -- turn|embed|summary|ocr|vision
  ref      TEXT,                               -- turn id or book id
  cost_usd REAL NOT NULL
);
CREATE INDEX spend_at ON spend(at);
```

Dropped from the design doc: `agent_tokens` (returns with MCP), `boards.owner_id`, Redis keys, `blobs.board_id` (page crops are shared across boards).

## Vector search (v1)

- Embeddings are stored as little-endian Float32, L2-normalised, so cosine = dot product.
- On first use per book (or scope) the server loads that book's vectors into one `Float32Array` cache (LRU, default 512 MB). A search scans only the vectors in scope (a chapter is tens of chunks; a whole book is a few hundred to a few thousand) and keeps top-k with a small heap.
- Hybrid: FTS5 `bm25()` top-30 over `book_chunks_fts` (filtered by `book_id`/page range) + vector top-30 → reciprocal-rank fusion in code ([rag-context-engineering](./rag-context-engineering.md)).
- **Ceiling:** ~200k chunks across the library, or any search above ~100 ms (**confirmed in S4a/S4b:** 100k × `1024-d` `baai/bge-m3` vectors take `83.6 ms` p95 and `390.6 MiB` RAM; 600 chunks take `0.51 ms` p95; cold-start load of 100k vectors from SQLite takes `236–351 ms`). **Upgrade:** `sqlite-vec` `vec0` virtual table behind the same `searchVectors(bookId, query, k)` function (not needed for v1).
- Changing `EMBED_MODEL` means re-embedding a book; `books.embed_model` and `dims` record what each book used. Mixed models across books are fine because each search is per book.

## Migrations

Numbered SQL files in `apps/server/migrations/` (`0001_init.sql`, …) applied in order inside a transaction, tracked with `PRAGMA user_version`. Forward-only. Before applying any pending migration the server performs an online backup of the DB via `VACUUM INTO 'DATA_DIR/backups/pre-migrate-<version>-<timestamp>.db'` (ruling R3, ensuring WAL consistency without corrupting or locking the active database; see [deployment](./deployment.md)).

## Board persistence rules

- **Append batch** (one transaction): `UPDATE boards SET head_seq = head_seq + 1, updated_at = ? WHERE id = ? RETURNING head_seq` → `INSERT INTO board_ops …`. Validation happens before the transaction.
- **Load board:** latest `board_snapshots` row + `board_ops` with `seq >` it. The server keeps the scene of active boards in memory and evicts after 10 idle minutes.
- **Snapshots:** every 500 batches or after 5 minutes of activity, whichever is first. Ops are kept forever in v1 (single-owner scale); `bounds`/`label`/`turn_id` stay queryable for [jump-to-ai](./jump-to-ai.md).
- **Bounds:** computed by the Board service after applying a batch (after-state bounds of added/patched elements; before-state for removed ones).

## Sizing (estimates)

A 400-page book ≈ 600 chunks ≈ 2.5 MB of 1024-d vectors + ~1.5 MB text. A busy board: ~2 KB per batch × tens of thousands of batches ≈ tens of MB. A library of 50 books stays well under 1 GB of DB; blobs (originals, page rasters, pictures) dominate disk.

## Revert path to Postgres + pgvector

If the library outgrows SQLite or multi-user arrives: reimplement `apps/server/src/db/` against Postgres (`pgvector` HNSW needs ≤ 2,000 dims, `tsvector` replaces FTS5, `LISTEN/NOTIFY` or Redis only if running several instances). Schema maps one-to-one; `bounds`/`ops` become `jsonb`. Nothing outside `db/` changes.
