# Spikes, tests and verification

> Part of [PLAN.md](../PLAN.md) §18 · Related: [whiteboard-engine](./whiteboard-engine.md) · [library-ingestion](./library-ingestion.md) · [rag-context-engineering](./rag-context-engineering.md) · [ai-integration](./ai-integration.md) · [deployment](./deployment.md)

What I could not verify while planning, how M0 settles it, and how we know each part works afterwards.

## M0 spikes

| Spike | Question | Done when |
|---|---|---|
| **S1 Canvas** | 5,000 elements at 60 fps; first ink ≤ 16 ms; a 20,000-element board opens in < 2 s. `@napi-rs/canvas` shapes Arabic with the bundled font and rasterises MathJax SVG, including `\text{}` with Arabic (finding F14). R-tree and freehand: leaf library vs in-house (F12) | Numbers recorded; main-thread vs worker and snapshot path decided; font chosen |
| **S2 Ingestion** | Run rungs R1–R4 on your 2–3 books; score reading order, headings, math/LaTeX fidelity, Arabic correctness (presentation forms, reversed lines), time and cost; learn the `file-parser` plugin's request shape and page/size limits | Per-book-type default and page-routing thresholds chosen |
| **S3 OpenRouter loop** | With 3 candidate models and the real zod tools: tool calling works; image in a tool result vs follow-up user message; cache hits on turn 2 and 1-hour TTL pass-through; **cost arrives after each step in streaming mode** (`compatibility: 'strict'`, `usage.include`); Arabic answer quality; `data_collection: "deny"` still routes; measured cost per turn | Tutor / cheap / vision defaults and the snapshot adapter behaviour chosen; cost envelope replaced by measured numbers |
| **S4 Embeddings and search** | `bge-m3` (1024-d) vs `qwen3-embedding-8b` vs `text-embedding-3-small`, hybrid vs vector-only, on your questions. Exact in-memory search latency at 600 chunks (one book) and at 100k × 1024 synthetic vectors | Model, `k` and `EMBED_DIMS` chosen; recall@8 recorded; latency within budget or `sqlite-vec` scheduled |
| **S5 Deploy dry-run** *(optional, deferred: only if a VPS exists; local app first)* | A hello-world NestJS (WebSocket + SSE) and Next behind Caddy on the real VPS with basic auth: WebSocket works with cached credentials; SSE is not buffered; `better-sqlite3` and `@napi-rs/canvas` load on the VPS arch; systemd units start; the `web` unit's start command is correct; static-export option measured | Gate decision recorded (basic auth vs Tailscale/cookie; keep or drop the `web` process) |

Spikes S1, S3 and S5 need no books; S2 and S4 wait for the books ([PLAN.md](../PLAN.md) §19).

## M0 results

