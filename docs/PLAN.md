# Whiteboard AI — Study Companion: Validation and Full Plan

> **Hackathon:** Built for the **[Meta AI Developer Hackathon](https://cerebralvalley.ai/e/meta-ai-developer-hackathon)** hosted by **Meta** and **Cerebral Valley**.
> **Status:** revision 1 approved 2026-11-01 · **revision 2** (same day, approved at Kickoff: ROADMAP K ✔): no Docker, in-app chat, whiteboard as AI context, plan split into one file per aspect, README added.
> **Inputs:** Claude Doc *Whiteboard Engine: Design Doc* (https://claude.ai/artifact/QPPBUq22meEmXKSmJ856qq, rev 11; all text and both diagrams read) · your answers to its 5 open questions · your brief (student companion, books + RAG, OpenRouter key, "jump to where the AI worked") · your revision-2 resolutions (next section).
> **Conventions:** **[my call]** = a decision I made for you; override any. **[spike]** = I could not verify it from here; M0 settles it with evidence.
> **How the plan is organised:** this file is the master (resolutions, validation, product, milestones, decisions). Each aspect has its own file in [`plans/`](./plans/). The section for it below summarises it and names the file.

---

## Resolutions

| # | Resolution | What it means | Details |
|---|---|---|---|
| R1 | **No Docker** | Everything runs natively: `pnpm dev` locally; on the VPS, Node + systemd + Caddy. One SQLite file replaces Postgres; blobs live on disk; no Redis, no S3. | [deployment](./plans/deployment.md) · [database](./plans/database.md) · [tech-stack](./plans/tech-stack.md) |
| R2 | **Chat with the AI inside the app** | A chat dock in the board UI is the only way to talk to the tutor in v1 (no external client needed). Streaming replies, tool chips, page citations, Stop, Undo response. | [chat-ui](./plans/chat-ui.md) · [ai-integration](./plans/ai-integration.md) |
| R3 | **The whiteboard is the AI's context; a selection can be passed in chat** | Every turn carries a compact digest of the board. The student can attach the selection, the viewport or the whole board, as structure, as a picture, or both, and sees exactly what will be sent. | [board-context](./plans/board-context.md) |
| R4 | **One plan doc per aspect** | 14 files in `docs/plans/`, indexed in the Plan map below. | all |

**Why SQLite (consequence of R1) [my call].** Without Docker, Postgres would be a server you hand-install and keep patched on two machines. A single-owner app does not need one: SQLite in WAL mode gives ordered, transactional op logs; FTS5 gives BM25 keyword search; embeddings sit in a BLOB column and are searched exactly in memory (hundreds of thousands of chunks is tens of milliseconds). Backups become one online-backup call. The revert path to Postgres + pgvector is written down in [database](./plans/database.md) and costs one module.

---

## Plan map

| § | Aspect | File |
|---|---|---|
| 4 | Tech stack and repo layout | [plans/tech-stack.md](./plans/tech-stack.md) |
| 5 | Run and deploy (no Docker) | [plans/deployment.md](./plans/deployment.md) |
| 6 | Whiteboard engine | [plans/whiteboard-engine.md](./plans/whiteboard-engine.md) |
| 7 | Math renderer | [plans/math-renderer.md](./plans/math-renderer.md) |
| 8 | AI integration (tutor agent) | [plans/ai-integration.md](./plans/ai-integration.md) |
| 9 | In-app chat UI | [plans/chat-ui.md](./plans/chat-ui.md) |
| 10 | Whiteboard as AI context | [plans/board-context.md](./plans/board-context.md) |
| 11 | Library and ingestion | [plans/library-ingestion.md](./plans/library-ingestion.md) |
| 12 | RAG and context engineering | [plans/rag-context-engineering.md](./plans/rag-context-engineering.md) |
| 13 | Jump to AI work | [plans/jump-to-ai.md](./plans/jump-to-ai.md) |
| 14 | Database | [plans/database.md](./plans/database.md) |
| 15 | API (REST, WebSocket, chat stream) | [plans/api.md](./plans/api.md) |
| 16 | Auth and security | [plans/auth-security.md](./plans/auth-security.md) |
| 18 | Spikes, tests, verification | [plans/testing-spikes.md](./plans/testing-spikes.md) |

---

## 0. Context and TL;DR

**Hackathon alignment.** Built specifically for the **[Meta AI Developer Hackathon](https://cerebralvalley.ai/e/meta-ai-developer-hackathon)** (Meta × Cerebral Valley). Whiteboard AI tackles visual, multimodal AI education: an interactive whiteboard where Meta models via the **Meta Model API** (`https://api.meta.ai/v1`: `muse-spark-1.3`, `muse-wonder-1.0`; or open-weights `meta-llama/llama-4-maverick` via OpenRouter) act as a personal tutor explaining complex textbooks with formulas, diagrams, and verifiable page citations.

**Context.** The design doc specifies a from-scratch infinite canvas plus 16 MCP tools, and assumes an *external* AI client does the thinking. The product is now a **study companion**: a student uploads books, picks a topic / chapter / whole book, and chats with an AI tutor that explains on a shared whiteboard with page citations. This plan (1) validates the doc against that product and your answers, and (2) adds what is missing.

- **The engine design is sound and mostly stays.** Your answers delete a lot of it: accounts, roles, JWT, OAuth, Redis, S3, multi-instance, and now Docker and Postgres.
- **Biggest gap:** no built-in AI. A tutor needs a chat dock in the UI and a server-side agent loop over the Meta Model API (§8–9), the whiteboard as its context (§10), a book library with hybrid retrieval (§11–12), and jump-to-AI-work (§13).
- **"No login" is fine on localhost, not on a VPS** that holds your `META_API_KEY` / `OPENROUTER_API_KEY` and your books. One shared-secret gate fixes it (§16).
- **Re-sequenced** so a usable tutor lands at the end of M5, before pen and charts. The doc's plan covered engine + MCP only (§17).
- **I need from you before M0** (not now): 2–3 real books and ~10 questions per book (§19).

---

## 1. Validation of the design doc

### 1.1 Verdict

**Sound as an engine spec; incomplete as a product spec.** I cross-checked the doc against itself (schemas ↔ tools ↔ tables ↔ roadmap ↔ diagrams), your answers, and the new brief. Ops, undo, renderer, element model and sync are coherent; I would build them as written. Missing: everything that makes this a study companion, plus one security hole that "no login" opens. I did not build or benchmark anything: the performance claims and Arabic shaping on a server canvas are unverified, which the doc itself acknowledges by making M0 the gate.

### 1.2 Your five answers

| # | Answer | Effect on the design |
|---|---|---|
| 1 | Images inline on the canvas, not in a text block | The doc's reading was right; nothing changes. Text blocks stay plain text (no inline objects). |
| 2 | LaTeX for math if it solves it | It does. LaTeX is MathJax's input syntax, so MathJax stays and no TeX engine is written. LaTeX is also what LLMs emit and what a book converted to Markdown carries (`$…$`). MathJax v4 (`@mathjax/src`), SVG output. → [math-renderer](./plans/math-renderer.md) |
| 3 | No login / signup for now | Drop sessions/JWT, owner/editor/viewer, `owner_id`, `agent_tokens`, OAuth 2.1. Keep `author.kind` (human / agent): it is core UX. **Add the access gate** → [auth-security](./plans/auth-security.md) |
| 4 | Locally and on a VPS | Same code and config on both, installed natively (R1): Node + a SQLite file locally; Node + systemd + Caddy on the VPS. Long-lived WebSockets already rule out serverless (doc agrees). VPS 1–2 vCPU / 2 GB [estimate]. → [deployment](./plans/deployment.md) |
| 5 | Single owner now, share links later | No workspaces or sharing. Boards get unguessable UUIDs. Share links later = a `board_shares` table + a read-only role; nothing in v1 blocks it. |

### 1.3 Findings

| ID | Sev | Where | Finding | Resolution |
|---|---|---|---|---|
| F1 | High | Whole doc | Assumes an external MCP client supplies the AI. No chat UI, agent loop, prompt assembly, or cost limits. | Built-in tutor and chat dock (§8–9). MCP becomes an optional adapter (M7). |
| F2 | High | Whole doc | No knowledge layer: upload, extraction, chunking, embeddings, retrieval, citations. | §11–12 |
| F3 | High | Security | After answer 3 nothing protects a VPS deployment, and the server will hold your OpenRouter key. Anyone who finds the URL can spend your credits and read your books. | Access gate + Origin checks + budgets (§16) |
| F4 | Med | Rendering | "`render()` is pure, no DOM access" is overstated: offscreen bitmaps (`OffscreenCanvas`, `createImageBitmap`), MathJax SVG rasterising, font loading and `measureText` are platform calls. | Inject a small platform adapter into `render()` (§6) |
| F5 | Med | Rendering | Server bundles one Arabic font "so snapshots match the browser", but the browser uses whatever font it resolves. | Ship the same font files to the page and the server (§6) |
| F6 | Med | MCP / snapshots | `get_snapshot` returns "MCP image content". OpenRouter's tool-calling docs only show text `content` in `role:"tool"` messages and never say images are allowed. | Tutor adapter returns the PNG as a follow-up *user* message with an image part **[spike S3]** (§8) |
| F7 | Med | Retention / undo | 30-day op retention contradicts "jump to what the AI did" weeks later. "One call = one batch = one undo" makes a 10-call tutor turn 10 undos. | Permanent per-batch metadata (`bounds`, `label`, `turn_id`); turn-level undo (§13) |
| F8 | Med | Roadmap | M0 (renderer, camera, R-tree, pen, headless-render test, 5,000-element benchmark) is a lot for one phase and leaves the AI, ingestion and deploy unknowns unspiked. | M0 = spikes only, incl. AI, ingestion and deploy; gates by evidence (§17) |
| F9 | Low | Consistency | `donut` is in the chart prose but not in `add_chart`'s enum. `triangle`/`polygon` have an agent tool but no human tool, though the doc promises symmetry. `patch` paths address arrays by index (`data.series.0.values`), which can mis-target under concurrent edits. | Add `donut`; triangle joins the shape picker, polygon stays agent-only (stated); keep last-write-wins for v1 |
| F10 | Low | Sync | 30 Hz presence, live ink and multi-instance fan-out are built for many people; v1 has one human and one agent. | Keep the server-authoritative op log (human and agent still race); drop human presence and live ink; keep agent events (§6) |
| F11 | Low | Identity | `author` "set by the server from the authenticated identity" means nothing without auth. | Derive from the channel: WebSocket = human, in-process tutor = agent (`tutor:<turnId>`). A WebSocket client can never emit `agent`. |
| F12 | Low | Build vs. buy | In-house R-tree and stroke smoothing are fine, but your own non-goal allows leaf libraries: `rbush` and `perfect-freehand` are small and exist. | Decide in M0; optional |
| F13 | Low | Unspecified | Hit-testing under rotation, group resize semantics, and a screen-reader path for canvas content. | Specify in M1; accessibility outline panel in M7 |
| F14 | Low | Math | "MathJax SVG draws glyphs as paths, so it needs no font files" holds for math glyphs, but text-mode content outside MathJax's font data (e.g. Arabic inside `\text{}`) may come out as SVG `<text>`, which depends on fonts again. | Keep Arabic labels in separate text elements; register the bundled fonts on the server canvas; test **[spike S1]** (§7) |

### 1.4 Stays as written

Op format (`add`/`patch`/`remove`/`reorder`, atomic batches), conflict rules, append-only undo via inverse batches, two canvases, camera, spatial index, element caches keyed `(v, zoom bucket)`, freehand pipeline, two-phase hit-testing, tool state machines with `<textarea>` overlay for text/IME, MathJax-SVG rationale, data-driven charts, server-authoritative op log, "placement, not pixels", "close the loop with snapshots", errors that teach, the limits table, the performance targets and their fallback ladder.

### 1.5 Cut list (your answers or YAGNI)

Docker / Compose · Postgres + pgvector (one SQLite file instead) · Redis pub/sub and presence expiry · S3-compatible storage (blobs on disk) · multi-instance · sessions/JWT and roles · `agent_tokens` and per-token rate limits (until MCP) · OAuth 2.1 · human presence streaming and live-ink broadcast · `add_image` from URLs (removes the SSRF surface) · headless Chromium as *first* snapshot fallback · 30-day op retention · MCP endpoint on the v1 critical path.

---

## 2. Product

### 2.1 Intent

A personal study companion. Upload a book, choose what to study (a topic, a chapter, the whole book), and **chat with an AI tutor inside the app** that explains on a shared infinite whiteboard: text, LaTeX equations, shapes and arrows, auto-laid-out diagrams, charts, and cropped figures from the book, with page citations. The student writes and draws too, can select anything and ask about it, and can always find where the AI worked.

### 2.2 Core loops

1. **Ask.** The student types in the chat dock. The tutor answers there and builds the explanation on the board, citing pages.
2. **Point.** Select part of the board (including handwriting), or attach the viewport / whole board, and ask. The AI receives the region as structure, as a picture, or both (§10).
3. **Locate.** Click anywhere the AI's work is referenced (chat, activity list, element tag) and the camera flies there; "Follow AI" tracks live work (§13).

### 2.3 Goals, non-goals, anti-goals (v1)

**Goals**
- Upload PDFs, pick a scope, chat, get board explanations with page citations.
- The whiteboard is always the AI's context; selection / viewport / board can be attached to any message.
- Retrieval that lands on the right page, measured on *your* books (§18).
- Jump to AI work, live and historical.
- The doc's engine goals (seven capabilities, one op format, Arabic/RTL), minus what §1.5 cuts.
- Runs natively on a laptop and on a small VPS; access gate on the VPS.
- Predictable cost: per-turn and per-day caps, visible usage.

**Non-goals**
- Accounts, roles, share links (designed-for, built later); real-time multi-human collaboration.
- Docker, a database server, queues or caches.
- Native mobile apps, WebGL, plugin API, audio/video/web embeds, fetching images from URLs.
- Quizzes, flashcards, spaced repetition (v1.1; the tutor can already "quiz me" in chat).
- Fine-tuning or self-hosting models; tldraw/Excalidraw/Konva (unchanged from the doc).

**Anti-goals** (failure even if it technically works)
- The AI presents invented content as "from your book".
- The board becomes an unreadable pile of AI output.
- The AI edits or deletes the student's own work without being asked.
- The camera moves without the student knowing why.
- The student cannot tell what the AI was shown.
- A surprise bill.

---

## 3. Architecture at a glance

```
Browser (Next.js) ── canvas engine · chat dock · library · source panel ──┐
   │ WebSocket /ws        │ HTTP SSE /api/chat       │ REST /api/*         │ imports
   ▼ (board ops)          ▼ (tutor stream)           ▼ (books, boards)     ▼
NestJS server (one Node process) ─────────────────────────────────  packages/core
  Board service    validate → seq → apply → store → broadcast          (schemas, store,
  Tutor service    AI SDK tool loop · tool registry · prompts · caps    ops, undo, render,
  Context builder  board digest · selection · pictures → prompt         tool registry)
  Library service  upload · extract · chunk · embed · summarise · search
                   (ingestion runs in a worker thread)
  Snapshot render  core render() on @napi-rs/canvas
   │                                         │
SQLite file (WAL) + blobs on disk        Meta Model API (chat + tools + vision + page OCR; META_API_KEY)
 under DATA_DIR                          + OpenRouter (baai/bge-m3 embeddings only; OPENROUTER_API_KEY)
```

Human ops (WebSocket) and tutor ops (in-process) enter the **same** Board service, so they share validation, ordering, undo and broadcast. Repo layout and stack: [tech-stack](./plans/tech-stack.md).

---

## 4. Tech stack → [plans/tech-stack.md](./plans/tech-stack.md)

TypeScript + pnpm workspace (`packages/core`, `apps/web`, `apps/server`). Next.js 16 (client-only editor), NestJS 12, SQLite via better-sqlite3, zod 4, AI SDK 7 + `@ai-sdk/openai-compatible` (Meta Model API) + OpenRouter embeddings, MathJax 4, `@napi-rs/canvas`, `pdfjs-dist`, dagre. Versions checked on npm 2026-11-01. pnpm only (no npm/yarn/`npx`). No Docker, no database server, no queue.

## 5. Run and deploy, no Docker → [plans/deployment.md](./plans/deployment.md)

- **Local:** Node 22 + pnpm. `pnpm install`, copy `.env.example`, `pnpm dev`. Data in `./data` (SQLite + blobs).
- **VPS:** Debian/Ubuntu LTS, Node 22, Caddy (TLS + basic auth), two systemd units (server, web). Deploy = `git pull` → `pnpm install --frozen-lockfile` → `pnpm build` → `systemctl restart`.
- Migrations run at startup after an automatic DB backup; nightly online backup + blobs sync; one restore drill in M7.

## 6. Whiteboard engine → [plans/whiteboard-engine.md](./plans/whiteboard-engine.md)

The design doc stays the base (digest kept in the file so the repo is self-contained). Deltas: a platform adapter for `render()` (F4), the same fonts on web and server (F5), snapshot paths (browser-rendered pictures for context; server canvas → open tab → headless Chromium for AI-requested snapshots), no human presence or live ink (F10), agent events (`agent_focus`, `agent_status`), and the edit-rights guard.

## 7. Math renderer → [plans/math-renderer.md](./plans/math-renderer.md)

LaTeX in, MathJax v4 TeX → SVG → cached bitmap out; the same `renderMath()` serves canvas elements, chat messages, the source panel and server snapshots. Package allowlist (no `\href`, `\url`, `\require`, `\class`, `\style`), errors that teach the tutor, golden-image and security tests.

## 8. AI integration (tutor agent) → [plans/ai-integration.md](./plans/ai-integration.md)

Meta Model API (`META_API_KEY`, `https://api.meta.ai/v1`) for all LLM/vision calls (`OPENROUTER_API_KEY` retained strictly for `baai/bge-m3` embeddings and M0 benchmark scripts); keys server-side only. AI SDK 7 tool loop behind one adapter module; one tool registry in `packages/core` (18 tools: board read/write, `add_diagram`, `add_book_figure`, book tools) with an AI SDK adapter now and an MCP adapter later. Every write = one labelled batch stamped with the turn. Caps per turn and per day, edit-rights guard, snapshots to the model (`SNAPSHOT_ADAPTER=follow-up-user` required as Meta Model API rejects multipart images in tool messages), prompt caching, fallback model, stub tutor for tests. Models are env vars defaulting to Meta Model API models (`muse-spark-1.3`, `muse-wonder-1.0`), with open-weights Llama 4 (`meta-llama/llama-4-maverick`) via OpenRouter and M0 S3 OpenRouter benchmarked models documented alongside.

## 9. In-app chat UI → [plans/chat-ui.md](./plans/chat-ui.md)

A resizable chat dock on the board page (tabs: Chat · Activity · Source). Streaming Markdown + LaTeX, tool-call chips with Locate, `cite:` and `board:` links, Stop, Undo response, per-turn cost, quick actions (Explain · Summarise · Check my work · Ask), and a composer with **context chips** (Selection · Viewport · Whole board) plus image paste.

## 10. Whiteboard as AI context → [plans/board-context.md](./plans/board-context.md)

Every turn includes a budgeted **board digest** (header, counts, viewport, selection, element list). The student can attach the **selection** (default when something is selected: structure + picture), the **viewport** or the **whole board**, each as structure, picture or both. Pictures are rendered in the browser and uploaded as blobs. Freehand content auto-attaches a picture. A "What the AI sees" preview shows the exact digest and thumbnails. The selection also grants the AI permission to edit those elements for that turn.

## 11. Library and ingestion → [plans/library-ingestion.md](./plans/library-ingestion.md)

PDF-only v1. Upload → estimate and preview → index. Extraction ladder R1 (local `pdfjs-dist`) → R4 (`VISION_MODEL` via Meta Model API on `@napi-rs/canvas` page PNGs) for scanned and math-dense pages, routed per page (S2 dropped the free `cloudflare-ai` rung R2 and benchmarked OpenRouter `mistral-ocr` R3 and `gemini-3.8-flash` R4 as the M0 baseline). Structure from the PDF outline with printed page labels. Heading-aware chunks, multilingual `baai/bge-m3` embeddings via OpenRouter (`OPENROUTER_API_KEY`), FTS5 index, bottom-up summaries via `CHEAP_MODEL` on Meta Model API. Ingestion runs in a worker thread; steps are resumable.

## 12. RAG and context engineering → [plans/rag-context-engineering.md](./plans/rag-context-engineering.md)

Prompt assembled stable → volatile for cache hits. Scope packs: **topic** (model knowledge + library search), **chapter** (whole chapter if it fits 60k tokens, else summaries), **book** (outline + chapter summaries + retrieval). Hybrid search (FTS5 + exact vectors → reciprocal-rank fusion). Validated `cite:` links, "From your book" vs "General explanation", untrusted-content delimiters, rolling memory.

## 13. Jump to AI work → [plans/jump-to-ai.md](./plans/jump-to-ai.md)

Every agent batch stores `turn_id`, `label`, `bounds`, `touched_ids` forever. Locate from chat chips, the Activity panel, `board:` links and a hover tag on AI elements. Live: **Follow AI** toggle, off-screen edge indicator, "Jump to AI" button. Ghost frame for deleted elements, "↩ Back" chip, deep links, per-batch and per-response undo.

## 14. Database → [plans/database.md](./plans/database.md)

SQLite (better-sqlite3, WAL) with numbered SQL migrations, FTS5 for keywords, Float32 BLOBs searched exactly in memory (`sqlite-vec` is the upgrade path), online backups. Tables: boards, board_ops, board_snapshots, blobs, books, book_sections, book_pages, book_chunks (+FTS), messages, settings, spend.

## 15. API → [plans/api.md](./plans/api.md)

REST under `/api` (boards, books, blobs, settings, usage, search, context preview), one WebSocket `/ws` for board ops and agent events, one SSE endpoint `POST /api/chat` for the tutor stream. Uniform error shape and codes.

## 16. Auth and security → [plans/auth-security.md](./plans/auth-security.md)

No login. Localhost: bound to 127.0.0.1. VPS: Caddy `basic_auth` in front of everything, apps unpublished, **Origin checks** on WebSocket and non-GET requests, key only in server env, credit limit on the OpenRouter key, per-turn and per-day budgets, MathJax allowlist, upload validation, prompt-injection rules for book and board text, privacy notes. Share links and accounts are designed-for, not built.

---

## 17. Milestones (re-sequenced: tutor before pen and charts)

> Detailed roadmap (scope, dependencies, gates, acceptance scripts, risks and status per phase): [ROADMAP.md](./ROADMAP.md). It mirrors the order and gates in this table; if they differ, this table wins until both are updated.

This table gives order and gates only; no durations are estimated. Revisit the scope and order of M1–M7 after M0.

| # | Milestone | Builds | Gate |
|---|---|---|---|
| M0 | Spikes | S1–S5 ([testing-spikes](./plans/testing-spikes.md)) | 5,000 elements @ 60 fps; Arabic server render OK or fallback chosen; extraction default, models and embedding chosen; deploy dry-run (WS + SSE behind basic auth) works |
| M1 | Core editor | `packages/core` (schemas, store, ops, undo, bounds, R-tree), renderer + camera, select/transform, shapes + bound arrows, text with RTL, local save (IndexedDB) | Shapes, Arabic + Latin text, undo, local save |
| M2 | Math and images | `renderMath()` + live LaTeX box, image element (upload, crops, caches), camera `flyTo` + pulse primitives | Math and images crisp at every zoom; math security tests pass |
| M3 | Server | WebSocket gateway, Board service (seq, validate, apply), SQLite log + snapshots + migrations, blobs on disk, snapshot renderer, access gate + Origin checks, systemd + Caddy deploy scripts, **first VPS deploy** | Two tabs stay in sync; survives restart; VPS reachable only through the gate; server PNG matches browser |
| M4 | Library | Upload, estimate/preview, extraction ladder, structure, chunks, embeddings, summaries, hybrid search API, library UI, source panel, eval runner | Retrieval eval target met on a real book |
| M5 | **Tutor slice** | Chat dock (§9), board-context builder + chips + browser-side pictures (§10), agent loop, tool registry, prompts + scope packs + caching, citations, placement, `add_diagram`, `add_book_figure`, jump-to-AI (§13), turn undo, budgets, stub tutor | End-to-end script in [testing-spikes](./plans/testing-spikes.md) passes |
| M6 | Ink, charts, polish | Pen / highlighter / eraser, charts (bar, line, area, pie, donut, scatter + data grid), `arrange`, group, snap | Student can handwrite; AI can chart |
| M7 | Hardening | Performance pass, security review, accessibility outline panel, backup drill, **optional MCP adapter** (tokens, `/mcp`) | Benchmarks + checklist pass |

**First usable tutor at the end of M5.** M4 does not depend on M1–M3, so the library and canvas tracks can overlap if two tracks of work run in parallel, which brings the library forward. If handwriting matters more than the first tutor demo, swap the pen half of M6 into M1.

---

## 18. Spikes, tests, verification → [plans/testing-spikes.md](./plans/testing-spikes.md)

Five M0 spikes: **S1** canvas performance + Arabic/MathJax on a server canvas; **S2** ingestion on your real books; **S3** OpenRouter loop (tools, images in tool results, caching, streaming cost, Arabic quality, privacy flag); **S4** embeddings + exact-search latency; **S5** deploy dry-run (WebSocket and SSE behind Caddy basic auth, better-sqlite3 and `@napi-rs/canvas` on the VPS). Top risks: canvas text editing, Arabic server shaping, PDF math/Arabic extraction, board clutter, wrong-page retrieval, cost surprise, AI SDK/model churn, prompt injection. Verification: engine benchmark and golden images, `pnpm eval:retrieval` (target: expected page in top 8 for ≥ 80%), tutor end-to-end with `TUTOR_STUB=1`, jump-to-AI scenarios, board-context scenarios, cache/cost checks, deploy and backup drills.

---

## 19. Decisions I made, and what I need from you

**Decisions (override any)**
1. **SQLite** (better-sqlite3 13, WAL) + FTS5 + exact in-memory cosine search instead of Postgres + pgvector, because of R1. `sqlite-vec` is the upgrade path; the Postgres revert path is in [database](./plans/database.md).
2. **Native deploy:** systemd + Caddy; deploy by `git pull` + `pnpm build`; automatic DB backup before migrations.
3. Next.js + NestJS kept as in the doc (a static export or Vite SPA served by Caddy is an optional M0 simplification).
4. In-app tutor via AI SDK 7 + Meta Model API (`@ai-sdk/openai-compatible`, `META_API_KEY`) behind one adapter module (`OPENROUTER_API_KEY` retained strictly for `baai/bge-m3` embeddings and M0 spike benchmarks).
5. **The chat dock is the only AI entry point in v1;** the MCP endpoint is optional M7 and the tool registry is built for it from day one.
6. **Board context:** digest always; selection default = structure + picture; viewport and whole board are opt-in; pictures rendered in the browser; selection grants edit rights for that turn.
7. Milestones re-sequenced: tutor slice before pen and charts.
8. Access gate = Caddy basic auth + Origin checks; none on localhost.
9. Embedding default `baai/bge-m3`; model defaults in [ai-integration](./plans/ai-integration.md); whole-chapter stuffing ≤ 60k tokens.
10. Op metadata and payloads kept forever in v1; no blob garbage collection in v1.
11. `add_image` from URLs dropped; book-page crops added; `add_diagram` and three book tools added.
12. Snapshot paths: context pictures rendered in the browser; AI-requested snapshots server canvas → open tab → headless Chromium.
13. Tutor edit rights limited to its own elements plus the student's selection for that turn.
14. v1 is PDF-only; EPUB / Markdown / TXT come in v1.1 (schema has nullable page fields and `cite_label`).
15. Upload limits: 200 MB / 2,000 pages; answers follow the question's language.
16. Plan split into the 14 files above (my breakdown; merge or split freely).
17. **Spend ledger and daily cap ship in M4,** because paid ingestion rungs must respect the cap ([auth-security](./plans/auth-security.md)); per-turn caps, the usage view and the top-bar spend land in M5. (Roadmap seam 1.)
18. **The handwriting step of the board-context script, and the freehand auto-picture rule, are verified at M6,** when the pen lands; the M5 gate runs the script with text and shape selections. (Seam 2.)
19. **M5 registers 15 of the 18 tools;** `add_chart`, `draw_stroke` and `arrange` register in M6 with their elements. (Seam 3.)
20. **M4 splits into 4a (ingestion core, `pnpm ingest`, eval runner) and 4b (REST, library UI, source viewer).** This refines §17's "M4 does not depend on M1–M3": 4a needs only M3's persistence layer (`db/` module, migrations, blob store); 4b needs M3's server and the web shell. The source viewer is built in M4 and mounted as the chat dock's Source tab in M5. (Seams 4 and 5.)
21. **M2 image bytes live in IndexedDB, keyed by content hash** (the scheme `blobs.id` uses), until M3 provides `/api/blobs`. M1–M2 local boards are throwaway; there is no import path. (Seam 6.)
22. **[ROADMAP.md](./ROADMAP.md) holds the per-phase detail;** §17 stays the contract for order and gates.
23. **MathJax lives in `packages/math`, not `packages/core/math`;** `renderMath()` is async with a sync `peekMath()` cache lookup (S1 needed MathJax's `convertPromise`). `core` stays zod-only and reaches math through a `Platform.math` provider. (M2 grill, Q7 and Q8.)
24. **`RenderCache` is sized from the device** (fraction of `deviceMemory`, 128 to 512 MB), shared by text, math and image bitmaps, replacing M1's fixed 1 GiB. (Q2.) **Measured in M2 (open, `needs-user-decision` in [`bench/RESULT.md`](../apps/web/src/bench/RESULT.md)):** on a Mac Chrome reports `deviceMemory` 8 (its maximum), so the cap is 491.5 MB, and a dense 5,000-text scene at DPR 2 then zooms at 1.6 fps (M1, 1 GiB: 35.4 fps) because its working set is about 742 MB. Realistic scenes (200 text, 200 math, 50 large images) hold 60 fps at 28 to 212 MB.
25. **Arabic inside math is an error, not a mis-shaped render** (F14 closed: `latin-only`, enforced for the whole input); the message tells the tutor to use a separate text element. (Q3.)
26. **Image import:** PNG, JPEG, WebP, GIF (first frame); SVG rejected; ≤ 10 MB; long edge ≤ 4096 px; SHA-256 dedupe; bytes through a `BlobStore` (IndexedDB now, `/api/blobs` in M3). **Crop is non-destructive** (`data.crop`, source pixels). (Q4, Q5, Q12.)
27. **`flyTo` and `pulse` are view state:** never in ops, undo or snapshots. The Back chip and Follow AI stay in M5. (Q9.)
28. **The TeX package list drops `noundefined`,** so undefined control sequences (`\href`, `\require`, …) throw and `renderMath` returns the message; math bitmaps beyond 4096 px draw as `Path2D` vectors. (Planning calls P1 and P6 in the M2 task plan.)
29. **M0 spikes (S1–S4) closed:**
    - **S1:** main-thread rendering with cached bitmaps (`OffscreenCanvas` worker was slower); `rbush` and `perfect-freehand` kept; `@napi-rs/canvas` server snapshots with bundled `IBM Plex Sans Arabic`.
    - **S2:** R1 (`pdfjs-dist`, stripping raw `\x00–\x1F` and PUA `\uE000–\uF8FF`) for text PDFs; R2 (`cloudflare-ai`) dropped; R3 (`mistral-ocr`, `$0.0205` / 10 pages, one `text` element per page in `annotations[0].file.content` between `<file>` and `</file>`) and R4 (`gemini-3.8-flash`) benchmarked on scanned/Arabic/math-dense pages; slice PDFs with `pdf-lib` `copyPages`.
    - **S3:** OpenRouter streaming step cost (`providerMetadata.openrouter.usage.cost`), 1 h prompt cache, `tool-result-image` (`toModelOutput` with `file` part), and `data_collection: "deny"` verified across `google/gemini-3.8-flash` (Arabic tutor), `anthropic/claude-haiku-5.5` (English tutor + `cheap`), `anthropic/claude-sonnet-5.5` (optional reviewer), and `openai/gpt-6-luna` (dropped on Arabic).
    - **S4:** `baai/bge-m3` (`EMBED_DIMS = 1024`, `k = 8`), exact in-memory cosine search (`0.51 ms` p95 at 600 chunks, `83.6 ms` p95 / `390.6 MiB` at 100k chunks), `100%` vector@8 (`MRR 0.947`), `93.3%` hybrid@8 (`96.7%` with `±1` neighbours) across `ck12`, `alg1` and `arabic`; retry `429`/`5xx` with backoff. S5 (VPS deploy dry-run) stays deferred.
30. **Post-M0 provider switch to Meta Model API (2026-11-02):** All runtime LLM and vision calls now target the **Meta Model API** (`META_API_KEY`, `META_API_BASE_URL=https://api.meta.ai/v1` via `@ai-sdk/openai-compatible`) using hosted Meta models (`muse-spark-1.3` for `TUTOR_MODEL`, `TUTOR_MODEL_AR`, `TUTOR_FALLBACK_MODEL`, `CHEAP_MODEL`, `VISION_MODEL`; `muse-wonder-1.0` for `REVIEWER_MODEL`; open-weights `meta-llama/llama-4-maverick` supported via OpenRouter). Scanned/math PDF pages after R1 route directly to R4 (`VISION_MODEL` via Meta Model API), step token usage is reported via streaming `usage` in `llm.ts`, `SNAPSHOT_ADAPTER=follow-up-user` is used since `api.meta.ai` rejects image data in tool result messages, and `OPENROUTER_API_KEY` is retained strictly for `baai/bge-m3` embeddings (`POST /api/v1/embeddings`) and the M0 benchmark scripts.
31. **No NestJS (ruling R1):** The server is built directly on Node's standard `node:http` and `ws` package. NestJS was dropped for zero runtime overhead, minimal external dependencies, and direct typed routing.
32. **Local mode stays (ruling R2):** The web client keeps its offline-first / local storage mode when `NEXT_PUBLIC_API_BASE` is unset. Setting `NEXT_PUBLIC_API_BASE` (e.g. `http://localhost:4000`) switches cleanly to server mode with WebSocket sync and HTTP blob storage.
33. **Forward-only database migrations (ruling R3):** Migrations are sequential SQL files (`apps/server/migrations/*.sql`) run inside a transaction on startup, tracked via `PRAGMA user_version`. Before any pending migration is applied, the server performs an automated online copy via `VACUUM INTO 'backups/pre-migrate-*.db'`.
34. **Blobs on disk and raw binary upload (ruling R4):** Blobs live in `DATA_DIR/blobs/<id[0:2]>/<id[2:4]>/<id>`, keyed by SHA-256 hex digest. `POST /api/blobs` accepts the raw binary payload directly with a validated `Content-Type` header (avoiding multipart parsing overhead), enforces size and dimension limits, and streams writes to disk.
35. **Access gate is Caddy basic_auth on VPS; loopback + Origin locally (ruling R5):** The shared secret gate on a VPS is Caddy `basic_auth` (configured in `deploy/Caddyfile`). Locally, the gate is loopback binding (`127.0.0.1`) combined with strict `Origin` and `Host` validation.
36. **Human undo stays client-side (ruling R6):** The client's `UndoManager` computes inverses and submits them as new batches to the server. Server-side `undo`, `agent_status`, `agent_focus`, and `render_request` / `render_response` are deferred to M5/M6 when the AI tutor arrives.
37. **All-dropped batches are acked but not stored (ruling R7):** If every op in a batch is dropped (e.g. a patch to an element that was deleted by another client), the server acks with the current `seq` and does not store or broadcast a no-op batch.
38. **Editor editable while disconnected; local queue resends (ruling R8):** When the WebSocket disconnects, the editor remains interactive; outbound batches queue in memory and resend upon reconnection. An in-app notice warns that changes are not saved until reconnected.
39. **M4a tables in initial migration (ruling R9):** In line with ROADMAP's rule of having a complete schema from day one, `0001_init.sql` includes `books`, `book_sections`, `book_pages`, `book_chunks`, and FTS5 tables, but M4 code remains out of M3.
40. **Server-enforced limits (ruling R10):** The server enforces ops per batch ≤ 500, elements per board ≤ 50,000, and coordinate bounds (`x`, `y`, `w`, `h` and stroke points) within ±1,000,000 and finite. Core's limits stay as M1 set them (stroke points ≤ 10,000, text ≤ 100,000 chars, LaTeX ≤ 4,000 chars).
41. **Host header validation / DNS rebinding protection:** All HTTP requests (including preflight and GET) and WebSocket upgrades validate the `Host` header against loopback addresses, the configured `PUBLIC_ORIGIN`, and optional bind address. URL-encoded host spoofing (e.g. `evil.test@localhost`) is rejected before hostname extraction.
42. **Declared image size & decompression bomb protection:** Image dimensions are validated strictly from file headers before allocating buffers, decoding, or storing blobs. Images exceeding 8192 px on any side or 40 megapixels total are rejected with 413. The snapshot renderer limits concurrent decodes to 2 and safely treats missing/oversized blobs without failing the export.
43. **M4 library: how it is built (2026-11-03).** Providers are plain `fetch` behind one injectable `Providers` interface (`apps/server/src/library/providers.ts`; the AI SDK arrives with M5's `tutor/llm.ts`). A PDF is uploaded as a raw streamed body (`POST /api/books?title=`, `Content-Type: application/pdf`, ≤ 200 MB, ≤ 2,000 pages, `%PDF-` in the first KB), hashed while it streams into the blob layout. Default routing per page: R1 (`pdfjs-dist`) for pages with ≥ 50 characters and ≤ 5% math symbols, **R4 (`muse-spark-1.3`, concurrency 4, `max_tokens` 12,000, one retry at 24,000 when cut off)** for scans and math-dense pages; **R3 (`mistral-ocr`) only when the student names pages for it**; R2 stays dropped. Only OpenRouter calls (embeddings, R3) are priced and enter the `spend` ledger and the `DAILY_BUDGET_USD` check (UTC day); Meta calls are neither priced nor ledgered. A job is an in-process sequential queue; its work runs on a worker thread (own SQLite connection, ≤ 200-row transactions) and every stage resumes from what is stored. Sections come from the PDF outline, or fixed 20-page sections when there is none or it has about one bookmark per page; summaries (leaf, then parents, `CHEAP_MODEL`) are best effort and never fail a book. Search is FTS5 top 30 + exact vectors top 30 fused by reciprocal rank (k = 60), keyword-only when the embedding call is unavailable. No cancel route and no R3 preview: nothing paid runs before `POST …/index`. The source viewer shows the server's cached page raster (`/pages/:n/image`), not `pdfjs-dist` in the browser. Books left mid-job by a restart are marked failed at startup so they can be retried.
44. **M4 live findings (2026-11-03).** (a) `pdfjs-dist` 5.7 needs `wasmUrl` to decode JBIG2 and JPEG 2000: the Arabic scan (JBIG2, 300 ppi) rendered **blank** in Node, Muse saw white pages and 367 of 383 pages were stored empty while the book still reached `ready`. Fixed, with a regression test on the real scan, and a guard now fails a book whose R4 pages are mostly empty and clears them so a retry reads them again. (b) The local `.env` still named a Llama model for `VISION_MODEL`; `api.meta.ai` serves only the Muse models and answers 404 for it, so `.env` must say `muse-spark-1.3` as `.env.example` does. (c) pdfjs v5 dropped the `isEvalSupported` option. (d) Retrieval on the real books after ingestion with these defaults: see [testing-spikes](./plans/testing-spikes.md#m4-results).
43. **Header-vs-decoder differential protection & fail-closed parsing:** Image parsers refuse malformed structures where decoders could diverge from declared dimensions: GIF requires all frame rectangles to fit within the logical screen and fails closed if the block iteration cap (200,000) is reached; JPEG rejects multiple SOF markers; WebP verifies VP8X canvas matches the inner still frame; and the server canvas export re-checks decoded bitmap dimensions against the same bounds.
45. **M5 tutor: how it is built (2026-11-03).** `ai@7.0.159` + `@ai-sdk/openai-compatible@3.0.82` (exact pins; the docs' "2.x" was wrong) in `apps/server`, all behind `tutor/llm.ts`; the web app uses `ai` only (`DefaultChatTransport`, `readUIMessageStream`), **no `@ai-sdk/react`** (this closes "the transport sends only the new message"). One turn per board (in-memory lock taken before the first await), caps `MAX_STEPS`, `TURN_TIMEOUT_MS` (120 s) and, when priced, `MAX_TURN_COST_USD`; `turn_busy` and `budget_exceeded` are plain 4xx before any byte streams, later failures are stream `error` parts with the api.md code; Stop closes the fetch, aborts the model call, stores what was said and drawn, and frees the lock. The stream opens with `start` (message id `<turnId>:a`) before any data part. A 5xx before output is retried once on `TUTOR_FALLBACK_MODEL` by a model wrapper. `TUTOR_STUB=1` swaps only the model for `MockLanguageModelV4` fed by `apps/server/test/fixtures/tutor/*.json` (`$BOOK_ID`, `$PAGE_0` placeholders; the last step repeats, so one tool-call step is a runaway loop), with a stub-only `GET /api/_test/last-request`. 15 tools (`get_board get_elements get_snapshot add_text add_math add_shape connect add_diagram add_book_figure update_elements delete_elements focus_region get_outline search_book read_section`): board tools are pure builders in `packages/core/src/tools`, book/figure/snapshot tools live on the server; a turn's tool calls run one at a time. `add_diagram` is a hand-written layered layout (no dagre). Snapshots reach the model as a follow-up user message (Meta rejects images in tool results).
46. **Citations are page-based:** `[p. LABEL](cite:<bookId>#<page>)` (book ids are UUIDs here). The server announces every page range the model was shown as a `data-source` part (the scope pack at turn start, each `search_book` hit, each `read_section`); the dock links only those pages and the server rewrites any other `cite:` link to its plain text when it saves the message (`unverifiedCites` in the footer). This replaces `cite:<chunkId>`.
47. **Turn undo is server-side and survives a restart (R3):** migration `0002` adds `board_ops.inverse` (agent batches only); `POST /api/boards/:id/turns/:turnId/undo` and `…/batches/:batchId/undo` feed the stored inverses, newest first, to core's `UndoManager` (its conflict rule skips steps the student changed since, reported as `skipped`) and submit them as new batches by the student with `preserveAuthor`, so a re-added element keeps its tutor author; an undone batch is remembered. Replaces the deferred WebSocket `undo`.
48. **No new WebSocket message types:** `ops` broadcasts already carry `author`, `turnId` and `bounds` (the sync client now passes them on). Follow AI, the off-screen arrow and live Activity rows are driven by agent-authored `ops`; `agent_status` is a `data-status` part on the chat stream; `agent_focus` and `render_request/response` are not built.
49. **Edit rights are enforced in `BoardService.submit`** (`agentMayEdit` from core): for an agent author a `patch`/`remove`/`reorder` is refused unless the element is the tutor's own or was selected when the turn began; `locked` is never changed; `add` always passes. Tools pre-check for a friendlier message, and the side effects of a tool (re-routing or unbinding arrows) obey the same rule (a security review caught this once).
50. **Pricing is optional:** Meta publishes no price, so a turn is unpriced by default (`costUsd: null`): the footer and the usage view show tokens, USD only when `TUTOR_PRICE_IN_PER_M`/`TUTOR_PRICE_OUT_PER_M` are set; a `spend` row (`kind: 'turn'`) and `MAX_TURN_COST_USD` apply only then. `TUTOR_REASONING_EFFORT` (low/medium/high) is passed as `reasoning_effort` when set: api.meta.ai accepts it (probed 2026-11-03; effect on a one-word answer was within noise), default off.
51. **Memory and the cap override:** the last 8 turns (16 messages) go in verbatim; past ~8,000 tokens of older history `CHEAP_MODEL` writes a rolling summary (settings `memory:<boardId>`, best effort, after the turn). `PUT /api/settings` stores the student profile (in the cached prefix) and a `dailyBudgetUsd` override that the tutor and the library REST checks honour (not the ingest worker thread).
52. **M5 findings and closed decisions (2026-11-03).** (a) Turbopack cannot parse a variable named `of` (`for (const of of …)`) though TypeScript can. (b) `readUIMessageStream` needs a `start` chunk before any data part. (c) Muse needs 15–25 s per step, so a real multi-step turn can hit the 120 s wall clock: set `TURN_TIMEOUT_MS` higher for live runs. (d) Closed: the whole-book cached prompt is **not built** (off); the Ask AI keyboard shortcut is **none**; the right-click Ask AI menu is **not built** (the selection toolbar's button is). Not built, noted: per-cluster picture crops, "regions" digest summaries, the reviewer model pass, `add_chart`/`draw_stroke`/`arrange` and the freehand auto-picture rule (M6).
53. **After the M5 gate (2026-11-03): UI overhaul, New chat, spend chip.** (a) Tailwind CSS 4 (`tailwindcss`, `@tailwindcss/postcss`, `postcss`, exact pins; no `autoprefixer`, Tailwind 4 prefixes itself) now styles the toolbar, dock, chat and library pages; the canvas is unaffected. (b) `POST /api/boards/:id/chat/reset` (_New chat_) hides the board's earlier messages and drops its rolling summary: the messages stay in the database, the board is untouched ([api](./plans/api.md), [chat-ui](./plans/chat-ui.md)). (c) The top-bar spend chip is hidden on purpose; the component and the usage endpoints stay. (d) `biome.json` turns `a11y/noSvgWithoutTitle` off for the icon set: revisit in the M7 accessibility pass. (e) `packages/core/src/text.test.ts` "10,000-char single word" has a 1 s bound that a loaded machine exceeds (1.07 to 1.34 s, passes alone): revisit in the M7 performance pass.

**Inputs I need before M0** (not now)
1. 2–3 real books as PDFs (tell me if any are EPUB and I will pull EPUB into M4): one text-heavy, one math/diagram-heavy, and an Arabic one if relevant, plus ~10 questions per book with the page where each answer lives. This is also the retrieval eval set.
2. *(Optional, deferred; local app first)* VPS plan: provider, a Debian or Ubuntu LTS image (not Alpine: native modules ship glibc binaries), and a domain (or Tailscale).
3. Your `META_API_KEY` (for Meta Model API LLM/vision calls) and `OPENROUTER_API_KEY` (for `baai/bge-m3` embeddings) in the server `.env` only, with spend limits set on the keys.

---

## 20. Next steps

1. **Done 2026-11-01:** `docs/PLAN.md` (this file), `docs/plans/*` (14 aspect files), `README.md`, `.gitignore`. `git init` on `main`, nothing committed.
2. Offer: export the Claude Doc to `docs/engine-design.md` and record your five answers in its Open questions section. I have not edited the Claude Doc.
3. Write M0's task-level implementation plan (superpowers:writing-plans), then start S1, S3 and S5 (they need no books), then S2 and S4 once the books arrive.
