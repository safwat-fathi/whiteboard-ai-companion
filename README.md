# Whiteboard AI Companion

> 🏆 **Built for the [Meta AI Developer Hackathon](https://cerebralvalley.ai/e/meta-ai-developer-hackathon)** hosted by **Meta** & **Cerebral Valley**.

A personal **study companion**. Upload a book, choose what to study (a topic, a chapter, the whole book) and **chat with an AI tutor inside the app**. The tutor explains on a shared infinite whiteboard with text, LaTeX equations, diagrams, charts and figures from your book, and cites the pages. You can draw and write on the same board, select anything and ask about it, and jump to wherever the AI worked.

> **Status: M1 (core canvas editor) and M2 (math and images) done; M3 (server sync, SQLite op log, blobs, access gate, deploy scripts) built and gate-verified.** The server runs locally and syncs multiple tabs over WebSocket; server PNG snapshot matches browser render; Caddy and systemd deployment configs are ready. The AI tutor is planned (M5): the Meta Model API pieces below describe the plan and are **[spike]** until they are measured against that API (the M0 spikes ran on OpenRouter). Plan: [`docs/PLAN.md`](docs/PLAN.md); scope, gates and status per phase: [`docs/ROADMAP.md`](docs/ROADMAP.md).

## What it does (v1)

- **Chat with the AI from the app UI.** A chat dock beside the board: streaming answers, tool-call chips, page citations, Stop, Undo response.
- **The whiteboard is the AI's context.** Every message carries a digest of the board. Attach the **selection**, the **viewport** or the **whole board** as structure, a picture, or both, and see exactly what will be sent.
- **Books with page citations.** Upload a PDF, get hybrid search (keywords + embeddings) scoped to a topic, chapter or the whole book. Answers say what is from your book and what is general explanation.
- **Jump to the AI's work.** Follow the AI live, get an off-screen indicator, or click any chat chip or activity row to fly to where it drew, now or weeks ago.
- **A from-scratch canvas.** Freehand, shapes, text (Arabic/RTL), LaTeX math (MathJax), charts, images, select/move/resize.
- **Simple to run.** No login, no Docker, no database server: Node, one SQLite file, a [Meta Model API](https://api.meta.ai) key (`META_API_KEY`) for all LLM/vision calls, and an [OpenRouter](https://openrouter.ai) key (`OPENROUTER_API_KEY`) for `baai/bge-m3` embeddings. Runs on a laptop and on a small VPS.

## Hackathon & Meta AI Integration

> Planned design (M5): nothing in this section is built yet, and the model choices are **[spike]** until re-measured against the Meta Model API.

Whiteboard AI Companion is built for the **[Meta AI Developer Hackathon](https://cerebralvalley.ai/e/meta-ai-developer-hackathon)** (October 26 – November 4, 2026), hosted by **Meta** and **Cerebral Valley**.

The project re-imagines how learners interact with textbooks and technical subjects by uniting Meta foundation models with an interactive visual workspace via the **Meta Model API**:

- **AI Tutor with Visual Explanations:** Powered directly by the **Meta Model API** (`https://api.meta.ai/v1`) using Meta's **Muse** series (`muse-spark-1.3`, `muse-wonder-1.0`) for real-time tool orchestration, mathematical reasoning, and textbook diagram/page transcription (with open-weights Llama 4 supported via OpenRouter `meta-llama/llama-4-maverick`).
- **The Board is the AI's Context:** Instead of text-only conversations, the student and AI share an infinite 2D canvas. The AI can point, draw diagrams, write formatted MathJax equations, and place textbook figures directly into view.
- **Grounded in Your Books:** Upload any PDF to get hybrid search (dense `baai/bge-m3` embeddings + BM25) with verifiable page citations, distinguishing textbook source material from general explanation.
- **Local-First & Accessible:** Runs natively without Docker or external DB servers (Node, SQLite in WAL mode) to ensure low latency and easy accessibility for any student or researcher.

## How it fits together

```
Browser (Next.js) ── canvas · chat dock · library · source panel
   │ WebSocket (board ops)   │ SSE (tutor stream)   │ REST
   ▼                         ▼                      ▼
Node server (node:http + ws) ── Board service · Tutor (tool loop) · Context builder · Library · Snapshot render
   │                                              │
SQLite (WAL, FTS5) + blobs on disk           Meta Model API (chat, tool loop, vision, page transcription)
                                             + OpenRouter (baai/bge-m3 embeddings only)
```

## Documentation

Start with the master plan, then the aspect you care about.

| Doc                                                                | Covers                                                                    |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------- |
| [`docs/PLAN.md`](docs/PLAN.md)                                     | Validation of the design doc, resolutions, product, milestones, decisions |
| [`docs/ROADMAP.md`](docs/ROADMAP.md)                               | Phases M0–M7: scope, dependencies, gates, status                          |
| [`tech-stack`](docs/plans/tech-stack.md)                           | Languages, libraries, versions, repo layout, scripts                      |
| [`deployment`](docs/plans/deployment.md)                           | Run locally and on a VPS without Docker; config, systemd, Caddy, backups  |
| [`whiteboard-engine`](docs/plans/whiteboard-engine.md)             | Elements, ops, undo, renderer, tools, sync                                |
| [`math-renderer`](docs/plans/math-renderer.md)                     | LaTeX with MathJax, caching, security, Arabic                             |
| [`ai-integration`](docs/plans/ai-integration.md)                   | Meta Model API, tutor loop, tool registry, models & S3 benchmarks, caps   |
| [`chat-ui`](docs/plans/chat-ui.md)                                 | The in-app chat dock and composer                                         |
| [`board-context`](docs/plans/board-context.md)                     | How the board and a selection become AI context                           |
| [`library-ingestion`](docs/plans/library-ingestion.md)             | PDF → text, structure, chunks, embeddings, summaries                      |
| [`rag-context-engineering`](docs/plans/rag-context-engineering.md) | Scope packs, retrieval, citations, caching, memory                        |
| [`jump-to-ai`](docs/plans/jump-to-ai.md)                           | Locate, Follow AI, Activity, undo                                         |
| [`database`](docs/plans/database.md)                               | SQLite schema, search, migrations, backups                                |
| [`api`](docs/plans/api.md)                                         | REST, WebSocket and chat-stream contracts                                 |
| [`auth-security`](docs/plans/auth-security.md)                     | The access gate, secrets, limits, prompt injection                        |
| [`testing-spikes`](docs/plans/testing-spikes.md)                   | M0 spikes, risks, test strategy, acceptance scripts                       |

## Quick start

Prerequisites: **Node 22+** and **pnpm 12** (`corepack enable`).

```bash
pnpm install
cp .env.example .env             # optional for local server mode; required for AI keys in M4/M5
```

### Running

- **Standalone local editor (M1/M2):**
  ```bash
  pnpm dev:web                   # editor at http://localhost:3000 (persists in browser IndexedDB)
  ```
- **Collaborative server mode (M3):**
  ```bash
  pnpm dev                       # web on :3000, server on :4000 (SQLite in ./data, WebSocket sync)
  ```

### Testing

```bash
pnpm lint                        # Biome check
pnpm typecheck                   # TypeScript check across all packages and apps
pnpm test                        # Vitest unit tests (core, math, web, server)
pnpm e2e                         # Playwright browser editor tests
pnpm e2e:server                  # Playwright server gates (M3: two tabs, restart, Origin, PNG; M4: library upload to cited page)
pnpm ingest <file.pdf>           # add a PDF to the library from the terminal (--title, --r3 1-9,20, --resume <id>)
pnpm eval:retrieval --book <id|title> --eval eval/<book>.jsonl   # recall@8 and MRR on a real book
```

Deploying to a VPS (Node + systemd + Caddy, no Docker): [`docs/plans/deployment.md`](docs/plans/deployment.md).

## Configuration

Set in `.env` (server) — the full list is in [`deployment`](docs/plans/deployment.md):

| Key                                                            | Purpose                                                                                                                               |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `META_API_KEY`                                                 | Meta Model API secret (chat, tool loop, vision, summaries, page OCR). Server-side only                                                |
| `META_API_BASE_URL`                                            | Meta OpenAI-compatible base URL (`https://api.meta.ai/v1` by default)                                                                 |
| `OPENROUTER_API_KEY`                                           | Used exclusively for `baai/bge-m3` embeddings (`POST /api/v1/embeddings`) and historical M0 spike scripts. Server-side only           |
| `TUTOR_MODEL` · `TUTOR_MODEL_AR` · `CHEAP_MODEL` · `VISION_MODEL` | Meta model IDs (default `muse-spark-1.3`; `REVIEWER_MODEL=muse-wonder-1.0`; open-weights Llama 4 via OpenRouter)                     |
| `SNAPSHOT_ADAPTER`                                             | Canvas snapshot delivery adapter (`follow-up-user` required for Meta Model API; `tool-result-image` supported on OpenRouter)          |
| `EMBED_MODEL`                                                  | Embedding model ID (`baai/bge-m3`, 1024-d via OpenRouter embeddings endpoint)                                                         |
| `DATA_DIR`                                                     | Where the SQLite file and blobs live (`./data` by default)                                                                            |
| `MAX_STEPS` · `MAX_TURN_COST_USD` · `DAILY_BUDGET_USD`         | Spending and loop caps                                                                                                                |
| `TURN_TIMEOUT_MS`                                              | Wall clock for one tutor turn (default 120000); raise it if long answers are cut off                                                  |
| `TUTOR_PRICE_IN_PER_M` · `TUTOR_PRICE_OUT_PER_M`               | USD per million tokens. Unset = turns are unpriced (tokens are still counted); `MAX_TURN_COST_USD` and the spend ledger need a price   |
| `TUTOR_REASONING_EFFORT`                                       | `low` · `medium` · `high`, sent as `reasoning_effort` (optional; default: the model's own)                                            |
| `TUTOR_STUB`                                                   | `1` = a scripted model replaces the real one (tests and e2e only)                                                                      |

## Repo layout

```
packages/core    schemas, scene store, ops/undo, renderer, blob interface, tool registry
packages/math    MathJax renderer (renderMath), security allowlist
apps/web         Next.js editor, sync client, HTTP blob store, chat dock, library
apps/server      Node server: WebSocket (/ws), REST (/api), SQLite (WAL), blobs on disk, snapshot render
deploy/          Caddyfile, systemd services, deploy.sh, backup.sh
eval/            retrieval questions per book
docs/            PLAN.md and docs/plans/*.md
```

## Roadmap

| Milestone | What                                                                                             |
| --------- | ------------------------------------------------------------------------------------------------ |
| M0        | Spikes: canvas performance, ingestion on real books, OpenRouter loop, embeddings, deploy dry-run |
| M1–M2     | Core editor, math and images                                                                     |
| M3        | Server, sync, persistence, first VPS deploy                                                      |
| M4        | Library: upload, extraction, hybrid search                                                       |
| **M5**    | **Tutor slice: in-app chat, board context, citations, jump-to-AI**                               |
| M6–M7     | Ink and charts, hardening, optional MCP adapter                                                  |

The first usable tutor is the end of M5. Scope, gates and status per phase, ordered by dependency: [`ROADMAP.md`](docs/ROADMAP.md).

## License

Not decided yet.
