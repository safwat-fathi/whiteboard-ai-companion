# API

> Part of [PLAN.md](../PLAN.md) §15 · Related: [database](./database.md) · [ai-integration](./ai-integration.md) · [board-context](./board-context.md) · [auth-security](./auth-security.md) · [jump-to-ai](./jump-to-ai.md)

Three channels, one server: **REST** (`/api/*`), **WebSocket** (`/ws`, board ops and agent events), **SSE** (`POST /api/chat`, the tutor stream). All bodies are validated with the zod schemas in `packages/core` (or `apps/server` for REST-only shapes). There is no auth in the app: the gate is outside ([auth-security](./auth-security.md)), but WebSocket and non-GET requests check `Origin` against `PUBLIC_ORIGIN`.

## Conventions

- JSON, UTF-8, epoch milliseconds for times, string ids (boards: uuid; others nanoid).
- Errors: `{ "error": { "code": "validation_failed", "message": "…", "details": {…} } }`.

  | code | HTTP | When |
  |---|---|---|
  | `validation_failed` | 400 | Body does not match the schema; `details` names the field and allowed range |
  | `not_found` | 404 | Unknown board/book/blob |
  | `forbidden_origin` | 403 | Origin check failed |
  | `turn_busy` | 409 | A tutor turn is already running on this board |
  | `budget_exceeded` | 429 | Daily or per-turn cap hit; `details.cap` says which |
  | `payload_too_large` | 413 | Over the size limit ([auth-security](./auth-security.md)) |
  | `upstream_error` | 502 | Meta Model API / OpenRouter provider failure after retries |
  | `ingest_failed` | 422 | Book could not be processed; `details` has the step |

- Pagination: `?before=<cursor>&limit=<n>`; responses carry `next` when more exist.

## REST

| Method & path | Purpose |
|---|---|
| `GET /api/health` | DB open, migrations current, `META_API_KEY` and `OPENROUTER_API_KEY` present |
| `GET /api/boards` · `POST /api/boards {title, scope}` | List / create |
| `GET /api/boards/:id` · `PATCH` · `DELETE` | Metadata, title, scope |
| `GET /api/boards/:id/messages` | Chat history (paged) |
| `GET /api/boards/:id/activity` | AI turns and batches for the Activity tab ([jump-to-ai](./jump-to-ai.md)) |
| `POST /api/boards/:id/context-preview` | Exact digest text, thumbnails and token estimate for a context descriptor ([board-context](./board-context.md)) |
| `GET /api/boards/:id/export.png?x=&y=&w=&h=&width=` | Server render of a region (used by tests and the snapshot fallback) |
| `POST /api/blobs` (multipart, ≤ 10 MB) · `GET /api/blobs/:id` | Image/picture upload and fetch (correct type, `nosniff`) |
| `POST /api/books` (multipart PDF) | Upload; returns `{id}` with `status: uploaded` |
| `GET /api/books` · `GET /api/books/:id` | List; status, progress, method, cost, error |
| `GET /api/books/:id/estimate` · `POST …/preview {pages}` · `POST …/index {methods?}` · `POST …/retry` · `DELETE` | Ingestion flow ([library-ingestion](./library-ingestion.md)) |
| `GET /api/books/:id/outline` | Section tree with page ranges and summaries |
| `GET /api/books/:id/file` | Original PDF with range requests (Source tab viewer) |
| `GET /api/books/:id/pages/:n` · `…/pages/:n/image?w=` | Page text with label; cached raster |
| `GET /api/books/:id/chunks/:chunkId` | Chunk for a citation (text, page range, heading path) |
| `POST /api/search {query, bookId?, sectionIds?, k?}` | Hybrid search (library UI search and the eval runner) |
| `GET /api/settings` · `PUT /api/settings` | Student profile, budget overrides |
| `GET /api/usage?from=&to=` | Spend by day and kind from the `spend` ledger |
| `GET /api/models` | Configured model names for the UI footer |

## Chat: `POST /api/chat` (SSE)

Request:

```json
{
  "boardId": "…",
  "message": { "text": "Explain this step", "images": ["blobId"] },
  "context": { "boardSeq": 1234, "mode": "ask", "viewport": {…}, "selection": ["el_12"],
               "attach": { "selection": "both", "viewport": "none", "board": "none" },
               "pictures": [ { "blobId": "…", "of": "selection", "rect": {…} } ] }
}
```

Response: the AI SDK **UI message stream** over SSE (`createUIMessageStreamResponse`; do not hand-parse): text deltas, tool inputs/outputs, finish, error. Custom data parts added by the server:

| Part | Payload | Used by |
|---|---|---|
| `data-turn` | `{turnId}` | Chat dock and Activity tab to correlate the WebSocket batches |
| `data-batch` | `{batchId, seq, label, bounds, count}` | Tool chips (Locate, Undo) |
| `data-usage` | `{costUsd, inputTokens, cachedTokens, outputTokens, model}` | Message footer, top-bar spend |

The server owns history, so the client sends only the new message plus the context. Aborting the fetch (Stop) aborts the model call and releases the turn lock. Errors arrive as the stream's `error` part with an error `code` from the table above.

## WebSocket `/ws`

One socket per board (`/ws?boardId=<id>`), JSON messages. Origin is checked at the handshake.

| Message | Direction | Purpose |
|---|---|---|
| `join {boardId, fromSeq}` | C→S | Server replies with a snapshot (if `fromSeq` is too old) plus the op tail |
| `ops {clientSeq, batch}` | C→S | Submit a batch already applied locally. `batch = {batchId, label, ops}` |
| `ack {clientSeq, seq}` | S→C | Confirms the batch and its place in the order |
| `ops {seq, batch, author, turnId?, bounds}` | S→C | Broadcast of every accepted batch, including tutor batches |
| `reject {clientSeq, reason}` | S→C | Failed validation or edit-rights check; client rolls back |
| `undo {turnId \| batchIds}` | C→S | Server builds inverse batches and applies them as new batches, replying with `ops` + `skipped` count |
| `agent_status {turnId, state, text?}` | S→C | `thinking · reading · drawing · done · stopped` |
| `agent_focus {turnId, batchId, bounds}` | S→C | Drives Follow AI, the edge indicator and the AI cursor |
| `render_request {reqId, rect, width}` / `render_response {reqId, png}` | S→C / C→S | Snapshot fallback: ask the open tab to render ([whiteboard-engine](./whiteboard-engine.md)) |

Dropped from the doc: `presence` and live ink (single human). `author` is derived by the server from the channel, never trusted from a client ([auth-security](./auth-security.md)).

## Versioning and stability

v1 is unversioned internally (one web app, one server, deployed together). Add `/api/v2` only if a second client appears. The tool registry's input schemas are the stable public contract if MCP is added ([ai-integration](./ai-integration.md)).

## Tests

Contract tests per route (valid/invalid body, error codes); WebSocket ordering test (two clients, interleaved batches, identical final scene); SSE test with `TUTOR_STUB=1` asserting part order and `data-batch` ↔ WebSocket `ops` correlation; Origin-rejection tests.