- **S1 Canvas** (`spikes/s1-canvas/RESULT.md`): DPR 2 cached `46.5` fps pan / `40.7` fps zoom (`OffscreenCanvas` worker `43.9` / `39.8`, slower), first ink p95 `0.9` ms, open 20k `1,412` ms; `rbush` (load 20k `8.2` ms, query p95 `0.1` ms) and `perfect-freehand` (`0.43` ms at 1,000 pts) kept. `@napi-rs/canvas` shapes Arabic with bundled `IBM Plex Sans Arabic`; MathJax v4 SVG rasterises on server canvas (`latin-only` inside math, F14 closed). Decisions: `renderThread: main`, `textStrategy: cached`, `snapshotPath: server-canvas`, `font: plex`, `mathTextArabic: latin-only`.
- **S2 Ingestion** (`spikes/s2-ingestion/RESULT.md`): R1 (`pdfjs-dist`, 1.9–8.9 ms/page) for text PDFs (`ck12`, `alg1`, `alg2`); R2 (`cloudflare-ai`) dropped (no LaTeX, empty on scans, 2.1–5.5 MB file-size cap); R3 (`mistral-ocr` via OpenRouter, `$0.0205` / 10 pages, returns one `text` element per page in `annotations[0].file.content` between `<file>` and `</file>`) benchmarked on scanned/Arabic/math-dense pages; R4 (`VISION_MODEL` on page PNGs; benchmarked with `gemini-3.8-flash` in S2, and run via **Meta Model API** with `muse-spark-1.3` at runtime; open-weights Llama 4 via OpenRouter) serves as the active fallback after R1 now that runtime LLM/vision calls use the Meta Model API. Slice with `pdf-lib` `copyPages` (never `pdfseparate`), and strip `\x00–\x1F` / PUA `\uE000–\uF8FF` from `pdfjs-dist` text.
- **S3 OpenRouter loop (benchmarked baseline) → Meta Model API transition** (`spikes/s3-openrouter/RESULT.md`): S3 verified `providerMetadata.openrouter.usage.cost` per streamed step, AI SDK 7 `instructions` system prompt handling, `tool-result-image` (`toModelOutput` with `file` part) on all 4 tested models, 1 h prompt cache (`17,433` cached tokens on turn 2), and `data_collection: "deny"`. **S3 benchmarked models:** `anthropic/claude-haiku-5.5` (English tutor + `cheap`, `$0.0005`/turn), `google/gemini-3.8-flash` (Arabic tutor, `$0.0049`/turn, 3.5/5 AR), `anthropic/claude-sonnet-5.5` (reviewer, `$0.0118`/turn, 4.5/5 AR), and `openai/gpt-6-luna` (`$0.0002`/turn, dropped on 2.5/5 AR). **Post-M0 provider update:** runtime LLM/vision calls target the **Meta Model API** (`META_API_KEY`, `https://api.meta.ai/v1`) using Meta models (`muse-spark-1.3` for tutor/Arabic/vision/cheap/fallback and `muse-wonder-1.0` for reviewer; `SNAPSHOT_ADAPTER=follow-up-user` required as `api.meta.ai` rejects image data in tool messages).
- **S4 Embeddings and search** (`spikes/s4-search/RESULT.md`): **S4a** exact 1024-d cosine scan p95 `0.51` ms at `N=600`, `8.33` ms at `N=10k`, `83.6` ms and `390.6` MiB at `N=100k` (cold-start load from SQLite `236–351` ms). **S4b** across 3 books (`ck12` 718 chunks, `alg1` 751 chunks, `arabic` 40 R3-OCR chunks, 30 questions in `eval/*.jsonl`): `baai/bge-m3` (`1024-d`, `$0.0058` via `OPENROUTER_API_KEY`, kept strictly for embeddings) hits `100%` vector@8 (`MRR 0.947`), `93.3%` hybrid@8 (`MRR 0.747`; `100%` `ck12`, `100%` `alg1`, `80%` `arabic`), and `96.7%` (`MRR 0.838`; `90%` `arabic`) with `±1` chunk neighbours. Decisions: `vectorSearch: exact`, `embedModel: baai/bge-m3`, `EMBED_DIMS: 1024`, `k: 8`, retry `429`/`5xx` with backoff.
- **S5 Deploy dry-run**: deferred (VPS is optional; local app is the priority).

## M4 results

Measured 2026-11-03 on the three real books, ingested with `pnpm ingest` (Muse for R4, `baai/bge-m3` for vectors) and scored with `pnpm eval:retrieval` over `eval/*.jsonl` (10 questions each; the gate is hybrid recall@8 ≥ 80%):

| Book | Pages | Read as | Chunks | keyword | vector | hybrid | hybrid + neighbours |
|---|---|---|---|---|---|---|---|
| CK-12 Algebra 1 | 652 | R1 638, R4 14 | 510 | 100% (MRR 0.912) | 100% (0.914) | **100%** (0.914) | 100% (0.914) |
| Algebra 1 Volume 1 | 700 | R1 659, R4 41 | 461 | 100% (0.925) | 100% (0.900) | **100%** (0.933) | 100% (0.933) |
| الجبر الخطي (scan) | 383 | R4 383 | 189 | 60% (MRR 0.253) | 80% (0.550) | **90%** (0.437) | 100% (0.470) |

