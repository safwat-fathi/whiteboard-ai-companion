# Tech stack

> Part of [PLAN.md](../PLAN.md) §4 · Related: [deployment](./deployment.md) · [database](./database.md) · [ai-integration](./ai-integration.md) · [math-renderer](./math-renderer.md)

Versions are the latest seen on npm on **2026-11-01**. Pin exact versions at install time. The fast-moving majors (`ai`, `@ai-sdk/openai-compatible`, `next`, `@nestjs/*`) get re-checked in M0.

## Principles

- **TypeScript, strict, everywhere.** One zod schema per concept (element, op, tool input, API body) shared by browser, server and the tool registry.
- **No Docker, no database server, no queue, no cache server.** Two Node processes, one SQLite file, one folder of blobs. The external AI services are the **Meta Model API** (`META_API_KEY`, for all LLM/vision calls) and **OpenRouter** (`OPENROUTER_API_KEY`, strictly for `baai/bge-m3` embeddings).
- **Leaf libraries yes, canvas/whiteboard frameworks no** (the doc's rule: no tldraw, Excalidraw, Konva or similar).
- **pnpm only.** `"packageManager": "pnpm@12.8.1"`, `pnpm-lock.yaml` committed, `pnpm install --frozen-lockfile` in CI and on the VPS. Never npm, yarn, bun or `npx` (use `pnpm exec` / `pnpm dlx`). pnpm blocks dependency install scripts by default: run `pnpm approve-builds better-sqlite3` once and commit the resulting setting.

## Toolchain

| Concern         | Choice                          | Notes                                                            |
| --------------- | ------------------------------- | ---------------------------------------------------------------- |
| Runtime         | Node 22 LTS (22.21.1 installed) | `better-sqlite3` 13 needs ≥ 22. Stay on a glibc Linux on the VPS |
| Package manager | pnpm 12.8.1 (installed)         | Workspace: `packages/*`, `apps/*`                                |
| Language        | TypeScript 7.0, strict          | `tsx` 4.23 runs scripts (ingest CLI, eval runner)                |
| Lint / format   | Biome 2.6                       | One tool instead of ESLint + Prettier **[my call]**              |
| Unit tests      | Vitest 5.0                      | Core, ops, retrieval eval harness                                |
| End-to-end      | Playwright 1.64                 | Runs with `TUTOR_STUB=1`                                         |
| Schemas         | zod 4.6                         | Elements, ops, tool inputs, API bodies                           |

## Application

| Concern            | Choice                                                              | Notes                                                                                                                                                                                            |
| ------------------ | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Web                | Next.js 16.4 + React                                                | Client-only editor: nothing needs SSR. A static export or a Vite SPA served by Caddy would drop one process; decide in M0 **[my call: keep Next as in the doc]**                                 |
| Server             | NestJS 12.3                                                         | WebSocket gateway (`ws` adapter), REST, SSE, services                                                                                                                                            |
| Database           | SQLite via `better-sqlite3` 13.0 (WAL) + FTS5                       | [database](./database.md). `node:sqlite` (stdlib, FTS5 works on this Node 22.21) is a verified fallback if the native build ever bites; DB access lives in one module                            |
| Vector search      | Float32 BLOB column + exact cosine in memory                        | `sqlite-vec` 0.1.9 is the upgrade path (still 0.x)                                                                                                                                               |
| AI                 | `ai` 7.0 · `@ai-sdk/react` 4.0 · `@ai-sdk/openai-compatible` 2.0 *(+ `@openrouter/ai-sdk-provider` 3.1 in M0 spikes)* | Hidden behind one adapter module (`apps/server/src/tutor/llm.ts`); targets the **Meta Model API** (`https://api.llama.com/compat/v1`) for Meta Llama models (`Llama-4-Maverick`, `Llama-4-Scout`, `Llama-3.3-70B`, `Llama-3.2-Vision`) for the [Meta AI Developer Hackathon](https://cerebralvalley.ai/e/meta-ai-developer-hackathon) |
| Chat rendering     | `react-markdown` 10.1 · `remark-gfm` 4.0 · `remark-math` 6.0        | Math nodes are rendered by our own `renderMath()`, so there is one math engine                                                                                                                   |
| Math               | `@mathjax/src` 4.1 (v4), TeX in, SVG out                            | `mathjax-full` 3.2 is the older v3 line. [math-renderer](./math-renderer.md)                                                                                                                     |
| Server canvas      | `@napi-rs/canvas` 1.1                                               | **[spike S1]** Arabic shaping; alternative `skia-canvas`                                                                                                                                         |
| PDF                | `pdfjs-dist` 6.4 (text, outline, page labels, viewer, page rasters) | Node uses its legacy build. `pdftotext` (poppler, installed here) is only a baseline for comparison                                                                                              |
| Diagram layout     | `@dagrejs/dagre` 3.1                                                | Powers `add_diagram`; leaf library                                                                                                                                                               |
| Z-order            | `fractional-indexing` 4.0                                           | Instead of a hand-rolled fractional index                                                                                                                                                        |
| IDs                | `nanoid` 6.0                                                        | Elements, batches, turns                                                                                                                                                                         |
| Optional leaf libs | `rbush` 4.0 (R-tree), `perfect-freehand` 1.2                        | Decide in M0 (finding F12)                                                                                                                                                                       |
| MCP (M7, optional) | `@modelcontextprotocol/sdk` 1.32                                    | Adapter over the same tool registry                                                                                                                                                              |

## Repo layout (pnpm workspace)

```
packages/core    zod schemas (elements, ops, tool inputs) · scene store · ops/undo · bounds · R-tree
                 render() + platform adapter (math and image providers) · BlobStore interface · tool registry (definitions only)
packages/math    MathJax 4 (TeX → SVG), renderMath()/peekMath(), security allowlist, Arabic guard, SVG helpers (the only package that imports @mathjax/*)
apps/web         Next.js: editor, tools, chat dock, library, source panel
apps/server      NestJS: ws gateway · board svc · context builder · tutor svc · library svc (+worker) · blobs · REST
                 migrations/ (numbered .sql) · test/fixtures/ (stub tutor scripts)
deploy/          Caddyfile · whiteboard-server.service · whiteboard-web.service · deploy.sh · backup.sh · .env.example
eval/            per-book retrieval questions (jsonl) + runner
docs/            PLAN.md · plans/*.md · engine-design.md (optional export of the Claude Doc)
data/            (gitignored) whiteboard.db · blobs/ · backups/   ← DATA_DIR in dev
```

## Scripts (planned)

| Command                         | Does                                                      |
| ------------------------------- | --------------------------------------------------------- |
| `pnpm dev`                      | Web on :3000 and server on :4000, with reload             |
| `pnpm build` / `pnpm start`     | Production build; start both processes bound to 127.0.0.1 |
| `pnpm test` / `pnpm e2e`        | Vitest / Playwright (`TUTOR_STUB=1`)                      |
| `pnpm lint`                     | Biome check                                               |
| `pnpm ingest <file.pdf>`        | Ingestion CLI (same code path as the upload endpoint)     |
| `pnpm eval:retrieval -- <book>` | Retrieval eval: recall@8 and MRR per embedding model      |

## Version and compatibility risks

- `ai` and its provider ship majors quickly: keep all AI SDK imports inside `apps/server/src/tutor/llm.ts` (server) and the chat dock (web). Nothing else imports `ai`.
- Native modules (`better-sqlite3`, `@napi-rs/canvas`) ship prebuilt binaries for macOS and glibc Linux; Alpine/musl is not supported in this plan.
- Next 16, NestJS 12 and TypeScript 7 are new majors: scaffold in M0/M1 with whatever the generators emit, then pin.
