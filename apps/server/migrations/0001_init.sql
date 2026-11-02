-- 0001_init: the full v1 schema of docs/plans/database.md (M4 tables included, so no later migration is needed for them).
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

-- External-content FTS5 triggers for book_chunks_fts (the standard recipe).
CREATE TRIGGER book_chunks_ai AFTER INSERT ON book_chunks BEGIN
  INSERT INTO book_chunks_fts (rowid, text_norm, heading_path)
  VALUES (new.id, new.text_norm, new.heading_path);
END;
CREATE TRIGGER book_chunks_ad AFTER DELETE ON book_chunks BEGIN
  INSERT INTO book_chunks_fts (book_chunks_fts, rowid, text_norm, heading_path)
  VALUES ('delete', old.id, old.text_norm, old.heading_path);
END;
CREATE TRIGGER book_chunks_au AFTER UPDATE ON book_chunks BEGIN
  INSERT INTO book_chunks_fts (book_chunks_fts, rowid, text_norm, heading_path)
  VALUES ('delete', old.id, old.text_norm, old.heading_path);
  INSERT INTO book_chunks_fts (rowid, text_norm, heading_path)
  VALUES (new.id, new.text_norm, new.heading_path);
END;
