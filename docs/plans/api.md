# API

> Part of [PLAN.md](../PLAN.md) §15 · Related: [database](./database.md) · [ai-integration](./ai-integration.md) · [board-context](./board-context.md) · [auth-security](./auth-security.md) · [jump-to-ai](./jump-to-ai.md)

Three channels, one server: **REST** (`/api/*`), **WebSocket** (`/ws`, board ops and agent events), **SSE** (`POST /api/chat`, the tutor stream). All bodies are validated with the zod schemas in `packages/core` (or `apps/server` for REST-only shapes). There is no auth in the app: the gate is outside ([auth-security](./auth-security.md)), but WebSocket handshakes and non-GET requests check `Origin` against `PUBLIC_ORIGIN`, and all HTTP requests and WebSocket handshakes validate the `Host` header to prevent DNS rebinding.

## Conventions

- JSON, UTF-8, epoch milliseconds for times, string ids (boards: uuid; others nanoid).
- Errors: `{ "error": { "code": "validation_failed", "message": "…", "details": {…} } }`.

  | code | HTTP | When |
  |---|---|---|
  | `validation_failed` | 400 | Body does not match the schema; `details` names the field and allowed range |
  | `not_found` | 404 | Unknown board/book/blob |
  | `forbidden_origin` | 403 | Origin check failed, or unknown `Host` |
  | `turn_busy` | 409 | A tutor turn is already running on this board |
  | `conflict` | 409 | The book is queued or being indexed (index, retry, delete), or its state does not allow the call |
  | `budget_exceeded` | 429 | Daily or per-turn cap hit; `details.cap` says which |
  | `payload_too_large` | 413 | Over the size limit ([auth-security](./auth-security.md)) |
  | `upstream_error` | 502 | Meta Model API / OpenRouter provider failure after retries |
  | `overloaded` | 503 | More than `maxConcurrentExports` (2) board exports are rendering; retry shortly |
  | `ingest_failed` | 422 | Book could not be processed; `details` has the step |

- Pagination: `?before=<cursor>&limit=<n>`; responses carry `next` when more exist.

## REST

| Method & path | Purpose |
|---|---|
| `GET /api/health` | DB open, migrations current, `MODEL_API_KEY` and `OPENROUTER_API_KEY` present |
| `GET /api/boards` · `POST /api/boards {title, scope}` | List / create |
| `GET /api/boards/:id` · `PATCH` · `DELETE` | Metadata, title, scope |
| `GET /api/boards/:id/messages` | Chat history (paged); starts after the last _New chat_ |
| `POST /api/boards/:id/chat/reset` | _New chat_: hides the board's messages so far (they stay in the database) and drops its rolling summary; the board is untouched. `{}` body, returns `{ok: true}`; `turn_busy` (409) while a turn runs; `not_found` for an unknown board; the usual `Origin` check applies |
| `POST /api/boards/:id/context-preview` | Exact digest text, thumbnails and token estimate for a context descriptor ([board-context](./board-context.md)) |
| `GET /api/boards/:id/export.png?x=&y=&w=&h=&width=` | Server render of a region (used by tests and the snapshot fallback) |
| `POST /api/blobs` (raw body, ≤ 10 MB) · `GET /api/blobs/:id` | Image/picture upload and fetch (raw body, buffered; the claimed `Content-Type` is ignored and the real type is sniffed, header-verified size/dimensions; returns `{id, mime, bytes}` with 201 (new) or 200 (already stored); `nosniff`) |
| `POST /api/books?title=` (raw body, `Content-Type: application/pdf`, ≤ 200 MB, ≤ 2,000 pages) | Upload (streamed to disk while hashed); `201` with the book (`id`, `title`, `pages`, `status: uploaded`, …). A body that is not a PDF is `400`, one that cannot be read or has too many pages `422 ingest_failed`, over the limit `413`; a refused file is not kept |
| `GET /api/books` · `GET /api/books/:id` | `{books}` / one book: `status`, `progress`, `error`, `methods` (pages read per rung), `chunks`, `ingestMethod` (`ranges`, `warnings`: pages the model cut off, `notes`) |
| `GET /api/books/:id/estimate` | `{pages, r1, r4, scanned, mathDense, embedUsd, r3Usd, dailyRemainingUsd}`: what default routing will do and cost. Free |
| `POST /api/books/:id/preview {pages}` | 1 to 3 pages: `[{page, label, imageUrl, r1: {text}, r4: {text, truncated} \| {error}}]`. Free (Meta is not priced here); changes nothing |
| `POST /api/books/:id/index {methods?}` | `202`. `methods: [{from, to, rung: 'R1'\|'R3'\|'R4'}]` overrides routing; R3 ranges are checked against today's remaining budget first (`429 budget_exceeded`). `409 conflict` while running |
| `POST /api/books/:id/retry` · `DELETE /api/books/:id` | Retry a failed (or ready, to fill missing summaries) book; delete a book that is not running, with its file, page images and vectors |
| `GET /api/books/:id/outline` | `{sections}`: a flat list in document order, each with `id`, `parentId`, `level`, `title`, `pageStart`, `pageEnd`, `summary` |
| `GET /api/books/:id/file` | Original PDF, `Range` requests (`206`, `416`), `nosniff` |
| `GET /api/books/:id/pages/:n` · `…/pages/:n/image?w=` | `{page, label, text, method}`; PNG raster of the page (`w` clamped to 256–2048, default 1000; cached under `DATA_DIR/cache/pages/<book>/<n>@<w>.png`) |
| `GET /api/books/:id/chunks/:chunkId` | Chunk for a citation (text, page range, heading path) |
| `POST /api/search {query, bookId?, sectionIds?, k?, neighbors?}` | Hybrid search: `{mode: 'hybrid'\|'keyword', hits: [{chunkId, bookId, sectionId, ord, pageStart, pageEnd, citeLabel, headingPath, text, score, neighbor}]}`. `k` 1–50 (default 8); no `bookId` = every ready book; `sectionIds` also include their sub-sections; `mode: 'keyword'` when the embedding call is unavailable |
| `GET /api/settings` · `PUT /api/settings` | Student profile, budget overrides |
| `GET /api/usage?from=&to=` | Spend by day and kind from the `spend` ledger |
| `GET /api/models` | Configured model names for the UI footer |
| `POST /api/boards/:id/turns/:turnId/undo` · `POST /api/boards/:id/batches/:batchId/undo` | "Undo this response" / one batch: `{undone, skipped}` (steps the student changed since are skipped); `409 turn_busy` while the turn runs |
| `GET /api/boards/:id/activity?before=&limit=&turn=&batch=` | Turns that changed the board, newest first: `{turns:[{turnId, startedAt, userText, status, bounds, batches:[{batchId, seq, label, bounds, count, touchedIds}]}], next?}`; `turn`/`batch` fetch the one that matters (deep links) |
| `GET /api/_test/last-request?boardId=` | `TUTOR_STUB=1` only: what the scripted model was asked (specs read it) |

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
| `data-usage` | `{costUsd \| null, inputTokens, cachedTokens, outputTokens, model, fallback?, unverifiedCites?}` | Message footer, top-bar spend (`costUsd` is null while the model is unpriced) |
| `data-status` | `{state: thinking \| reading \| drawing \| done \| stopped}` | "Working…" line, AI presence |
| `data-source` | `{bookId, pageStart, pageEnd, label?}` | The only pages a `cite:<bookId>#<page>` link may name this turn |
| `data-focus` | `{bounds, note?}` | `focus_region` pointed at something (emitted by the server; the web app does not consume it) |

