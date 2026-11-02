# Whiteboard AI — Study Companion: Validation and Full Plan

> **Hackathon:** Built for the **[Meta AI Developer Hackathon](https://cerebralvalley.ai/e/meta-ai-developer-hackathon)** hosted by **Meta** and **Cerebral Valley**.
> **Status:** revision 1 approved 2026-11-01 · **revision 2** (same day, awaiting your review): no Docker, in-app chat, whiteboard as AI context, plan split into one file per aspect, README added.
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

**Hackathon alignment.** Built specifically for the **[Meta AI Developer Hackathon](https://cerebralvalley.ai/e/meta-ai-developer-hackathon)** (Meta × Cerebral Valley). Whiteboard AI tackles visual, multimodal AI education: an interactive whiteboard where Meta's Llama models (e.g. Llama 3.3 70B for tool loop reasoning, Llama 3.2 Vision for canvas & diagram inspection) act as a personal tutor explaining complex textbooks with formulas, diagrams, and verifiable page citations.

**Context.** The design doc specifies a from-scratch infinite canvas plus 16 MCP tools, and assumes an *external* AI client does the thinking. The product is now a **study companion**: a student uploads books, picks a topic / chapter / whole book, and chats with an AI tutor that explains on a shared whiteboard with page citations. This plan (1) validates the doc against that product and your answers, and (2) adds what is missing.

- **The engine design is sound and mostly stays.** Your answers delete a lot of it: accounts, roles, JWT, OAuth, Redis, S3, multi-instance, and now Docker and Postgres.
- **Biggest gap:** no built-in AI. A tutor needs a chat dock in the UI and a server-side agent loop over OpenRouter (§8–9), the whiteboard as its context (§10), a book library with hybrid retrieval (§11–12), and jump-to-AI-work (§13).
- **"No login" is fine on localhost, not on a VPS** that holds your OpenRouter key and your books. One shared-secret gate fixes it (§16).
- **Re-sequenced** so a usable tutor lands at ≈ week 15 of ≈ 20 full-time-engineer weeks. The doc's 14 weeks covered engine + MCP only (§17).
- **I need from you before M0** (not now): 2–3 real books and ~10 questions per book (§19).

---

## 1. Validation of the design doc

### 1.1 Verdict

**Sound as an engine spec; incomplete as a product spec.** I cross-checked the doc against itself (schemas ↔ tools ↔ tables ↔ roadmap ↔ diagrams), your answers, and the new brief. Ops, undo, renderer, element model and sync are coherent; I would build them as written. Missing: everything that makes this a study companion, plus one security hole that "no login" opens. I did not build or benchmark anything: the performance claims, Arabic shaping on a server canvas, and the 1-week M0 are unverified, which the doc itself acknowledges by making M0 the gate.

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
| F8 | Med | Roadmap | M0 (renderer, camera, R-tree, pen, headless-render test, 5,000-element benchmark) in one week is tight; the estimates assume one full-time engineer. | M0 = 2 weeks incl. AI, ingestion and deploy spikes; gates by evidence (§17) |
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
SQLite file (WAL) + blobs on disk        OpenRouter (chat + tools + vision,
 under DATA_DIR                           embeddings, PDF parser) — key lives only here
```

Human ops (WebSocket) and tutor ops (in-process) enter the **same** Board service, so they share validation, ordering, undo and broadcast. Repo layout and stack: [tech-stack](./plans/tech-stack.md).

---

## 4. Tech stack → [plans/tech-stack.md](./plans/tech-stack.md)

TypeScript + pnpm workspace (`packages/core`, `apps/web`, `apps/server`). Next.js 16 (client-only editor), NestJS 12, SQLite via better-sqlite3, zod 4, AI SDK 7 + OpenRouter provider, MathJax 4, `@napi-rs/canvas`, `pdfjs-dist`, dagre. Versions checked on npm 2026-11-01. pnpm only (no npm/yarn/`npx`). No Docker, no database server, no queue.

## 5. Run and deploy, no Docker → [plans/deployment.md](./plans/deployment.md)

- **Local:** Node 22 + pnpm. `pnpm install`, copy `.env.example`, `pnpm dev`. Data in `./data` (SQLite + blobs).
- **VPS:** Debian/Ubuntu LTS, Node 22, Caddy (TLS + basic auth), two systemd units (server, web). Deploy = `git pull` → `pnpm install --frozen-lockfile` → `pnpm build` → `systemctl restart`.
- Migrations run at startup after an automatic DB backup; nightly online backup + blobs sync; one restore drill in M7.

## 6. Whiteboard engine → [plans/whiteboard-engine.md](./plans/whiteboard-engine.md)

The design doc stays the base (digest kept in the file so the repo is self-contained). Deltas: a platform adapter for `render()` (F4), the same fonts on web and server (F5), snapshot paths (browser-rendered pictures for context; server canvas → open tab → headless Chromium for AI-requested snapshots), no human presence or live ink (F10), agent events (`agent_focus`, `agent_status`), and the edit-rights guard.

## 7. Math renderer → [plans/math-renderer.md](./plans/math-renderer.md)

LaTeX in, MathJax v4 TeX → SVG → cached bitmap out; the same `renderMath()` serves canvas elements, chat messages, the source panel and server snapshots. Package allowlist (no `\href`, `\url`, `\require`, `\class`, `\style`), errors that teach the tutor, golden-image and security tests.

## 8. AI integration (tutor agent) → [plans/ai-integration.md](./plans/ai-integration.md)

OpenRouter only; key server-side. AI SDK 7 tool loop behind one adapter module; one tool registry in `packages/core` (18 tools: board read/write, `add_diagram`, `add_book_figure`, book tools) with an AI SDK adapter now and an MCP adapter later. Every write = one labelled batch stamped with the turn. Caps per turn and per day, edit-rights guard, snapshots to the model as follow-up images, prompt caching, fallback model, stub tutor for tests. Models are env vars.

## 9. In-app chat UI → [plans/chat-ui.md](./plans/chat-ui.md)

A resizable chat dock on the board page (tabs: Chat · Activity · Source). Streaming Markdown + LaTeX, tool-call chips with Locate, `cite:` and `board:` links, Stop, Undo response, per-turn cost, quick actions (Explain · Summarise · Check my work · Ask), and a composer with **context chips** (Selection · Viewport · Whole board) plus image paste.

## 10. Whiteboard as AI context → [plans/board-context.md](./plans/board-context.md)

Every turn includes a budgeted **board digest** (header, counts, viewport, selection, element list). The student can attach the **selection** (default when something is selected: structure + picture), the **viewport** or the **whole board**, each as structure, picture or both. Pictures are rendered in the browser and uploaded as blobs. Freehand content auto-attaches a picture. A "What the AI sees" preview shows the exact digest and thumbnails. The selection also grants the AI permission to edit those elements for that turn.

## 11. Library and ingestion → [plans/library-ingestion.md](./plans/library-ingestion.md)

PDF-only v1. Upload → estimate and preview → index. Extraction ladder R1 (local `pdfjs-dist`) → R3 (OpenRouter `mistral-ocr`, $2/1,000 pages) for scans and math-dense pages → R4 (vision transcription) as the fallback for pages R3 gets wrong, routed per page (S2 dropped the free `cloudflare-ai` rung). Structure from the PDF outline with printed page labels. Heading-aware chunks, multilingual embeddings via OpenRouter, FTS5 index, bottom-up summaries. Ingestion runs in a worker thread; steps are resumable.

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

> Detailed roadmap (scope, dependencies, gates, acceptance scripts, risks and status per phase): [ROADMAP.md](./ROADMAP.md). It mirrors the weeks and gates in this table; if they differ, this table wins until both are updated.

Estimates are full-time-engineer weeks as in the doc, ±30%; re-estimate after M0.

| # | Milestone | Wks | Builds | Gate |
|---|---|---|---|---|
| M0 | Spikes | 2 | S1–S5 ([testing-spikes](./plans/testing-spikes.md)) | 5,000 elements @ 60 fps; Arabic server render OK or fallback chosen; extraction default, models and embedding chosen; deploy dry-run (WS + SSE behind basic auth) works |
| M1 | Core editor | 2.5 | `packages/core` (schemas, store, ops, undo, bounds, R-tree), renderer + camera, select/transform, shapes + bound arrows, text with RTL, local save (IndexedDB) | Shapes, Arabic + Latin text, undo, local save |
| M2 | Math and images | 1.5 | `renderMath()` + live LaTeX box, image element (upload, crops, caches), camera `flyTo` + pulse primitives | Math and images crisp at every zoom; math security tests pass |
| M3 | Server | 2.5 | WebSocket gateway, Board service (seq, validate, apply), SQLite log + snapshots + migrations, blobs on disk, snapshot renderer, access gate + Origin checks, systemd + Caddy deploy scripts, **first VPS deploy** | Two tabs stay in sync; survives restart; VPS reachable only through the gate; server PNG matches browser |
| M4 | Library | 2.5 | Upload, estimate/preview, extraction ladder, structure, chunks, embeddings, summaries, hybrid search API, library UI, source panel, eval runner | Retrieval eval target met on a real book |
| M5 | **Tutor slice** | 4 | Chat dock (§9), board-context builder + chips + browser-side pictures (§10), agent loop, tool registry, prompts + scope packs + caching, citations, placement, `add_diagram`, `add_book_figure`, jump-to-AI (§13), turn undo, budgets, stub tutor | End-to-end script in [testing-spikes](./plans/testing-spikes.md) passes |
| M6 | Ink, charts, polish | 2.5 | Pen / highlighter / eraser, charts (bar, line, area, pie, donut, scatter + data grid), `arrange`, group, snap | Student can handwrite; AI can chart |
| M7 | Hardening | 2 | Performance pass, security review, accessibility outline panel, backup drill, **optional MCP adapter** (tokens, `/mcp`) | Benchmarks + checklist pass |

**Total ≈ 19.5 weeks; first usable tutor at the end of M5 ≈ week 15** (doc: 14 weeks for engine + MCP). M4 does not depend on M1–M3, so the library and canvas tracks can overlap if you have the capacity, pulling the tutor slice to roughly week 11–12 on the calendar. If this is a part-time side project, scale calendar time accordingly. If handwriting matters more than the first tutor demo, swap the pen half of M6 into M1.

---

## 18. Spikes, tests, verification → [plans/testing-spikes.md](./plans/testing-spikes.md)

Five M0 spikes: **S1** canvas performance + Arabic/MathJax on a server canvas; **S2** ingestion on your real books; **S3** OpenRouter loop (tools, images in tool results, caching, streaming cost, Arabic quality, privacy flag); **S4** embeddings + exact-search latency; **S5** deploy dry-run (WebSocket and SSE behind Caddy basic auth, better-sqlite3 and `@napi-rs/canvas` on the VPS). Top risks: canvas text editing, Arabic server shaping, PDF math/Arabic extraction, board clutter, wrong-page retrieval, cost surprise, AI SDK/model churn, prompt injection. Verification: engine benchmark and golden images, `pnpm eval:retrieval` (target: expected page in top 8 for ≥ 80%), tutor end-to-end with `TUTOR_STUB=1`, jump-to-AI scenarios, board-context scenarios, cache/cost checks, deploy and backup drills.

---

## 19. Decisions I made, and what I need from you

**Decisions (override any)**
1. **SQLite** (better-sqlite3 13, WAL) + FTS5 + exact in-memory cosine search instead of Postgres + pgvector, because of R1. `sqlite-vec` is the upgrade path; the Postgres revert path is in [database](./plans/database.md).
2. **Native deploy:** systemd + Caddy; deploy by `git pull` + `pnpm build`; automatic DB backup before migrations.
3. Next.js + NestJS kept as in the doc (a static export or Vite SPA served by Caddy is an optional M0 simplification).
4. In-app tutor via AI SDK 7 + OpenRouter provider behind one adapter module.
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
22. **[ROADMAP.md](./ROADMAP.md) holds the per-phase detail;** §17 stays the contract for weeks and gates.
23. **MathJax lives in `packages/math`, not `packages/core/math`;** `renderMath()` is async with a sync `peekMath()` cache lookup (S1 needed MathJax's `convertPromise`). `core` stays zod-only and reaches math through a `Platform.math` provider. (M2 grill, Q7 and Q8.)
24. **`RenderCache` is sized from the device** (fraction of `deviceMemory`, 128 to 512 MB), shared by text, math and image bitmaps, replacing M1's fixed 1 GiB. (Q2.)
25. **Arabic inside math is an error, not a mis-shaped render** (F14 closed: `latin-only`, enforced for the whole input); the message tells the tutor to use a separate text element. (Q3.)
26. **Image import:** PNG, JPEG, WebP, GIF (first frame); SVG rejected; ≤ 10 MB; long edge ≤ 4096 px; SHA-256 dedupe; bytes through a `BlobStore` (IndexedDB now, `/api/blobs` in M3). **Crop is non-destructive** (`data.crop`, source pixels). (Q4, Q5, Q12.)
27. **`flyTo` and `pulse` are view state:** never in ops, undo or snapshots. The Back chip and Follow AI stay in M5. (Q9.)
28. **The TeX package list drops `noundefined`,** so undefined control sequences (`\href`, `\require`, …) throw and `renderMath` returns the message; math bitmaps beyond 4096 px draw as `Path2D` vectors. (Planning calls P1 and P6 in the M2 task plan.)
29. **M0 spikes (S1–S4) closed:**
    - **S1:** main-thread rendering with cached bitmaps (`OffscreenCanvas` worker was slower); `rbush` and `perfect-freehand` kept; `@napi-rs/canvas` server snapshots with bundled `IBM Plex Sans Arabic`.
    - **S2:** R1 (`pdfjs-dist`, stripping raw `\x00–\x1F` and PUA `\uE000–\uF8FF`) for text PDFs; R2 (`cloudflare-ai`) dropped; R3 (`mistral-ocr`, `$0.0205` / 10 pages, one `text` element per page in `annotations[0].file.content` between `<file>` and `</file>`) for scanned/Arabic/math-dense pages; R4 (`gemini-3.8-flash`) fallback; slice PDFs with `pdf-lib` `copyPages`.
    - **S3:** OpenRouter streaming step cost (`providerMetadata.openrouter.usage.cost`), 1 h prompt cache, `tool-result-image` (`toModelOutput` with `file` part), and `data_collection: "deny"` verified; `google/gemini-3.8-flash` (Arabic tutor), `anthropic/claude-haiku-5.5` (English tutor + `cheap`), `anthropic/claude-sonnet-5.5` (optional reviewer), plus Meta Llama hackathon config.
    - **S4:** `baai/bge-m3` (`EMBED_DIMS = 1024`, `k = 8`), exact in-memory cosine search (`0.51 ms` p95 at 600 chunks, `83.6 ms` p95 / `390.6 MiB` at 100k chunks), `100%` vector@8 (`MRR 0.947`), `93.3%` hybrid@8 (`96.7%` with `±1` neighbours) across `ck12`, `alg1` and `arabic`; retry `429`/`5xx` with backoff. S5 (VPS deploy dry-run) stays deferred.

**Inputs I need before M0** (not now)
1. 2–3 real books as PDFs (tell me if any are EPUB and I will pull EPUB into M4): one text-heavy, one math/diagram-heavy, and an Arabic one if relevant, plus ~10 questions per book with the page where each answer lives. This is also the retrieval eval set.
2. *(Optional, deferred; local app first)* VPS plan: provider, a Debian or Ubuntu LTS image (not Alpine: native modules ship glibc binaries), and a domain (or Tailscale).
3. Your OpenRouter key in the server `.env` only, with a credit limit set in OpenRouter.

---

## 20. Next steps

1. **Done 2026-11-01:** `docs/PLAN.md` (this file), `docs/plans/*` (14 aspect files), `README.md`, `.gitignore`. `git init` on `main`, nothing committed.
2. Offer: export the Claude Doc to `docs/engine-design.md` and record your five answers in its Open questions section. I have not edited the Claude Doc.
3. Write M0's task-level implementation plan (superpowers:writing-plans), then start S1, S3 and S5 (they need no books), then S2 and S4 once the books arrive.
