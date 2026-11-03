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
- **S3 OpenRouter loop (benchmarked baseline) → Meta Model API transition** (`spikes/s3-openrouter/RESULT.md`): S3 verified `providerMetadata.openrouter.usage.cost` per streamed step, AI SDK 7 `instructions` system prompt handling, `tool-result-image` (`toModelOutput` with `file` part) on all 4 tested models, 1 h prompt cache (`17,433` cached tokens on turn 2), and `data_collection: "deny"`. **S3 benchmarked models:** `anthropic/claude-haiku-5.5` (English tutor + `cheap`, `$0.0005`/turn), `google/gemini-3.8-flash` (Arabic tutor, `$0.0049`/turn, 3.5/5 AR), `anthropic/claude-sonnet-5.5` (reviewer, `$0.0118`/turn, 4.5/5 AR), and `openai/gpt-6-luna` (`$0.0002`/turn, dropped on 2.5/5 AR). **Post-M0 provider update:** runtime LLM/vision calls target the **Meta Model API** (`MODEL_API_KEY`, `https://api.meta.ai/v1`) using Meta models (`muse-spark-1.3` for tutor/Arabic/vision/cheap/fallback and `muse-wonder-1.0` for reviewer; `SNAPSHOT_ADAPTER=follow-up-user` required as `api.meta.ai` rejects image data in tool messages).
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

## M5 results

Run 2026-11-03 with the scripted model (`TUTOR_STUB=1`; deterministic and free) unless stated. In a scratch worktree: `pnpm e2e:server` 8/8 (M3 ×2, M4 ×3, and the three M5 scripts below), `pnpm e2e` 15/15 (editor, local mode), production build clean. Unit: server 415, core 195, web 459 (+1 skipped).

**Re-run at `0bf2509` (after the Tailwind overhaul, _New chat_ and the hidden spend chip), 2026-11-03:** lint 0 errors (10 stale `biome-ignore` warnings), typecheck clean, production build clean with no key name or value in the output, `pnpm e2e:server` 8/8, `pnpm e2e` 15/15 (own port, local mode). Unit: math 20, server 415 (+1 skipped: it needs a real book on disk), web 460 (+1 skipped), core 194 of 195: `text.test.ts` "10,000-char single word" has a 1 s bound that a loaded machine and the GitHub runner exceed (it passes alone), so `pnpm test` can exit 1 there; `contention.test.ts` (M4) also trips on the runner. Two regressions found and fixed: the AI hover tag spawned under the pointer and its hit margin covered *Show in chat* (m5-jump), and the parity script hid the top bar with `visibility`, which the bar's `transition-all` animated (m3-gate).

| Script | Spec | What it proves |
|---|---|---|
| Tutor end-to-end (the gate) | `e2e-server/m5-gate.spec.ts` | upload → index → *Study this* a chapter → ask → text, formula and shape on the board with `[p. N]` → the citation opens the Source tab on the right page → Stop mid-answer leaves a consistent board and a ready composer → *Undo this response* removes exactly that response → Arabic composer → reload restores the conversation and the verified citation; no console errors |
| Board context (without its handwriting step, M6) | `e2e-server/m5-context.spec.ts` | the selection chip, *What the AI sees* (ids, a picture, a size), the model's request holds the digest with the ids and exactly one image, "make these red" changes only the selection, an unselected element is refused with a reason the model sees, viewport and whole-board pictures stay inside the digest budget |
| Jump to AI | `e2e-server/m5-jump.spec.ts` | the off-screen arrow, Jump and Back, Follow (and taking the canvas turns it off), the Activity tab after reload, Locate following a moved element and showing a ghost for a deleted one, the hover tag and Show in chat, deep links |
| Caching and cost | server tests | the system prefix is byte-identical across steps and turns; the footer shows cached tokens; `MAX_STEPS=2` and a priced `MAX_TURN_COST_USD` stop a looping stub; the ledger equals tokens × price |
| Security | server tests + a build | an upstream error that quotes the API key reaches no stream, stored message, table or log; book pages, board text and summaries cannot close the tags they sit in; every new POST/PUT needs the right Origin; with fake keys set during `next build`, neither their values nor their names appear in the client output |

**Live Meta Model API (api.meta.ai), probed 2026-11-03:** `reasoning_effort: "low"` is accepted (HTTP 200); on a one-word answer the reasoning tokens were 208 with it and 256 without, which is noise, so it is wired as an optional, default-off setting. **Not yet run (yours):** one real run of the gate script from the UI on an ingested book, reading the cost footer (tokens always, dollars only if `TUTOR_PRICE_*` is set); long turns may need a higher `TURN_TIMEOUT_MS` (Muse took 15–25 s per step in S3).

