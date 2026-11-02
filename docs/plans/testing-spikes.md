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

CI (GitHub Actions or local script): `pnpm/action-setup`, `pnpm install --frozen-lockfile`, `pnpm lint`, `pnpm test`, `pnpm e2e`.

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

## Definition of done per milestone

Gate in [PLAN.md](../PLAN.md) §17 met, tests for the milestone's scripts green, the relevant plan file updated if reality changed, and any new decision recorded in PLAN.md §19.