The stream opens with `start` (`messageId: <turnId>:a`) before any data part. `data-batch` also carries `touchedIds`. Request: `message.images` are pasted-image blob ids; `context.pictures` are the browser-rendered pictures (blob ids from `POST /api/blobs`).

The server owns history, so the client sends only the new message plus the context. Aborting the fetch (Stop) aborts the model call and releases the turn lock. Errors arrive as the stream's `error` part with an error `code` from the table above.

## WebSocket `/ws`

One socket per board (`/ws?boardId=<id>`), JSON messages. Both `Origin` and `Host` are verified at the handshake.

| Message | Direction | Purpose |
|---|---|---|
| `join {boardId, fromSeq}` | C→S | Join a board channel. Server replies with `sync` |
| `sync {boardId, headSeq, snapshot?, ops}` | S→C | State sync: includes `snapshot` (if `fromSeq` is too old or omitted) plus the op tail |
| `ops {clientSeq, batch}` | C→S | Submit a batch already applied locally. `batch = {batchId, label, ops}` |
| `ack {clientSeq, seq}` | S→C | Confirms the batch and its place in the order |
| `ops {seq, batch, author, turnId?, bounds}` | S→C | Broadcast of every accepted batch, including tutor batches |
| `reject {clientSeq, reason}` | S→C | Failed validation or edit-rights check; client rolls back |
| `undo {turnId \| batchIds}` *(not built: REST, see above)* | C→S | Server builds inverse batches and applies them as new batches |
| `agent_status {turnId, state, text?}` *(not built: a `data-status` part on the chat stream)* | S→C | `thinking · reading · drawing · done · stopped` |
| `agent_focus {turnId, batchId, bounds}` *(not built: agent-authored `ops` carry author, turnId and bounds)* | S→C | Drives Follow AI, the edge indicator and the AI cursor |
| `render_request` / `render_response` *(deferred M5)* | S→C / C→S | Snapshot fallback: ask the open tab to render |

Dropped from the doc: `presence` and live ink (single human). `author` is derived by the server from the channel, never trusted from a client ([auth-security](./auth-security.md)).

**R6 deferral (settled in M5: undo is REST, status is a stream part, focus rides on `ops`):** Human undo stays client-side in M1–M3 (M1's `UndoManager` submits inverses as new batches). The WebSocket `undo`, `agent_status`, `agent_focus`, and `render_request` / `render_response` messages arrive in M5/M6 with the AI tutor and follow-AI features.

## Versioning and stability

v1 is unversioned internally (one web app, one server, deployed together). Add `/api/v2` only if a second client appears. The tool registry's input schemas are the stable public contract if MCP is added ([ai-integration](./ai-integration.md)).

## Tests

Contract tests per route (valid/invalid body, error codes); WebSocket ordering test (two clients, interleaved batches, identical final scene); SSE test with `TUTOR_STUB=1` asserting part order and `data-batch` ↔ WebSocket `ops` correlation; Origin-rejection tests.