## M6 results

Run 2026-11-03 with the scripted model (`TUTOR_STUB=1`) unless stated. At `c52484e`, in a fresh worktree: frozen install, lint 0 errors (11 `biome-ignore` warnings that predate M6), typecheck clean, production build clean with no key name in the client build; unit core 354/355, math 20, web 548, server 422; `pnpm e2e` 17/17 (editor, local mode) and `pnpm e2e:server` 9/9; after stage 5 (groups, resize, snap, Arrange menu): core 379/380, web 572, server 422, `pnpm e2e` 18/18, `pnpm e2e:server` 9/9. The one unit failure is `text.test.ts` "handles a 10,000-char single word quickly" (a 1 s bound: 0.6 s alone, 1.3 to 2.0 s inside the parallel core suite). It predates M6, is load-sensitive, and is what turns CI red before the build step is reached.

| Script | Spec | What it proves |
|---|---|---|
| Ink | `e2e/m6-ink.spec.ts` | real mouse input draws a pen stroke (one `add`, nothing committed while the button is down), undo and redo, reload keeps it, a highlight over text, erase, a second tab is read-only, no console errors; the server picture of a stroke and a highlight matches the browser's (`e2e-server/m3-gate.spec.ts`) |
| Chart | `e2e/m6-chart.spec.ts` | `C` and a click add a chart and open its grid; a non-number is refused where it is typed; an edit is one undo step; the bars are on the canvas; it survives a reload; double-click reopens the grid. Typed keys (tool letters, Delete, Backspace) stay in the grid's cells |
| Board context, handwriting step | `e2e-server/m5-context.spec.ts` | three strokes drawn with the mouse and a box are selected, the chip says "structure + picture (auto)" with `structure` chosen, *What the AI sees* lists the ids and one thumbnail, the request holds exactly one image and the stroke ids, a text-only selection sends none |
| **M6 gate** | `e2e-server/m6-gate.spec.ts` | handwrite → marquee-select → **Ask AI** (one picture in the request) → "chart the sales numbers" → the chart and a stroke appear, authored by the turn → **the server's picture of the board (ink, chart, stroke) matches the browser's: 0.261% of pixels differ against the 1.5% bar**, and both series' colours are in it → the tutor aligns two selected boxes in one batch → *Undo this response* takes the alignment, then the chart and its line, back, and the handwriting stays |
| Group, resize, snap | `e2e/m6-group.spec.ts` | two drawn rectangles are grouped with Ctrl+G, a click or marquee on one selects both, a drag moves both, a corner handle scales both in one undo, a move snaps to 4 px from another element and Alt leaves it, the group survives a reload and Ctrl+Shift+G ungroups; no console errors |
| Goldens | `packages/core/src/render.test.ts` | ink, ink at zoom 2, and four chart scenes (bar, line and area, pie and donut, scatter) at zoom 1 and 2 against committed PNGs from `@napi-rs/canvas`, tight tolerance; the chart goldens were looked at, not only generated |

**Bench** (`apps/web/src/bench/RESULT.md`, M6 section; headed Chrome, MacBook Air M1 on AC): the ink scene (1,000 shapes and 500 strokes of 100 points) holds **60.0 fps pan and zoom at DPR 1 and 2**. First ink is **16.1 ms p95 at DPR 2 (16.0 at DPR 1) against the 16 ms bar**: all of it the 60 Hz vsync wait, the Editor's own frame is 0.3 ms (the same finding and call as M1 and M2). **Not run:** `chart200` (the scene and its test exist; `pnpm bench` needs a quiet machine), so the 90%-of-`text200` bar and the cache pressure of dense charts are open.

**Found while building (PLAN §19 #55, #56, #58):** `niceTicks` could loop forever on large close-together values (found by the automated security review; fixed and pinned); `checkPatch` checked a path against the first element type that has it; the pen's outline smooths sparse points, so `draw_stroke` fills in between them.

**Not verified:** the live Meta Model API run (ask for a chart on a real book, read the cost footer) and the manual demo (handwrite, select, **Ask AI**, chart).

## Risks

| Risk | Mitigation |
|---|---|
| Text editing on a canvas (IME, selection, RTL) | The doc's `<textarea>` overlay; test Arabic and Latin from M1 |
| Arabic shaping on a server canvas | S1; fallback ladder (browser tab → headless Chromium) |
| Large boards miss the frame budget | S1 measured main-thread cached bitmaps against a worker canvas (the worker was slower); the worker path is **not built** (the renderer is pure, so it could be); the M6 ink scene (1,500 elements) holds 60 fps |
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
