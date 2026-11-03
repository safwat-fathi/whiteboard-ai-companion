# Library and ingestion

> Part of [PLAN.md](../PLAN.md) §11 · Related: [rag-context-engineering](./rag-context-engineering.md) · [database](./database.md) · [ai-integration](./ai-integration.md) · [api](./api.md) · [testing-spikes](./testing-spikes.md)

Turns an uploaded book into something the tutor can search, quote, cite and draw from.

## Scope of v1

- **PDF only** **[my call]**. EPUB, Markdown and TXT have no fixed pages, which citations, `add_book_figure` and the eval all assume, so they arrive in v1.1. The schema already allows it: nullable page fields and a `cite_label` ("p. 42" or "§ 3.2 Light reactions"). Tell me if your books are EPUB and EPUB moves into M4.
- Any language; **Arabic and English are tested explicitly**.
- Limits **[my call]**: ≤ 200 MB, ≤ 2,000 pages, magic-byte validation (`%PDF-`), original stored in `blobs/`.

## Flow

```
upload ─▶ uploaded ─▶ estimate + preview ─▶ [Index] ─▶ queued ─▶ extracting ─▶ structuring
                                                                     ─▶ embedding ─▶ summarising ─▶ ready | failed
```

1. `POST /api/books` (multipart) stores the file as a blob, creates the row (`uploaded`), reads page count and metadata.
2. `GET /api/books/:id/estimate`: pages, text-density histogram, suggested routing, cost per paid rung. `POST /api/books/:id/preview {pages:[1,2,3]}`: original page image next to the extracted text per rung, so the student can compare before paying anything.
3. `POST /api/books/:id/index` starts the job. Any paid rung shows its estimate first and counts against the daily budget ([auth-security](./auth-security.md)).
4. Progress is polled from `GET /api/books/:id` (`status`, `progress`). Failed jobs keep their error; **Retry** resumes.

## Extraction ladder (per book, per page range)

| Rung | Method | Cost | Good at | Weak at |
|---|---|---|---|---|
| R1 | Local: `pdfjs-dist` text + outline + page labels (compare against `pdftotext -layout`) | free | Text PDFs, speed | Equations, scans, multi-column reading order |
| ~~R2~~ | ~~OpenRouter `file-parser`, engine `cloudflare-ai`~~ **dropped (S2):** only a text dump like R1, no LaTeX, empty pages on scans, and a file-size limit between 2.1 and 5.5 MB | | | |
| ~~R3~~ *(M0 S2 benchmark baseline)* | OpenRouter `file-parser`, engine `mistral-ocr` | $2 / 1,000 pages (`$0.0205` / 10 pages in S2) | Benchmarked in S2/S4b on scanned, Arabic & math pages | Requires OpenRouter `file-parser` plugin; replaced at runtime by R4 via Meta Model API |
| R4 *(active fallback after R1)* | `VISION_MODEL` via **Meta Model API** (`muse-spark-1.3`; open-weights `meta-llama/llama-4-maverick` via OpenRouter) transcribes page images → Markdown + LaTeX *(S2 also benchmarked `google/gemini-3.8-flash`)* | ≈ $0.05–0.40 per 400 pages | Scanned pages, Arabic scans, math-dense pages, figures | Slower than R1; check for invented text |

- **As built (M4, 2026-11-03):** default per-page routing is R1 for pages with ≥ 50 characters and ≤ 5% math symbols and **R4 (`muse-spark-1.3`) for the rest**; R3 runs only for pages the student names (`POST …/index {methods}`) and is checked against the daily budget first. R4 hardening: 4 pages in flight, `max_tokens` 12,000 (Muse spends reasoning tokens first), one retry at 24,000 when the answer was cut off (a page still cut off is kept and listed in `ingest_method.warnings`), 429/5xx retried with backoff. A scan whose images pdfjs cannot decode renders blank and the model answers nothing: a book whose R4 pages are mostly empty fails (`ingest_failed`) and the empty pages are cleared so a retry reads them again. Real books: Algebra 1 41 of 700 pages go to R4, CK-12 14 of 652, the Arabic scan 383 of 383 (JBIG2 needs pdfjs `wasmUrl`).
- **Per-page routing:** low text density → scanned → R4 (`VISION_MODEL` via Meta Model API); math-dense pages → R4 for those pages only; everything else R1 (`pdfjs-dist`). Strip raw `\x00–\x1F` control chars and PUA glyphs (`\uE000–\uF8FF`) emitted by `pdfjs-dist` on math fonts before chunking.
- **M0 Spike S2 & S4b benchmarked baseline (R3 `mistral-ocr` & R4 `gemini-3.8-flash`):** In M0 before switching to the Meta Model API, S2 tested R1 → R3 (`mistral-ocr` via OpenRouter `file-parser`, `$0.0205` per 10 pages, returning one `text` element per page in `message.annotations[0].file.content` between `<file name="…">` and `</file>`, sliced with `pdf-lib` `copyPages`) → R4 (`google/gemini-3.8-flash` on 130 dpi PNGs). See `spikes/s2-ingestion/RESULT.md` and `spikes/s4-search/RESULT.md`.
- `pdfjs-dist` runs in the worker thread using its legacy Node build; page rasters (for R4, the Source tab and `add_book_figure`) use `@napi-rs/canvas` and are cached on disk under `DATA_DIR/cache/pages/<book>/<n>@2x.png`.

