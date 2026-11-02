# Spikes, tests and verification

> Part of [PLAN.md](../PLAN.md) §18 · Related: [whiteboard-engine](./whiteboard-engine.md) · [library-ingestion](./library-ingestion.md) · [rag-context-engineering](./rag-context-engineering.md) · [ai-integration](./ai-integration.md) · [deployment](./deployment.md)

What I could not verify while planning, how M0 settles it, and how we know each part works afterwards.

## M0 spikes (2 weeks)

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
- **S2 Ingestion** (`spikes/s2-ingestion/RESULT.md`): R1 (`pdfjs-dist`, 1.9–8.9 ms/page) for text PDFs (`ck12`, `alg1`, `alg2`); R2 (`cloudflare-ai`) dropped (no LaTeX, empty on scans, 2.1–5.5 MB file-size cap); R3 (`mistral-ocr`, `$0.0205` / 10 pages, returns one `text` element per page in `annotations[0].file.content` between `<file>` and `</file>`) for scanned/Arabic/math-dense pages; R4 (`gemini-3.8-flash` on 130 dpi PNGs) fallback. Slice with `pdf-lib` `copyPages` (never `pdfseparate`), and strip `\x00–\x1F` / PUA `\uE000–\uF8FF` from `pdfjs-dist` text.
- **S3 OpenRouter loop** (`spikes/s3-openrouter/RESULT.md`): `providerMetadata.openrouter.usage.cost` arrives on every streamed step across all 4 tested models; AI SDK 7 requires system prompt in `instructions`; `tool-result-image` (`toModelOutput` with `file` part) works on all 4 models; 1 h prompt cache hits on turn 2 (`17,433` cached tokens); `data_collection: "deny"` routes cleanly. Models chosen: `google/gemini-3.8-flash` (Arabic tutor), `anthropic/claude-haiku-5.5` (English tutor + `cheap`), `anthropic/claude-sonnet-5.5` (optional reviewer); Meta Llama configuration also documented for hackathon mode.
- **S4 Embeddings and search** (`spikes/s4-search/RESULT.md`): **S4a** exact 1024-d cosine scan p95 `0.51` ms at `N=600`, `8.33` ms at `N=10k`, `83.6` ms and `390.6` MiB at `N=100k` (cold-start load from SQLite `236–351` ms). **S4b** across 3 books (`ck12` 718 chunks, `alg1` 751 chunks, `arabic` 40 R3-OCR chunks, 30 questions in `eval/*.jsonl`): `baai/bge-m3` (`1024-d`, `$0.0058`) hits `100%` vector@8 (`MRR 0.947`), `93.3%` hybrid@8 (`MRR 0.747`; `100%` `ck12`, `100%` `alg1`, `80%` `arabic`), and `96.7%` (`MRR 0.838`; `90%` `arabic`) with `±1` chunk neighbours. Decisions: `vectorSearch: exact`, `embedModel: baai/bge-m3`, `EMBED_DIMS: 1024`, `k: 8`, retry `429`/`5xx` with backoff.
- **S5 Deploy dry-run**: deferred (VPS is optional; local app is the priority).

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
| Live tutor | Manual, once per milestone | One real OpenRouter run of the M5 script; read the cost footer |

CI (GitHub Actions or local script): `pnpm/action-setup`, `pnpm install --frozen-lockfile`, `pnpm lint`, `pnpm typecheck`, `pnpm test`. `pnpm e2e` (the M1 gate included) runs locally, not in CI yet: it needs a dev server because `window.__editor` is dev-only.

## Acceptance scripts

**Tutor end-to-end (M5 gate).** Upload a PDF → index → create a board with a chapter scope → type a question → text + math + shape appear on the board with `[p. N]` citations → clicking a citation opens the page in the Source tab → Stop mid-turn leaves a consistent board → *Undo this response* removes it.

**Board context (R3).** Select 3 elements (one handwritten stroke) → the Selection chip shows "3 · structure + picture (auto)" → "What the AI sees" lists those ids and a thumbnail → send → the recorded model request contains the digest with those ids and one image → ask "make this red" → only the selected elements change → ask it to edit an unselected human element → rejected with a clear reply. Then attach Viewport and Whole board and confirm payload sizes stay within the digest budget.

**In-app chat (R2).** Everything above runs from the dock with no other tool; reload restores the history; the composer works with Arabic input (`dir="auto"`).

**Jump to AI.** Scenarios in [jump-to-ai](./jump-to-ai.md): live (Follow off and on), past, after reload, after deletion, after moving an element, deep links.

**Caching and cost.** Turn 2 shows `cached_tokens > 0`; `MAX_STEPS=2` or `MAX_TURN_COST_USD=0.01` stops a runaway loop with a clear message; the `spend` ledger matches the OpenRouter activity page within rounding.

**Library.** Ingest one real book per type; `pnpm eval:retrieval` meets the target (expected page in the top 8 for ≥ 80% **[my call]**); the preview/estimate flow is cancelable before any paid rung.

**Security.** Origin rejection for a foreign Origin on WebSocket and POST; LaTeX payloads inert; injection seed text ignored ([auth-security](./auth-security.md)); no key in the web bundle, logs or DB.

**Deployment.** `pnpm dev` works on this machine with only Node and pnpm; the VPS serves only through the gate; the services survive a reboot; the backup restores onto a clean directory ([deployment](./deployment.md)).

**Engine.** The M0 benchmark; golden-image tests; Arabic and Latin text editing with an IME.

**Engine acceptance script (M1 gate).** `e2e/gate.spec.ts`, run by `pnpm e2e` (locally; not in CI yet): with real pointer and keyboard input (the dev-only `window.__editor` is read for assertions only) it draws two shapes and a bound arrow, types Arabic and Latin text, moves a shape and checks the arrow's end follows, undoes twice and redoes once (toolbar and shortcut), waits for autosave by polling IndexedDB, reloads and checks the scene (count, text, binding ids) and that undo still works, opens a second tab and checks the read-only banner, and fails on any console error. A synthetic IME composition is covered in `e2e/text.spec.ts`; a real Arabic keyboard is the manual demo. The performance bench is `pnpm bench` (it builds the app, so stop any `next dev` first; headed Google Chrome on `:3100`; not part of CI) and writes its numbers to `apps/web/src/bench/RESULT.md`.

## Definition of done per milestone

Gate in [PLAN.md](../PLAN.md) §17 met, tests for the milestone's scripts green, the relevant plan file updated if reality changed, and any new decision recorded in PLAN.md §19.