S4b measured 93.3% hybrid@8 over the same questions on R1/R3 text (Arabic: 80%, 90% with neighbours, but over 40 pages); the figures above are on what the shipped pipeline stores, and the Arabic row searches all 383 pages. Its one miss asks for the basis of a subspace of cubic polynomials (page 78): the hybrid top 8 lands on pages 72 to 74, and the neighbours reach it. Page 78 is the page whose Muse transcription was cut off at 4,000 tokens in S2; with the 12,000-token budget it comes through whole (1,220 characters, LaTeX included). Embedding the three books cost $0.0086 on OpenRouter in total; Muse calls are not priced. A book is not "done" because it reached `ready`: the first Arabic run did exactly that with 367 empty pages (JBIG2 images rendered blank; PLAN §19 #44), so `runIngest` now refuses a book whose R4 pages are mostly empty.

## Risks

| Risk | Mitigation |
|---|---|
| Text editing on a canvas (IME, selection, RTL) | The doc's `<textarea>` overlay; test Arabic and Latin from M1 |
| Arabic shaping on a server canvas | S1; fallback ladder (browser tab → headless Chromium) |
| Large boards miss the frame budget | S1; worker-canvas path ready (the renderer is pure) |
| PDF math / Arabic extraction quality | S2 ladder; per-page routing; preview before indexing |
| AI clutters the board | Element budget, titled clusters, `placement: auto`, `arrange`, *Undo this response* |
| Retrieval returns the wrong page | Hybrid search; heading-path embedding; eval gate; neighbours; chunk context only if the eval demands |
| Cost surprise | Caps, usage view, key credit limit, ingestion estimates, cost via `onStepFinish` (S3) |
| Model IDs / AI SDK majors churn | All models in env; fallback model; pinned versions; one adapter module |
| Prompt injection via books or board text | Delimited data, no network tools, edit-rights guard, validated citations |
| Basic auth + WebSocket misbehaves | S5; Tailscale or cookie fallback |
| SQLite write contention during ingestion | Worker thread with short transactions; `busy_timeout`; S4/M4 load test |
| Ingestion of a large book is slow | Background queue, progress, resumable steps |

## Test strategy

| Layer | Tooling | What |
|---|---|---|
| Core (ops, undo, store, bounds, tool registry) | Vitest | Property test: apply then inverse = identity; conflict rules; edit-rights guard; digest ordering/cap on a 500-element fixture |
| Renderer | Vitest + golden images | Same adapter the server uses: shapes, Arabic + Latin text, ~20 LaTeX equations ([math-renderer](./math-renderer.md)); browser vs server pixel diff within tolerance |
| Server | Vitest | Route contract tests, WebSocket ordering with two clients, migrations on a copy of a DB, backup/restore |
| Library | Vitest + `pnpm eval:retrieval` | Section counts, page-label mapping, no chunk crossing an equation, resumability, retrieval recall/MRR |
| End-to-end | Playwright, `TUTOR_STUB=1` | Scripts below; deterministic and free |
| Live tutor | Manual, once per milestone | One real Meta Model API run of the M5 script; read the cost footer |

CI (GitHub Actions or local script): `pnpm/action-setup`, `pnpm install --frozen-lockfile`, `pnpm lint`, `pnpm typecheck`, `pnpm test`. `pnpm e2e` (the M1 gate included) runs locally, not in CI yet: it needs a dev server because `window.__editor` is dev-only.

## Acceptance scripts

**Tutor end-to-end (M5 gate).** Upload a PDF → index → create a board with a chapter scope → type a question → text + math + shape appear on the board with `[p. N]` citations → clicking a citation opens the page in the Source tab → Stop mid-turn leaves a consistent board → *Undo this response* removes it.

**Board context (R3).** Select 3 elements (one handwritten stroke) → the Selection chip shows "3 · structure + picture (auto)" → "What the AI sees" lists those ids and a thumbnail → send → the recorded model request contains the digest with those ids and one image → ask "make this red" → only the selected elements change → ask it to edit an unselected human element → rejected with a clear reply. Then attach Viewport and Whole board and confirm payload sizes stay within the digest budget.

**In-app chat (R2).** Everything above runs from the dock with no other tool; reload restores the history; the composer works with Arabic input (`dir="auto"`).

**Jump to AI.** Scenarios in [jump-to-ai](./jump-to-ai.md): live (Follow off and on), past, after reload, after deletion, after moving an element, deep links.

**Caching and cost.** Turn 2 shows `cached_tokens > 0` when supported by the provider; `MAX_STEPS=2` or `MAX_TURN_COST_USD=0.01` stops a runaway loop with a clear message; the `spend` ledger matches token-based model pricing (or OpenRouter activity for embeddings) within rounding.

**Library.** Ingest one real book per type; `pnpm eval:retrieval` meets the target (expected page in the top 8 for ≥ 80% **[my call]**); the preview/estimate flow is cancelable before any paid rung.

**Library acceptance script (M4 gate).** `e2e-server/m4-gate.spec.ts`, run by `pnpm e2e:server` with the server started under `INGEST_STUB=1` (offline providers, so it is deterministic and free): (1) upload a small PDF on `/library`, the dialog shows the estimate and, on "Compare readings", the local text beside the vision text with nothing started; **Index**; the card reaches "Ready"; open the book, the outline lists both chapters; search, click the hit, the page image loads and the caption gives the printed label next to the file page; tick a chapter, **Study this** creates a board with a `chapter` scope and opens the editor on it. (2) A 250-page book is killed mid-job (the server is stopped while it is `extracting`), the restarted server marks it failed ("interrupted by a restart"), the card shows **Retry**, and it finishes. (3) An upload with a foreign `Origin` is `403 forbidden_origin` and stores nothing. The unit layer covers the rest: kill-and-resume per stage, truncated and empty vision pages, the daily cap, hostile uploads, range requests, 5,000 chunks written by a worker while board batches land.

**Security.** Origin rejection for a foreign Origin on WebSocket and POST; LaTeX payloads inert; injection seed text ignored ([auth-security](./auth-security.md)); no key in the web bundle, logs or DB.

**Deployment.** `pnpm dev` works on this machine with only Node and pnpm; the VPS serves only through the gate; the services survive a reboot; the backup restores onto a clean directory ([deployment](./deployment.md)).

**Engine.** The M0 benchmark; golden-image tests; Arabic and Latin text editing with an IME.

**Engine acceptance script (M1 gate).** `e2e/gate.spec.ts`, run by `pnpm e2e` (locally; not in CI yet): with real pointer and keyboard input (the dev-only `window.__editor` is read for assertions only) it draws two shapes and a bound arrow, types Arabic and Latin text, moves a shape and checks the arrow's end follows, undoes twice and redoes once (toolbar and shortcut), waits for autosave by polling IndexedDB, reloads and checks the scene (count, text, binding ids) and that undo still works, opens a second tab and checks the read-only banner, and fails on any console error. A synthetic IME composition is covered in `e2e/text.spec.ts`; a real Arabic keyboard is the manual demo. The performance bench is `pnpm bench` (it builds the app, so stop any `next dev` first; headed Google Chrome on `:3100`; not part of CI) and writes its numbers to `apps/web/src/bench/RESULT.md`.

**Server acceptance script (M3 gate).** `e2e-server/m3-gate.spec.ts`, run by `pnpm e2e:server` (using `playwright.server.config.ts`, running web on `:3100` and server on `:4100` with an isolated temporary `DATA_DIR`):
1. **Two tabs in sync:** Tab A and Tab B join the same board. Tab A draws a rectangle, Tab B receives it; Tab B moves it, Tab A sees the updated coordinates; concurrent edits to the same element's color converge to identical scene state (ignoring internal version counter `v`).
2. **Offline queue & restart recovery:** Server is stopped while tabs are open. Tab A draws an element; the in-app notice warns "Offline: changes are not saved". The server restarts with the same `DATA_DIR`; Tab A reconnects and replays the queued batch; Tab B receives the batch; both tabs reload and display the identical board.
3. **Server restart with no clients:** The server is stopped and restarted with no active connections; subsequent reloads verify the board persists in SQLite.
4. **Access gate, Origin and Host checks:** `POST /api/boards` with `Origin: http://evil.test` returns 403 `forbidden_origin`; a WebSocket handshake with that Origin is refused; HTTP requests and WebSocket handshakes with unrecognized `Host` headers are rejected with 400.
5. **Image upload and sync:** Dropping a PNG into Tab A uploads bytes to `POST /api/blobs`, stores the blob by SHA-256 hash on disk, broadcasts the image element; Tab B fetches and renders the blob from `GET /api/blobs/:id`; page reload preserves the image.
6. **Server PNG export matches browser:** A board containing rectangles, Arabic and Latin text, LaTeX math, and an image is exported via `GET /api/boards/<id>/export.png` and compared to a browser screenshot clip of the exact same bounding box at DPR 1 using `pixelmatch`: differing pixels are ≤ 1.5% at per-channel threshold 24.
7. **Clean console:** No uncaught exceptions or unexpected console errors across all tabs.

## Definition of done per milestone

Gate in [PLAN.md](../PLAN.md) §17 met, tests for the milestone's scripts green, the relevant plan file updated if reality changed, and any new decision recorded in PLAN.md §19.
