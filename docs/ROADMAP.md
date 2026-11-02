# Roadmap

This roadmap orders work by dependency and gate, not by calendar; no durations are estimated.

> **Hackathon:** Built for the **[Meta AI Developer Hackathon](https://cerebralvalley.ai/e/meta-ai-developer-hackathon)** hosted by **Meta** and **Cerebral Valley**.
> **Status:** 2026-11-02 · K and M0 done; M1 merged to `main` (manual Arabic-keyboard demo and three perf decisions still yours); M2 built on branch `m2-math-images`, gate and demo open; M3 next. The table in §1 and the status log at the end are the live record.
> **What this is:** the execution view of [PLAN.md](./PLAN.md) §17: phases M0–M7 with scope, dependencies, gates, acceptance scripts, risks and status. Aspect details stay in [`plans/`](./plans/); this file links to them instead of restating them.
> **Order and gates mirror PLAN §17.** If they ever differ, §17 wins until both are updated. Everything not in §17 is tagged **[my call]**; override any.
> **Definition of done** for every phase is the one in [testing-spikes](./plans/testing-spikes.md#definition-of-done-per-milestone): gate met, the phase's scripts green, the relevant plan file updated if reality changed, any new decision recorded in PLAN §19.

---

## 1. At a glance

M0–M7 keep the labels used across the docs, oriented toward delivering a working multimodal study companion for the **Meta AI Developer Hackathon**. **Kickoff (K)** comes first.

| Stage        | Phase                      | Headline                                                                | Status |
| ------------ | -------------------------- | ----------------------------------------------------------------------- | ------ |
| 0 Kickoff    | **K** Kickoff              | Approve PLAN rev 2, hand over inputs, write M0's task plan              | ✔      |
| 1 De-risk    | **M0** Spikes              | S1–S5 turn guesses into measurements                                    | ✔      |
| 2 Foundation | **M1** Core editor         | Canvas, shapes, Arabic/Latin text, undo, local save                     | ◐      |
|              | **M2** Math and images     | LaTeX (MathJax), images, camera `flyTo` + pulse                         | ◐      |
|              | **M3** Server              | Sync, SQLite, blobs, access gate, **first VPS deploy**                  | ☐      |
| 3 Tutor      | **M4** Library             | Upload → extract → chunk → embed → hybrid search                        | ☐      |
|              | **M5** Tutor slice         | Chat dock, board context, citations, jump-to-AI: **first usable tutor** | ☐      |
| 4 Complete   | **M6** Ink, charts, polish | Pen, highlighter, eraser, charts, arrange/group/snap                    | ☐      |
|              | **M7** Hardening           | Performance, security review, a11y outline, backup drill, optional MCP  | ☐      |

Status: ☐ not started · ◐ in progress · ✔ done.

---

## 2. Phases

Every **Gate** line is verbatim from PLAN §17. **Scripts** are the named acceptance scripts and test layers in [testing-spikes](./plans/testing-spikes.md). **Risks** come from its risk table, attached to the phase that handles them.

### K · Kickoff

- **Goal:** M0 can start without waiting on anyone.
- **Do:**
  1. Review and approve PLAN rev 2 (its header says "awaiting your review"). **Done 2026-11-01:** taken as approved when you asked to commit and start.
  2. Hand over the three inputs from PLAN §19. **(a)** 2–3 real PDFs (one text-heavy, one math/diagram-heavy, an Arabic one if relevant) plus ~10 questions per book with the page where each answer lives; this is also the retrieval eval set. Say if any book is EPUB (§5, D). **(b)** _Optional, deferred:_ a VPS plan (provider, Debian or Ubuntu LTS, domain or Tailscale). Not needed to build; **the app working locally is the priority.** **(c)** Your OpenRouter key in the server `.env` only, with a credit limit set in OpenRouter.
  3. Write M0's task-level plan (superpowers:writing-plans), PLAN §20 step 3. **Written 2026-11-01:** [2026-11-01-m0-spikes.md](./superpowers/plans/2026-11-01-m0-spikes.md), awaiting your review.
  4. Optional (PLAN §20 step 2): export the Claude Doc to `docs/engine-design.md` and record your five answers in its Open questions.
  5. Commit the docs. **Done 2026-11-01** (`1c6abfb` on `main`; M0 work is on branch `m0-spikes`).
- **Gate:** PLAN rev 2 approved and M0's task plan written. S1 needs nothing, S3 needs the key, S5 (VPS) is optional and deferred. S2 and S4 need the books and can arrive during M0.
- **Risks:** books arrive late → S2 and S4 slip and M4 inherits the risk; S1, S3, S5 still run.
- **Status:** ✔ Books (`spikes/books/`), eval sets (`eval/*.jsonl`) and OpenRouter key provided; VPS deferred.

### M0 · Spikes

- **Goal:** replace every **[spike]** in the plan with a measurement, so M1 onward builds on facts.
- **Builds:** S1–S5 from [testing-spikes](./plans/testing-spikes.md). **S1** canvas performance, plus Arabic and MathJax on a server canvas, plus the leaf-library choice (F12). **S2** extraction rungs R1–R4 on your books. **S3** the OpenRouter loop: tool calling, image in a tool result vs a follow-up message, caching, cost arriving in streaming mode, Arabic quality, `data_collection: "deny"`. **S4** embeddings and exact-search latency. **S5** deploy dry-run on a VPS: _optional, deferred; not a gate for M0 or M3_.
- **Needs:** K (see its gate).
- **Gate (§17):** 5,000 elements @ 60 fps; Arabic server render OK or fallback chosen; extraction default, models and embedding chosen; deploy dry-run (WS + SSE behind basic auth) works.
- **Scripts:** each spike's "Done when" row; the _Engine_ benchmark numbers (also first ink ≤ 16 ms, 20,000-element board opens in < 2 s). **[my call]** Record results as a short line under each spike in testing-spikes.md and each decision in PLAN §19.
- **Decisions closed:** render path (main thread vs worker) and snapshot path; Arabic font; `rbush` and `perfect-freehand` vs in-house; extraction default per book type and page-routing thresholds; tutor, cheap and vision models and the snapshot-adapter behaviour; embedding model, `k`, `EMBED_DIMS` (or `sqlite-vec` scheduled); access gate (basic auth vs Tailscale or cookie); keep or drop the `web` process (Next.js vs static export or Vite SPA).
- **Risks:** Arabic shaping on a server canvas (S1; ladder: server canvas → open tab → headless Chromium); large boards miss the frame budget (S1; worker-canvas path); PDF math and Arabic extraction (S2); cost surprise (S3 replaces the estimates with measured cost per turn); model and AI SDK churn (S3); basic auth + WebSocket (S5; Tailscale or signed cookie).
- **Demo:** measured numbers, and (S5 only if a VPS exists) a hello-world NestJS (WebSocket + SSE) and Next behind Caddy on the VPS.
- **Replan:** revisit the scope and order of every later phase now (§17); see §6.
- **Status:** ✔ S1, S2, S3, S4a and S4b done and recorded in [testing-spikes](./plans/testing-spikes.md#m0-results) and [PLAN.md](./PLAN.md) §19 #29 (S5 deferred; S2 numeric density cut-off tuned in M4a).

### M1 · Core editor

- **Goal:** a person can draw and write on a fast infinite canvas, undo, and lose nothing on reload.
- **Builds:** `packages/core` (zod schemas, scene store, ops, undo, bounds, R-tree) · renderer + camera (two canvases, dirty-flag frame loop, zoom 0.05–20) · select/transform · shapes + bound arrows · text with RTL (`<textarea>` overlay) · local save (IndexedDB). → [whiteboard-engine](./plans/whiteboard-engine.md), [tech-stack](./plans/tech-stack.md).
- **Needs:** M0 decisions (render path, font, leaf libraries).
- **Gate (§17):** Shapes, Arabic + Latin text, undo, local save.
- **Scripts:** _Engine_ (Arabic and Latin text editing with an IME; golden images for shapes and text); core property test (apply then inverse = identity; conflict rules).
- **Also here [my call]:** repo scaffold from tech-stack ("scaffold in M0/M1, then pin"), Biome, Vitest and CI (`lint`, `test`), since this is the first code that is kept (M0 spike code is throwaway). Specify group-resize semantics and rotated hit-testing (F13).
- **Risks:** text editing on a canvas (IME, selection, RTL): test Arabic and Latin from the first text tool.
- **Demo:** draw a diagram with bound arrows, type Arabic and Latin text, undo, reload and it is still there.
- **Status:** ◐ Implemented on branch `m1-core` (not merged to `main`). The gate script `e2e/gate.spec.ts` is green, with `pnpm lint`, `pnpm test`, `pnpm e2e` and `pnpm build`. Remaining: the manual demo with a real Arabic keyboard (IME), your decisions on the three perf points in the status log, then the merge. Group resize is not built (M6, see [whiteboard-engine](./plans/whiteboard-engine.md#open-items)).

### M2 · Math and images

- **Goal:** equations and pictures look right at every zoom, and the camera can fly somewhere on request (the primitive Jump-to-AI needs).
- **Builds:** `renderMath()` (MathJax v4, TeX → SVG → cached bitmap) + live LaTeX box · image element (upload, crops, zoom-bucket caches) · camera `flyTo` + pulse. → [math-renderer](./plans/math-renderer.md), [whiteboard-engine](./plans/whiteboard-engine.md).
- **Needs:** M1.
- **Gate (§17):** Math and images crisp at every zoom; math security tests pass.
- **Scripts:** the six hostile-LaTeX payloads (`\href`, `\url`, `\require`, `\class`, `\style`, `\unicode`) render as errors, never a link or a load; error tests (unbalanced braces, unknown macro); ~20 golden equations, Node adapter vs browser; 200 math elements stay at 60 fps after first render.
- **Also here [my call] (seam 6):** image bytes live in IndexedDB, keyed by content hash, until `/api/blobs` exists in M3.
- **Decisions closed:** Arabic inside `\text{}` supported, or restricted to Latin and documented (F14).
- **Risks:** text-mode content outside MathJax's font data may depend on fonts again (F14).
- **Demo:** type LaTeX and see it live, drop an image, zoom from 0.05 to 20: both stay crisp.
- **Task plan:** [2026-11-02-m2-math-images.md](./superpowers/plans/2026-11-02-m2-math-images.md) (12 tasks, decisions in PLAN §19 #23–28). **Decided in the M2 grill:** `packages/math` (not `core/math`), async `renderMath` + sync `peekMath`, Arabic in math is an error (F14 closed), device-sized `RenderCache`, image import limits (SVG rejected), non-destructive crop, `flyTo` + `pulse` as view state, relative perf bar (200 math ≥ 90% of 200 text).
- **Status:** ◐ Built on branch `m2-math-images` (M1 is merged into it). Tasks 1 to 12 are done and their gate is green: lint, typecheck, unit tests (core 142, math 20, web 273), e2e 15/15 including the math security and parity (≤ 1.5% against the Node goldens), crispness (zoom 0.05 to 20) and the M2 gate script (`e2e/m2-gate.spec.ts`), and a production build with MathJax in lazy chunks only. Bench ([RESULT.md](../apps/web/src/bench/RESULT.md)): 200 equations hold 60 fps, equal to 200 texts, at both DPRs. **Open, yours:** the manual demo (type LaTeX, drop an image, crop, zoom 0.05 to 20, reload) and two `needs-user-decision` items: the `RenderCache` cap (a dense 5,000-text scene at DPR 2 zooms at 1.6 fps under the 491.5 MB cap, 35 fps under M1's 1 GiB) and open-20k at DPR 1 (+15.5% against M1, bar +10%). Not built, noted in the validation: a *Reset crop* button, the `image.source` field (M4b/M5).

### M3 · Server

- **Goal:** the board lives on a server, survives restarts, syncs between tabs, and runs locally. VPS deploy is optional and later.
- **Builds:** WebSocket gateway · Board service (validate → seq → apply → store → broadcast) · SQLite op log + snapshots + migrations (`0001_init`) · blobs on disk · snapshot renderer (core `render()` on `@napi-rs/canvas`) · access gate + Origin checks · systemd + Caddy deploy scripts · deploy scripts (written, run on a VPS only when one exists). → [deployment](./plans/deployment.md), [database](./plans/database.md), [api](./plans/api.md), [auth-security](./plans/auth-security.md).
- **Needs:** M1 and M2 (store, ops and validation; `render()` and math for the server picture); the S1 decision (S5 only if run). An off-box backup remote for `rclone` (§5, C).
- **Gate (§17):** Two tabs stay in sync; survives restart; the gate works locally (shared secret, Origin checks); server PNG matches browser.
- **Scripts:** _Deployment_ (local `pnpm dev` works; VPS checks run only if a VPS exists); _Security_ (foreign Origin rejected on WebSocket and POST); WebSocket ordering test (two clients, interleaved batches, identical final scene); migration test on a copy of a DB.
- **Also here [my call]:** `deploy.sh`, `backup.sh` and the backup timer ship with the first deploy so data is protected from day one (deployment.md VPS step 8); the restore drill stays in M7. `board_ops` carries `turn_id`, `label`, `bounds` and `touched_ids` from `0001_init`, and the Board service fills `bounds` for every batch, so M5's Locate needs no backfill.
- **Risks:** basic auth + WebSocket misbehaves (S5 fallback: Tailscale or signed cookie); Arabic shaping on the server canvas (S1 ladder). If S1 picked a snapshot fallback, rescope the last gate clause (§6).
- **Demo:** two browser tabs editing one board on localhost; restart the server and the board is still there.
- **Status:** ☐

### M4 · Library

- **Goal:** a real book becomes searchable pages with citations.
- **Builds (§17):** upload, estimate/preview, extraction ladder (R1–R4, per-page routing), structure (PDF outline + printed page labels), chunks, embeddings, summaries, hybrid search API (FTS5 + exact vectors → reciprocal-rank fusion), library UI, source panel, eval runner. → [library-ingestion](./plans/library-ingestion.md), [rag-context-engineering](./plans/rag-context-engineering.md), [database](./plans/database.md).
- **Split [my call] (seams 4, 5):** **4a** ingestion core: worker thread, `pnpm ingest`, `book_*` tables + FTS5, embeddings, summaries, search function, `pnpm eval:retrieval`. Needs only M3's persistence layer (`db/` module, migrations, blob store). **4b** REST endpoints, library UI (dropzone, book cards, outline, scope picker, **Study this**) and the source page viewer (`pdfjs-dist`) shown on the Book page. Needs M3's server and the web shell. The viewer becomes the chat dock's Source tab in M5.
- **Also here (seam 1):** `spend` ledger and daily-cap check, so a paid rung never starts past `DAILY_BUDGET_USD`; the estimate is shown before any paid rung.
- **Needs:** M0 (S2, S4 results); M3 (see the split).
- **Gate (§17):** Retrieval eval target met on a real book.
- **Scripts:** _Library_: ingest one real book per type; `pnpm eval:retrieval` meets the target (expected page in the top 8 for ≥ 80%); the preview/estimate flow is cancelable before any paid rung. Also: resumability (kill mid-run, re-run), no chunk crossing an equation, page-label mapping, section counts, SQLite write-contention load test.
- **Decisions closed:** if the eval misses, the documented ladder is neighbours → `qwen3-embedding-8b` → chunk context → reranker; `sqlite-vec` if search latency demands it (S4).
- **Risks:** PDF math and Arabic extraction (ladder, per-page routing, preview before indexing); wrong-page retrieval (hybrid search, heading-path embedding, eval gate); SQLite write contention (worker thread, short transactions, `busy_timeout`); slow large-book ingestion (queue, progress, resumable steps); cost (estimates + ledger).
- **Demo:** upload a real book, watch progress, browse the outline, search it (right page in the top 8), open the cited page in the viewer.
- **Status:** ☐

### M5 · Tutor slice

- **Goal:** the whole product loop works: ask, the tutor explains on the board with citations, point, locate, undo.
- **Builds (§17):** chat dock ([chat-ui](./plans/chat-ui.md)) · board-context builder + chips + browser-side pictures ([board-context](./plans/board-context.md)) · agent loop + tool registry ([ai-integration](./plans/ai-integration.md)) · prompts + scope packs + caching + citations ([rag-context-engineering](./plans/rag-context-engineering.md)) · placement · `add_diagram` · `add_book_figure` · jump-to-AI ([jump-to-ai](./plans/jump-to-ai.md)) · turn undo · budgets · stub tutor.
- **Registry [my call] (seam 3):** 15 of the 18 tools; `add_chart`, `draw_stroke` and `arrange` register in M6 with their elements.
- **Also here [my call]:** the Source tab, mounting M4's viewer (seam 5); per-turn caps (`MAX_STEPS`, `MAX_TURN_COST_USD`, 120 s), the usage view and top-bar spend on top of M4's ledger (seam 1); `messages` and `settings` (student profile); Activity tab, Follow AI, hover tag on AI elements and **Ask AI** in the selection toolbar.
- **Needs:** M1 (`render()` for browser-side pictures), M2 (`flyTo` + pulse, images), M3 (Board service, WebSocket, snapshot render), M4 (search, summaries, viewer).
- **Gate (§17):** End-to-end script in testing-spikes passes.
- **Scripts:** _Tutor end-to-end_ (the gate: upload → index → chapter-scope board → question → text, math and shape with `[p. N]` citations → citation opens the Source tab → Stop leaves a consistent board → _Undo this response_); _Board context_ (R3) except its handwriting step (seam 2); _In-app chat_ (R2: Arabic composer, history after reload); _Jump to AI_ (Follow off and on, past, after reload, after deletion, after a move, deep links); _Caching and cost_ (turn 2 `cached_tokens > 0` when supported; `MAX_STEPS=2` or `MAX_TURN_COST_USD=0.01` stops a runaway loop; `spend` matches token-based model pricing within rounding); _Security_ (injection seed text ignored; no keys in the bundle, logs or DB); one live Meta Model API run of the M5 script, reading the cost footer.
- **Decisions closed:** the whole-book cached-prompt experiment (default off); `useChat` transport sending only the new message ("verify in M5"); the Ask AI keyboard shortcut (none until M5).
- **Risks:** AI clutters the board (element budget, titled clusters, `placement: auto`, _Undo this response_; `arrange` arrives in M6); prompt injection (delimited data, edit-rights guard, validated citations, seeded test); cost surprise (caps, usage view, credit limit on the key); model and AI SDK churn (models in env, fallback model, one adapter module).
- **Demo:** the product. Chat, a board explanation with citations, select and ask, jump to the AI's work, undo the response, cost footer visible. **First usable tutor.**
- **Status:** ☐

### M6 · Ink, charts, polish

- **Goal:** the student can handwrite and the AI can chart.
- **Builds (§17):** pen, highlighter, eraser (Pointer Events, coalesced events, palm rejection) · charts (bar, line, area, pie, donut, scatter) + data grid · `arrange` · group · snap. → [whiteboard-engine](./plans/whiteboard-engine.md), [ai-integration](./plans/ai-integration.md).
- **Registry (seam 3):** add `add_chart`, `draw_stroke`, `arrange` (18 of 18).
- **Needs:** M1 (tool contract, R-tree), M3 (sync); the registry additions and the handwriting script need M5. The pen alone could move earlier (§5, A).
- **Gate (§17):** Student can handwrite; AI can chart.
- **Scripts:** _Board context_ handwriting step (seam 2): select 3 elements including one stroke, the chip reads "3 · structure + picture (auto)", the request carries one image; handwriting auto-attaches a picture and a text-only selection does not. Golden images for strokes and charts, browser vs server. First ink within one frame.
- **Risks:** freehand on large boards misses the frame budget (S1's worker-canvas path is ready).
- **Demo:** handwrite a note, select it, **Ask AI**, and it reads the picture; ask for a chart and a data-driven chart appears.
- **Status:** ☐

### M7 · Hardening

- **Goal:** v1 is fast, safe and recoverable.
- **Builds (§17):** performance pass · security review · accessibility outline panel · backup restore drill · optional MCP adapter (`/mcp`, tokens). → [auth-security](./plans/auth-security.md), [deployment](./plans/deployment.md), [ai-integration](./plans/ai-integration.md).
- **Needs:** everything above; the MCP adapter needs the complete registry from M6.
- **Gate (§17):** Benchmarks + checklist pass.
- **Scripts:** _Security_, full pass of auth-security.md (Origin, uploads, LaTeX and injection tests; try to reach `:3000` and `:4000` from outside; `grep` the build, logs and DB for the key). _Deployment_: the backup restores onto a clean directory (stop both units → replace `whiteboard.db` → restore `blobs/` → start → open an old board and a book). _Engine_: benchmark re-run (60 fps at 5,000 visible elements; 20,000-element board opens in < 2 s).
- **Decisions closed:** build the optional MCP adapter now or leave it for after v1 (not on the v1 critical path).
- **Risks:** prompt injection (final review against the seeded tests); large boards (performance pass).
- **Demo:** benchmark table, security checklist ticked, a restored backup.
- **Status:** ☐

---

## 3. Dependencies

| Phase | Needs                                                                         | Can start early                                                                       |
| ----- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| K     | –                                                                             | –                                                                                     |
| M0    | K                                                                             | S1, S3, S5 before the books arrive                                                    |
| M1    | M0 decisions                                                                  | –                                                                                     |
| M2    | M1                                                                            | –                                                                                     |
| M3    | M1, M2; S1 and S5 decisions                                                   | Its persistence layer (`db/` module, migrations, blob store) has no canvas dependency |
| M4    | **4a:** M0 (S2, S4) + M3's persistence layer. **4b:** M3's server + web shell | 4a can overlap M1–M3 (§5, B)                                                          |
| M5    | M1, M2, M3, M4                                                                | –                                                                                     |
| M6    | M1, M3; registry additions and handwriting script need M5                     | The pen could move earlier (§5, A)                                                    |
| M7    | All of the above                                                              | –                                                                                     |

```
Default (single track)
  K ─▶ M0 ─▶ M1 ─▶ M2 ─▶ M3 ─▶ M4a ─▶ M4b ─▶ M5 ─▶ M6 ─▶ M7

Optional overlap (§5, B): needs two parallel tracks of work
  Track 1   M0 ─▶ M1 ─▶ M2 ─▶ M3 (sync, gate, deploy) ─▶ M4b ─▶ M5 ─▶ M6 ─▶ M7
  Track 2   M0 ─▶ M3 persistence layer ─▶ M4a ───────────────┘
```

---

## 4. Seams between §17 and the plan files, and how this roadmap resolves them

Found while reading all 16 docs against §17. Resolutions are **[my call]**; override any. They are appended to PLAN §19 as decisions 17–22: seams 1, 2, 3 → 17, 18, 19; seams 4 and 5 → 20; seam 6 → 21; 22 records that this file holds the detail while §17 stays the contract.

| #   | Seam                                                                                                                                                                                                                           | Resolution                                                                                                                                                                                                  |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Paid ingestion rungs must respect the daily cap ([auth-security](./plans/auth-security.md) Budgets, [library-ingestion](./plans/library-ingestion.md) flow step 3), but the `spend` ledger and caps are not in M4's build list | `spend` table and daily-cap check ship in M4; per-turn caps, usage view and top-bar spend in M5                                                                                                             |
| 2   | The _Board context_ script selects "one handwritten stroke", but the pen lands in M6                                                                                                                                           | That step and the freehand auto-picture rule are verified at M6; the M5 gate runs the script with text and shape selections                                                                                 |
| 3   | "18 tools" at M5 includes `add_chart`, `draw_stroke`, `arrange`, whose elements and tools land in M6                                                                                                                           | M5 registers 15; M6 adds 3 (the registry is data-driven, so no rework)                                                                                                                                      |
| 4   | §17 says "M4 does not depend on M1–M3". True for the ingestion core, not for REST and UI: ingestion writes SQLite and blobs, the UI needs the server                                                                           | Split M4: **4a** ingestion core, `pnpm ingest`, eval runner (needs only M3's persistence layer); **4b** REST, library UI, source viewer (needs M3's server and the web shell). Default order: both after M3 |
| 5   | The source panel is an M4 deliverable but a tab of the M5 chat dock                                                                                                                                                            | M4 builds the page viewer on the Book page; M5 mounts it as the dock's Source tab                                                                                                                           |
| 6   | Where M2 image bytes live before `/api/blobs` (M3) exists is unspecified; M1 has IndexedDB local save                                                                                                                          | IndexedDB keyed by content hash (the scheme `blobs.id` uses); M3 swaps the backend. M1–M2 local boards are throwaway, no import path                                                                        |

---

## 5. Decision points

Defaults are what this roadmap assumes. Override any before the phase named.

| #   | Decision                                                                                                       | Default                             | Alternative and cost                                                                                                                                       | Decide by                      |
| --- | -------------------------------------------------------------------------------------------------------------- | ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| A   | When does handwriting land?                                                                                    | **M6**, tutor first (PLAN §19 #7)   | Swap the pen half of M6 into M1: handwriting exists from M1 on and seam 2 disappears. That half of M6 moves ahead of the tutor                             | Before M1 starts               |
| B   | One track or two?                                                                                              | **Single track**, M0 to M7 in order | Overlap 4a with M1–M3, so the library is ready when the tutor slice starts (§17). Needs two parallel tracks of work and M3's persistence layer built first | After M0                       |
| C   | Off-box backup target for `rclone` ([deployment](./plans/deployment.md) Backups). Not among the Kickoff inputs | **Open**                            | Any remote `rclone` supports                                                                                                                               | Before M3's first deploy       |
| D   | EPUB in v1?                                                                                                    | **No, PDF only** (PLAN §19 #14)     | If a book is EPUB, EPUB moves into M4 ([library-ingestion](./plans/library-ingestion.md))                                                                  | Kickoff, when the books arrive |
| E   | MCP adapter                                                                                                    | **Optional, in M7** (PLAN §19 #5)   | Leave it for after v1                                                                                                                                      | M7                             |

---

## 6. Replan checkpoints

| After              | Why                                                                 | Do                                                                                                                                                                                                                                                           |
| ------------------ | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **M0** (mandatory) | S1–S5 replace guesses with measurements (§17: replan after M0)      | Revisit the scope and order of M1–M7; record decisions in PLAN §19; revisit B. If S1 picks a snapshot fallback (open tab or headless Chromium) instead of the server canvas, rescope M3's last gate clause, "server PNG matches browser", to the chosen path |
| M3                 | First server, sync and (if a VPS exists) deploy working in practice | Confirm the gate choice in practice; check that the scope and order of M4–M7 still hold                                                                                                                                                                      |
| M5                 | First usable tutor: the product exists                              | Use it on a real book; re-decide M6 against v1.1 priorities (pen, charts, quizzes) before starting M6                                                                                                                                                        |

---

## 7. After v1

Gathered from the docs; none of it is scheduled. Non-goals stay in PLAN §2.3.

**v1.1 (designed-for)**

- EPUB, Markdown, TXT (nullable page fields and `cite_label` already in the schema), [library-ingestion](./plans/library-ingestion.md)
- Quizzes, flashcards, spaced repetition (the tutor can already "quiz me" in chat), PLAN §2.3
- Per-cluster selection crops (up to 4); board "regions" summaries if drill-down proves clumsy, [board-context](./plans/board-context.md)
- Auto-updating learning notes, [rag-context-engineering](./plans/rag-context-engineering.md)
- In-page highlighting in the Source tab, [library-ingestion](./plans/library-ingestion.md)
- MathJax assistive MathML and speech, [math-renderer](./plans/math-renderer.md)
- Arabic UI (v1 uses CSS logical properties, so it is a translation task), [chat-ui](./plans/chat-ui.md)
- LLM-written chunk context, reranker, English stemming: only if the eval demands

**Later (designed-for, not built)**

- Share links (`board_shares`, read-only role) and accounts (`owner_id`, sessions), [auth-security](./plans/auth-security.md)
- MCP bearer tokens and OAuth 2.1 beyond the optional M7 adapter, [ai-integration](./plans/ai-integration.md)
- `sqlite-vec` (search past ~100 ms or ~200k chunks) and the Postgres + pgvector revert path, [database](./plans/database.md)
- Yjs for text only; worker canvas and WebGL only if S1 misses, [whiteboard-engine](./plans/whiteboard-engine.md)
- Blob garbage collection (when `blobs/` passes ~5 GB), [deployment](./plans/deployment.md)
- Voice input, message editing and branching, multiple threads per board, streaming reasoning traces, [chat-ui](./plans/chat-ui.md)

---

## 8. Status log

| Date       | Phase | Note                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ---------- | ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-11-01 | –     | Roadmap drafted from PLAN rev 2 and the 14 aspect files. Nothing started.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 2026-11-02 | K     | S1 and S4a done and merged to `main`. Decision: **VPS is not a must-have**; S5 and the first VPS deploy are optional and deferred, a working local app is the priority. Remaining M0 inputs: OpenRouter key (S3), books (S2, S4b).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| 2026-11-01 | K     | Docs committed (`1c6abfb`). PLAN rev 2 taken as approved. M0 task plan written, awaiting review. Open inputs: OpenRouter key (S3), VPS (S5), books and questions (S2, S4b); S1 and S4a need none.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 2026-11-02 | M1    | Implemented on `m1-core`: core (schemas, ops, undo, geometry, `render()`), editor (select, shapes with bound arrows, text with RTL, hand, toolbar), IndexedDB autosave with a read-only second tab. Gate script `e2e/gate.spec.ts` (real pointer and keyboard input: two shapes and a bound arrow, Arabic and Latin text, move with the arrow following, undo twice and redo once, reload, second tab read-only, no console errors) green; `pnpm lint`, `pnpm test` (core 115, web 193 and 1 skipped) and `pnpm e2e` (11) exit 0 (counts as of the review fixes in the last row of this log); `pnpm build` exited 0 before those fixes. Left open: the manual demo with a real Arabic keyboard, then merge after your OK.                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 2026-11-02 | M1    | Perf (Task 12, `pnpm bench`, 5,000 elements, medians of 5, real renderer against S1; full numbers in `apps/web/src/bench/RESULT.md`). DPR 2: pan 45.1 fps (S1 46.5, pass), zoom 35.4 (S1 40.7, **miss** at 87%, bar 36.6), first ink p95 16.5 ms (S1 0.9), open 20,000 in 1,798 ms (S1 1,412). DPR 1: pan 43.1 and zoom 44.7 (both pass), first ink 15.4 ms, open 20,000 in 1,750 ms. No variant reaches 60 fps (S1 did not either). Open 20,000 is **borderline, not a clean pass**: 1.75 to 1.80 s on a warm page, but 2.27 s when it replaces a populated 20,000 scene; a cold page load of a saved 20,000 board was not timed. Three needs-user-decision lines, none decided: (1) DPR 2 zoom is 87% of S1, 1.2 fps under the 90% bar (accept for M1, finer text buckets, or schedule the worker-canvas or WebGL rung); (2) the 1 GiB `RenderCache` cap (at 20,000 elements and DPR 2 the cache sits at the cap and zoom falls to 0.5 fps, pan 9.8 fps; see RESULT.md) (742 MB held at DPR 2; too much for 8 GB laptops and iOS Safari; keep, set it from the device, or use a glyph atlas); (3) the first-ink definition (the 16.5 ms is the 60 Hz vsync wait; the Editor's own work is 0.1 ms). |
| 2026-11-02 | M1    | Final-review fixes (Task 15) on `m1-core`. Text typed in an open textarea is now autosaved (the draft is in the saved snapshot, not in the scene or the undo history), so a reload or tab close no longer loses it; page cleanup commits an open edit before the last flush; dropped elements and undo entries are backed up before anything is saved over them, and stored undo entries are validated; blocked saving now says plainly that changes are NOT saved (with Retry or Reload); a selected text keeps only the rotate handle; shortcuts work on an Arabic keyboard layout (`e.code` fallback); `resolveDir` agrees with the textarea; CI builds the app. `pnpm lint`, `pnpm typecheck`, `pnpm test` (core 115, web 193 and 1 skipped) and `pnpm e2e` (11) exit 0; `pnpm build` was not run locally this round (CI runs it now). Still pending: the manual demo with a real Arabic keyboard (IME), your decisions on the three perf points above, and the merge.                                                                                                                                                                                                                           |
| 2026-11-02 | M2    | Grilled and planned on branch `m2-math-images` (stacked on `m1-core`): [task plan](./superpowers/plans/2026-11-02-m2-math-images.md), 12 tasks, decisions in PLAN §19 #23–28. No code yet. Open for review: dropping `noundefined` (P1), invalid LaTeX committing as red source (P3), the Path2D vector rung (P6), originals not kept for downscaled images. M1 items still open: IME demo, the perf decisions (the RenderCache cap is now decided inside M2), merge.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 2026-11-02 | M0    | S4b embeddings & recall (`spikes/s4-search/recall.ts`, `eval/{ck12,alg1,arabic}.jsonl`) completed and M0 wrapped up (PLAN §19 #29, [testing-spikes](./plans/testing-spikes.md#m0-results)). `baai/bge-m3` (`1024-d`, `k = 8`, `$0.0058` across all 3 books) hits `100%` vector@8 (`MRR 0.947`), `93.3%` hybrid@8 (`100%` `ck12`, `100%` `alg1`, `80%` `arabic`), and `96.7%` (`90%` `arabic`) with `±1` chunk neighbours, passing the ≥ 80% target and keeping exact in-memory vector search within S4a's `512 MiB` / `100 ms` budget. |
| 2026-11-02 | Plan  | Switched active AI provider from OpenRouter to **Meta Model API** (`META_API_KEY`, `META_API_BASE_URL=https://api.llama.com/compat/v1` via `@ai-sdk/openai-compatible`) for all LLM and vision roles (`Llama-4-Maverick-17B-128E-Instruct-FP8` for tutor EN/AR, vision & reviewer; `Llama-4-Scout-17B-16E-Instruct-FP8` / `Llama-3.3-70B-Instruct` for cheap & fallback; `Llama-3.2-Vision` also supported), while keeping `OPENROUTER_API_KEY` strictly for `baai/bge-m3` embeddings and preserving M0 S2–S4 benchmarked model results across the docs (PLAN §19 #30). |
| 2026-11-02 | M2    | Finished on `m2-math-images`: the image bucket-copy lookup now precedes the original (C1: two photos at the cache cap re-decoded forever; regression test), bench scenes `math200`/`text200`/`images50`/`mixed5000` added and run (5 runs, headed Chrome, AC power), gate script `e2e/m2-gate.spec.ts` (LaTeX with live preview, invalid and hostile LaTeX, image drop, crop, zoom sweep, reload, undo/redo, second tab, `flyTo`) green, README and engine doc corrected. Bench: `math200` = `text200` = 60 fps at DPR 1 and 2. Open for you: the manual demo, the cache cap (needs-user-decision), open-20k at DPR 1 (+15.5%). M3 planned: [task plan](./superpowers/plans/2026-11-02-m3-server.md), 11 tasks, rulings R1 to R10 listed first (no NestJS, local mode stays). |
