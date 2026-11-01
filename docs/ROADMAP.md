# Roadmap

> **Status:** draft 1 · 2026-11-01 · nothing started; Kickoff is open.
> **What this is:** the execution view of [PLAN.md](./PLAN.md) §17: phases M0–M7 with scope, dependencies, gates, acceptance scripts, risks and status. Aspect details stay in [`plans/`](./plans/); this file links to them instead of restating them.
> **Weeks and gates mirror PLAN §17.** If they ever differ, §17 wins until both are updated. Everything not in §17 is tagged **[my call]**; override any.
> **Time** is full-time-engineer weeks, ±30%, **re-estimated after M0**. There are no dates here on purpose (conversion row in §1).
> **Definition of done** for every phase is the one in [testing-spikes](./plans/testing-spikes.md#definition-of-done-per-milestone): gate met, the phase's scripts green, the relevant plan file updated if reality changed, any new decision recorded in PLAN §19.

---

## 1. At a glance

M0–M7 keep the labels used across the docs. **Kickoff (K)** comes first and is not in the 19.5 weeks.

| Stage | Phase | Wks | Ends wk | Headline | Status |
|---|---|---|---|---|---|
| 0 Kickoff | **K** Kickoff | – | – | Approve PLAN rev 2, hand over inputs, write M0's task plan | ☐ |
| 1 De-risk | **M0** Spikes | 2 | 2 | S1–S5 turn guesses into measurements | ☐ |
| 2 Foundation | **M1** Core editor | 2.5 | 4.5 | Canvas, shapes, Arabic/Latin text, undo, local save | ☐ |
| | **M2** Math and images | 1.5 | 6 | LaTeX (MathJax), images, camera `flyTo` + pulse | ☐ |
| | **M3** Server | 2.5 | 8.5 | Sync, SQLite, blobs, access gate, **first VPS deploy** | ☐ |
| 3 Tutor | **M4** Library | 2.5 | 11 | Upload → extract → chunk → embed → hybrid search | ☐ |
| | **M5** Tutor slice | 4 | **15** | Chat dock, board context, citations, jump-to-AI: **first usable tutor** | ☐ |
| 4 Complete | **M6** Ink, charts, polish | 2.5 | 17.5 | Pen, highlighter, eraser, charts, arrange/group/snap | ☐ |
| | **M7** Hardening | 2 | 19.5 | Performance, security review, a11y outline, backup drill, optional MCP | ☐ |

Status: ☐ not started · ◐ in progress · ✔ done.

**Effort to calendar (illustrative, ±30%).** The weeks above assume full-time work (≈ 40 h/wk); other capacities scale linearly.

| Capacity | All of v1 (19.5 effort-weeks) | First usable tutor (15 effort-weeks) |
|---|---|---|
| Full-time | ≈ 19.5 weeks | ≈ 15 weeks |
| ~20 h/wk | ≈ 39 weeks | ≈ 30 weeks |
| ~10 h/wk | ≈ 78 weeks | ≈ 60 weeks |

---

## 2. Phases

Every **Gate** line is verbatim from PLAN §17. **Scripts** are the named acceptance scripts and test layers in [testing-spikes](./plans/testing-spikes.md). **Risks** come from its risk table, attached to the phase that handles them.

### K · Kickoff *(before week 1; not counted in the 19.5)*

- **Goal:** M0 can start without waiting on anyone.
- **Do:**
  1. Review and approve PLAN rev 2 (its header says "awaiting your review").
  2. Hand over the three inputs from PLAN §19. **(a)** 2–3 real PDFs (one text-heavy, one math/diagram-heavy, an Arabic one if relevant) plus ~10 questions per book with the page where each answer lives; this is also the retrieval eval set. Say if any book is EPUB (§5, D). **(b)** The VPS plan: provider, a Debian or Ubuntu LTS image (not Alpine), and a domain or Tailscale. **(c)** Your OpenRouter key in the server `.env` only, with a credit limit set in OpenRouter.
  3. Write M0's task-level plan (superpowers:writing-plans), PLAN §20 step 3.
  4. Optional (PLAN §20 step 2): export the Claude Doc to `docs/engine-design.md` and record your five answers in its Open questions.
  5. **[my call]** Commit the docs when you are ready; nothing is committed yet.
- **Gate:** PLAN rev 2 approved and M0's task plan written. S1 needs nothing, S3 needs the key, S5 needs the VPS. S2 and S4 need the books and can arrive during M0.
- **Risks:** books arrive late → S2 and S4 slip and M4 inherits the risk; S1, S3, S5 still run.
- **Status:** ☐

### M0 · Spikes *(2 wks · ends wk 2)*

- **Goal:** replace every **[spike]** in the plan with a measurement, so M1 onward builds on facts.
- **Builds:** S1–S5 from [testing-spikes](./plans/testing-spikes.md). **S1** canvas performance, plus Arabic and MathJax on a server canvas, plus the leaf-library choice (F12). **S2** extraction rungs R1–R4 on your books. **S3** the OpenRouter loop: tool calling, image in a tool result vs a follow-up message, caching, cost arriving in streaming mode, Arabic quality, `data_collection: "deny"`. **S4** embeddings and exact-search latency. **S5** deploy dry-run: WebSocket and SSE behind Caddy basic auth on the real VPS.
- **Needs:** K (see its gate).
- **Gate (§17):** 5,000 elements @ 60 fps; Arabic server render OK or fallback chosen; extraction default, models and embedding chosen; deploy dry-run (WS + SSE behind basic auth) works.
- **Scripts:** each spike's "Done when" row; the *Engine* benchmark numbers (also first ink ≤ 16 ms, 20,000-element board opens in < 2 s). **[my call]** Record results as a short line under each spike in testing-spikes.md and each decision in PLAN §19.
- **Decisions closed:** render path (main thread vs worker) and snapshot path; Arabic font; `rbush` and `perfect-freehand` vs in-house; extraction default per book type and page-routing thresholds; tutor, cheap and vision models and the snapshot-adapter behaviour; embedding model, `k`, `EMBED_DIMS` (or `sqlite-vec` scheduled); access gate (basic auth vs Tailscale or cookie); keep or drop the `web` process (Next.js vs static export or Vite SPA).
- **Risks:** Arabic shaping on a server canvas (S1; ladder: server canvas → open tab → headless Chromium); large boards miss the frame budget (S1; worker-canvas path); PDF math and Arabic extraction (S2); cost surprise (S3 replaces the estimates with measured cost per turn); model and AI SDK churn (S3); basic auth + WebSocket (S5; Tailscale or signed cookie).
- **Demo:** measured numbers, and a hello-world NestJS (WebSocket + SSE) and Next behind Caddy on the VPS.
- **Replan:** re-estimate every later phase now (§17); see §6.
- **Status:** ☐

### M1 · Core editor *(2.5 wks · ends wk 4.5)*

- **Goal:** a person can draw and write on a fast infinite canvas, undo, and lose nothing on reload.
- **Builds:** `packages/core` (zod schemas, scene store, ops, undo, bounds, R-tree) · renderer + camera (two canvases, dirty-flag frame loop, zoom 0.05–20) · select/transform · shapes + bound arrows · text with RTL (`<textarea>` overlay) · local save (IndexedDB). → [whiteboard-engine](./plans/whiteboard-engine.md), [tech-stack](./plans/tech-stack.md).
- **Needs:** M0 decisions (render path, font, leaf libraries).
- **Gate (§17):** Shapes, Arabic + Latin text, undo, local save.
- **Scripts:** *Engine* (Arabic and Latin text editing with an IME; golden images for shapes and text); core property test (apply then inverse = identity; conflict rules).
- **Also here [my call]:** repo scaffold from tech-stack ("scaffold in M0/M1, then pin"), Biome, Vitest and CI (`lint`, `test`), since this is the first code that is kept (M0 spike code is throwaway). Specify group-resize semantics and rotated hit-testing (F13).
- **Risks:** text editing on a canvas (IME, selection, RTL): test Arabic and Latin from the first text tool.
- **Demo:** draw a diagram with bound arrows, type Arabic and Latin text, undo, reload and it is still there.
- **Status:** ☐

### M2 · Math and images *(1.5 wks · ends wk 6)*

- **Goal:** equations and pictures look right at every zoom, and the camera can fly somewhere on request (the primitive Jump-to-AI needs).
- **Builds:** `renderMath()` (MathJax v4, TeX → SVG → cached bitmap) + live LaTeX box · image element (upload, crops, zoom-bucket caches) · camera `flyTo` + pulse. → [math-renderer](./plans/math-renderer.md), [whiteboard-engine](./plans/whiteboard-engine.md).
- **Needs:** M1.
- **Gate (§17):** Math and images crisp at every zoom; math security tests pass.
- **Scripts:** the six hostile-LaTeX payloads (`\href`, `\url`, `\require`, `\class`, `\style`, `\unicode`) render as errors, never a link or a load; error tests (unbalanced braces, unknown macro); ~20 golden equations, Node adapter vs browser; 200 math elements stay at 60 fps after first render.
- **Also here [my call] (seam 6):** image bytes live in IndexedDB, keyed by content hash, until `/api/blobs` exists in M3.
- **Decisions closed:** Arabic inside `\text{}` supported, or restricted to Latin and documented (F14).
- **Risks:** text-mode content outside MathJax's font data may depend on fonts again (F14).
- **Demo:** type LaTeX and see it live, drop an image, zoom from 0.05 to 20: both stay crisp.
- **Status:** ☐

### M3 · Server *(2.5 wks · ends wk 8.5)*

- **Goal:** the board lives on a server, survives restarts, syncs between tabs, and runs on the VPS behind the gate.
- **Builds:** WebSocket gateway · Board service (validate → seq → apply → store → broadcast) · SQLite op log + snapshots + migrations (`0001_init`) · blobs on disk · snapshot renderer (core `render()` on `@napi-rs/canvas`) · access gate + Origin checks · systemd + Caddy deploy scripts · **first VPS deploy**. → [deployment](./plans/deployment.md), [database](./plans/database.md), [api](./plans/api.md), [auth-security](./plans/auth-security.md).
- **Needs:** M1 and M2 (store, ops and validation; `render()` and math for the server picture); the S1 and S5 decisions. An off-box backup remote for `rclone` (§5, C).
- **Gate (§17):** Two tabs stay in sync; survives restart; VPS reachable only through the gate; server PNG matches browser.
- **Scripts:** *Deployment* (VPS serves only through the gate; services survive a reboot); *Security* (foreign Origin rejected on WebSocket and POST); WebSocket ordering test (two clients, interleaved batches, identical final scene); migration test on a copy of a DB.
- **Also here [my call]:** `deploy.sh`, `backup.sh` and the backup timer ship with the first deploy so data is protected from day one (deployment.md VPS step 8); the restore drill stays in M7. `board_ops` carries `turn_id`, `label`, `bounds` and `touched_ids` from `0001_init`, and the Board service fills `bounds` for every batch, so M5's Locate needs no backfill.
- **Risks:** basic auth + WebSocket misbehaves (S5 fallback: Tailscale or signed cookie); Arabic shaping on the server canvas (S1 ladder). If S1 picked a snapshot fallback, rescope the last gate clause (§6).
- **Demo:** two browser tabs editing one board at the VPS URL behind the gate; restart the server and the board is still there.
- **Status:** ☐

### M4 · Library *(2.5 wks · ends wk 11)*

- **Goal:** a real book becomes searchable pages with citations.
- **Builds (§17):** upload, estimate/preview, extraction ladder (R1–R4, per-page routing), structure (PDF outline + printed page labels), chunks, embeddings, summaries, hybrid search API (FTS5 + exact vectors → reciprocal-rank fusion), library UI, source panel, eval runner. → [library-ingestion](./plans/library-ingestion.md), [rag-context-engineering](./plans/rag-context-engineering.md), [database](./plans/database.md).
- **Split [my call] (seams 4, 5):** **4a** ingestion core: worker thread, `pnpm ingest`, `book_*` tables + FTS5, embeddings, summaries, search function, `pnpm eval:retrieval`. Needs only M3's persistence layer (`db/` module, migrations, blob store). **4b** REST endpoints, library UI (dropzone, book cards, outline, scope picker, **Study this**) and the source page viewer (`pdfjs-dist`) shown on the Book page. Needs M3's server and the web shell. The viewer becomes the chat dock's Source tab in M5.
- **Also here (seam 1):** `spend` ledger and daily-cap check, so a paid rung never starts past `DAILY_BUDGET_USD`; the estimate is shown before any paid rung.
- **Needs:** M0 (S2, S4 results); M3 (see the split).
- **Gate (§17):** Retrieval eval target met on a real book.
- **Scripts:** *Library*: ingest one real book per type; `pnpm eval:retrieval` meets the target (expected page in the top 8 for ≥ 80%); the preview/estimate flow is cancelable before any paid rung. Also: resumability (kill mid-run, re-run), no chunk crossing an equation, page-label mapping, section counts, SQLite write-contention load test.
- **Decisions closed:** if the eval misses, the documented ladder is neighbours → `qwen3-embedding-8b` → chunk context → reranker; `sqlite-vec` if search latency demands it (S4).
- **Risks:** PDF math and Arabic extraction (ladder, per-page routing, preview before indexing); wrong-page retrieval (hybrid search, heading-path embedding, eval gate); SQLite write contention (worker thread, short transactions, `busy_timeout`); slow large-book ingestion (queue, progress, resumable steps); cost (estimates + ledger).
- **Demo:** upload a real book, watch progress, browse the outline, search it (right page in the top 8), open the cited page in the viewer.
- **Status:** ☐

### M5 · Tutor slice *(4 wks · ends wk 15)*

- **Goal:** the whole product loop works: ask, the tutor explains on the board with citations, point, locate, undo.
- **Builds (§17):** chat dock ([chat-ui](./plans/chat-ui.md)) · board-context builder + chips + browser-side pictures ([board-context](./plans/board-context.md)) · agent loop + tool registry ([ai-integration](./plans/ai-integration.md)) · prompts + scope packs + caching + citations ([rag-context-engineering](./plans/rag-context-engineering.md)) · placement · `add_diagram` · `add_book_figure` · jump-to-AI ([jump-to-ai](./plans/jump-to-ai.md)) · turn undo · budgets · stub tutor.
- **Registry [my call] (seam 3):** 15 of the 18 tools; `add_chart`, `draw_stroke` and `arrange` register in M6 with their elements.
- **Also here [my call]:** the Source tab, mounting M4's viewer (seam 5); per-turn caps (`MAX_STEPS`, `MAX_TURN_COST_USD`, 120 s), the usage view and top-bar spend on top of M4's ledger (seam 1); `messages` and `settings` (student profile); Activity tab, Follow AI, hover tag on AI elements and **Ask AI** in the selection toolbar.
- **Needs:** M1 (`render()` for browser-side pictures), M2 (`flyTo` + pulse, images), M3 (Board service, WebSocket, snapshot render), M4 (search, summaries, viewer).
- **Gate (§17):** End-to-end script in testing-spikes passes.
- **Scripts:** *Tutor end-to-end* (the gate: upload → index → chapter-scope board → question → text, math and shape with `[p. N]` citations → citation opens the Source tab → Stop leaves a consistent board → *Undo this response*); *Board context* (R3) except its handwriting step (seam 2); *In-app chat* (R2: Arabic composer, history after reload); *Jump to AI* (Follow off and on, past, after reload, after deletion, after a move, deep links); *Caching and cost* (turn 2 `cached_tokens > 0`; `MAX_STEPS=2` or `MAX_TURN_COST_USD=0.01` stops a runaway loop; `spend` matches OpenRouter within rounding); *Security* (injection seed text ignored; no key in the bundle, logs or DB); one live OpenRouter run of the M5 script, reading the cost footer.
- **Decisions closed:** the whole-book cached-prompt experiment (default off); `useChat` transport sending only the new message ("verify in M5"); the Ask AI keyboard shortcut (none until M5).
- **Risks:** AI clutters the board (element budget, titled clusters, `placement: auto`, *Undo this response*; `arrange` arrives in M6); prompt injection (delimited data, edit-rights guard, validated citations, seeded test); cost surprise (caps, usage view, credit limit on the key); model and AI SDK churn (models in env, fallback model, one adapter module).
- **Demo:** the product. Chat, a board explanation with citations, select and ask, jump to the AI's work, undo the response, cost footer visible. **First usable tutor.**
- **Status:** ☐

### M6 · Ink, charts, polish *(2.5 wks · ends wk 17.5)*

- **Goal:** the student can handwrite and the AI can chart.
- **Builds (§17):** pen, highlighter, eraser (Pointer Events, coalesced events, palm rejection) · charts (bar, line, area, pie, donut, scatter) + data grid · `arrange` · group · snap. → [whiteboard-engine](./plans/whiteboard-engine.md), [ai-integration](./plans/ai-integration.md).
- **Registry (seam 3):** add `add_chart`, `draw_stroke`, `arrange` (18 of 18).
- **Needs:** M1 (tool contract, R-tree), M3 (sync); the registry additions and the handwriting script need M5. The pen alone could move earlier (§5, A).
- **Gate (§17):** Student can handwrite; AI can chart.
- **Scripts:** *Board context* handwriting step (seam 2): select 3 elements including one stroke, the chip reads "3 · structure + picture (auto)", the request carries one image; handwriting auto-attaches a picture and a text-only selection does not. Golden images for strokes and charts, browser vs server. First ink within one frame.
- **Risks:** freehand on large boards misses the frame budget (S1's worker-canvas path is ready).
- **Demo:** handwrite a note, select it, **Ask AI**, and it reads the picture; ask for a chart and a data-driven chart appears.
- **Status:** ☐

### M7 · Hardening *(2 wks · ends wk 19.5)*

- **Goal:** v1 is fast, safe and recoverable.
- **Builds (§17):** performance pass · security review · accessibility outline panel · backup restore drill · optional MCP adapter (`/mcp`, tokens). → [auth-security](./plans/auth-security.md), [deployment](./plans/deployment.md), [ai-integration](./plans/ai-integration.md).
- **Needs:** everything above; the MCP adapter needs the complete registry from M6.
- **Gate (§17):** Benchmarks + checklist pass.
- **Scripts:** *Security*, full pass of auth-security.md (Origin, uploads, LaTeX and injection tests; try to reach `:3000` and `:4000` from outside; `grep` the build, logs and DB for the key). *Deployment*: the backup restores onto a clean directory (stop both units → replace `whiteboard.db` → restore `blobs/` → start → open an old board and a book). *Engine*: benchmark re-run (60 fps at 5,000 visible elements; 20,000-element board opens in < 2 s).
- **Decisions closed:** build the optional MCP adapter now or leave it for after v1 (not on the v1 critical path).
- **Risks:** prompt injection (final review against the seeded tests); large boards (performance pass).
- **Demo:** benchmark table, security checklist ticked, a restored backup.
- **Status:** ☐

---

## 3. Dependencies

| Phase | Needs | Can start early |
|---|---|---|
| K | – | – |
| M0 | K | S1, S3, S5 before the books arrive |
| M1 | M0 decisions | – |
| M2 | M1 | – |
| M3 | M1, M2; S1 and S5 decisions | Its persistence layer (`db/` module, migrations, blob store) has no canvas dependency |
| M4 | **4a:** M0 (S2, S4) + M3's persistence layer. **4b:** M3's server + web shell | 4a can overlap M1–M3 (§5, B) |
| M5 | M1, M2, M3, M4 | – |
| M6 | M1, M3; registry additions and handwriting script need M5 | The pen could move earlier (§5, A) |
| M7 | All of the above | – |

```
Default (single track)
  K ─▶ M0 ─▶ M1 ─▶ M2 ─▶ M3 ─▶ M4a ─▶ M4b ─▶ M5 ─▶ M6 ─▶ M7

Optional overlap (§5, B): needs capacity for two tracks
  Track 1   M0 ─▶ M1 ─▶ M2 ─▶ M3 (sync, gate, deploy) ─▶ M4b ─▶ M5 ─▶ M6 ─▶ M7
  Track 2   M0 ─▶ M3 persistence layer ─▶ M4a ───────────────┘
```

---

## 4. Seams between §17 and the plan files, and how this roadmap resolves them

Found while reading all 16 docs against §17. Resolutions are **[my call]**; override any. They are appended to PLAN §19 as decisions 17–22: seams 1, 2, 3 → 17, 18, 19; seams 4 and 5 → 20; seam 6 → 21; 22 records that this file holds the detail while §17 stays the contract.

| # | Seam | Resolution |
|---|---|---|
| 1 | Paid ingestion rungs must respect the daily cap ([auth-security](./plans/auth-security.md) Budgets, [library-ingestion](./plans/library-ingestion.md) flow step 3), but the `spend` ledger and caps are not in M4's build list | `spend` table and daily-cap check ship in M4; per-turn caps, usage view and top-bar spend in M5 |
| 2 | The *Board context* script selects "one handwritten stroke", but the pen lands in M6 | That step and the freehand auto-picture rule are verified at M6; the M5 gate runs the script with text and shape selections |
| 3 | "18 tools" at M5 includes `add_chart`, `draw_stroke`, `arrange`, whose elements and tools land in M6 | M5 registers 15; M6 adds 3 (the registry is data-driven, so no rework) |
| 4 | §17 says "M4 does not depend on M1–M3". True for the ingestion core, not for REST and UI: ingestion writes SQLite and blobs, the UI needs the server | Split M4: **4a** ingestion core, `pnpm ingest`, eval runner (needs only M3's persistence layer); **4b** REST, library UI, source viewer (needs M3's server and the web shell). Default order: both after M3 |
| 5 | The source panel is an M4 deliverable but a tab of the M5 chat dock | M4 builds the page viewer on the Book page; M5 mounts it as the dock's Source tab |
| 6 | Where M2 image bytes live before `/api/blobs` (M3) exists is unspecified; M1 has IndexedDB local save | IndexedDB keyed by content hash (the scheme `blobs.id` uses); M3 swaps the backend. M1–M2 local boards are throwaway, no import path |

---

## 5. Decision points

Defaults are what this roadmap assumes. Override any before the phase named.

| # | Decision | Default | Alternative and cost | Decide by |
|---|---|---|---|---|
| A | When does handwriting land? | **M6**, tutor first (PLAN §19 #7) | Swap the pen half of M6 into M1: handwriting exists from M1 on and seam 2 disappears. That half of M6's 2.5 weeks moves ahead of the tutor (the docs give no finer number) | Before M1 starts |
| B | One track or two? | **Single track**, M0 to M7 in order | Overlap 4a with M1–M3: the tutor slice lands at about week 11–12 on the calendar (§17). Needs capacity for two tracks and M3's persistence layer built first | After M0 (re-estimate) |
| C | Off-box backup target for `rclone` ([deployment](./plans/deployment.md) Backups). Not among the Kickoff inputs | **Open** | Any remote `rclone` supports | Before M3's first deploy |
| D | EPUB in v1? | **No, PDF only** (PLAN §19 #14) | If a book is EPUB, EPUB moves into M4 ([library-ingestion](./plans/library-ingestion.md)) | Kickoff, when the books arrive |
| E | MCP adapter | **Optional, in M7** (PLAN §19 #5) | Leave it for after v1 | M7 |

---

## 6. Replan checkpoints

| After | Why | Do |
|---|---|---|
| **M0** (mandatory) | S1–S5 replace estimates with measurements (§17: "re-estimate after M0") | Re-estimate M1–M7; record decisions in PLAN §19; revisit B. If S1 picks a snapshot fallback (open tab or headless Chromium) instead of the server canvas, rescope M3's last gate clause, "server PNG matches browser", to the chosen path |
| M3 | First VPS deploy and the first real velocity data | Compare actuals with the ±30% band; confirm the gate choice in practice |
| M5 | First usable tutor: the product exists | Use it on a real book; re-decide M6 against v1.1 priorities (pen, charts, quizzes) before spending the weeks |

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

| Date | Phase | Note |
|---|---|---|
| 2026-11-01 | – | Roadmap drafted from PLAN rev 2 and the 14 aspect files. Nothing started. |