## Arabic and normalisation

- Display copy keeps the original text. The **search copy** (`text_norm`) is: NFKC (folds Arabic presentation forms U+FB50–FEFF), strip tatweel (U+0640) and harakat (U+064B–U+065F, U+0670), fold alef variants (أ إ آ → ا), ya (ى → ي) and ta marbuta (ة → ه), Arabic-Indic digits → ASCII, lower-case Latin. FTS5 would otherwise split words at combining marks.
- If R1 returns reversed (visual-order) or presentation-form lines, those pages go to R3/R4, unless S2 shows a reliable per-line fix.
- Mixed Arabic/English pages are split into runs for the `dir` of chunks only if S2 shows it matters.

## Structure

- **As built:** the PDF outline when it is usable, else fixed 20-page sections titled "Pages a–b" (an outline with more than 30 entries and more than half as many entries as pages is a scan bookmarked image by image, like the Arabic book's 390 `IMG_xxxx` entries, and is ignored). Heading detection by font size and LLM TOC inference are **not built**. Originally planned: the PDF outline; fallback heading detection by font-size jumps; last resort: `CHEAP_MODEL` infers a TOC from the first pages. Stored as the `book_sections` tree with page ranges.
- Record both **page index** and the **printed page label** (`getPageLabels()`), so citations match the numbers printed in the book (roman numerals, offsets).

## Chunking

Heading-aware, 400–800 tokens, ~12% overlap; never split inside an equation, table, code block or figure caption. Each chunk carries `section_id`, `heading_path` and a page range. The text embedded is `heading_path + chunk` (cheap contextual retrieval). LLM-written chunk context is deferred until the eval shows it is needed.

## Embeddings and index

- OpenRouter `POST /api/v1/embeddings` (`OPENROUTER_API_KEY`, used strictly for embeddings since Meta's Llama API does not expose an embeddings endpoint), batched (retry `429`/`5xx` with backoff; S4b saw transient `429` on 5 of 24 batches with `data_collection: 'deny'`, all succeeding on retry 1). **Confirmed in S4b:** default `baai/bge-m3` (`1024-d`, `k = 8`, multilingual, 8k context, `$0.01`/M tokens — `100%` vector@8, `93.3%` hybrid@8, `96.7%` with `±1` neighbours across `ck12`, `alg1` and `arabic`). `qwen/qwen3-embedding-8b` (`4096-d`) and `openai/text-embedding-3-small` (`1536-d`) achieved identical `93.3%` hybrid@8 at higher cost and exceed S4a's `512 MiB` / `100 ms` budget at 100k chunks.
- Vectors are L2-normalised Float32 BLOBs in `book_chunks.embedding`; `books.embed_model` and `dims` record what was used.
- Keyword index: FTS5 over `text_norm` and `heading_path` ([database](./database.md)). English stemming (a `porter` table) is added only if the eval shows keyword recall problems.

## Summaries (ingest time, `CHEAP_MODEL`)

Bottom-up: leaf sections → chapters → book. 150–400 tokens each plus key terms, stored in `book_sections.summary`. They become the scope packs in [rag-context-engineering](./rag-context-engineering.md).

## Jobs

- In-process sequential queue; the job runs in a **worker thread** (own SQLite connection, short write transactions) so PDF parsing never blocks the WebSocket. Status lives in `books.status`.
- Each step is idempotent and resumable: per-page extraction results are cached in `book_pages`, so a restart or retry skips finished pages. No Redis, no BullMQ.
- A cancelled or failed job leaves usable partial data marked `failed`; deleting the book cascades.

## Library UI

- **Library page:** upload dropzone, book cards (title, pages, status/progress, method used, cost), delete.
- **Book page:** outline tree (from `book_sections`), per-section page range, summary preview, **Study this** (creates a board with a scope), re-index.
- **Scope picker** (also reachable from the board's scope chip): *Topic* (free text, optionally across the library) · *Chapter(s)* (tick sections) · *Whole book*.
- **Source tab:** the browser renders the cited page with `pdfjs-dist` from `GET /api/books/:id/file` (range requests); in-page highlighting is v1.1. If a page is a scan, the cached raster is shown.

## Deletion and re-embedding

Deleting a book removes rows (cascade), cached rasters and its search vectors from memory; the original blob stays until no book references it. Changing `EMBED_MODEL` offers a per-book **Re-embed**; mixed models across books are fine.

## Tests

`pnpm ingest <pdf>` on a text PDF, a math PDF and an Arabic PDF; assertions on section counts, page-label mapping, no chunk crossing an equation, resumability (kill mid-run, re-run), and the retrieval eval ([testing-spikes](./testing-spikes.md)).
