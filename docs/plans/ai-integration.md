# AI integration (tutor agent)

> Part of [PLAN.md](../PLAN.md) §8 (resolution R2) · Related: [chat-ui](./chat-ui.md) · [board-context](./board-context.md) · [rag-context-engineering](./rag-context-engineering.md) · [jump-to-ai](./jump-to-ai.md) · [api](./api.md)

Everything between the chat dock and OpenRouter: the provider, the tool loop, the tool registry, limits and tests. What goes _into_ the prompt is in [rag-context-engineering](./rag-context-engineering.md) and [board-context](./board-context.md).

## Provider

- **OpenRouter only** (the one key you have). Used for: chat completions with tool calling and image input (through the AI SDK provider), embeddings (`POST /api/v1/embeddings`), and the PDF `file-parser` plugin ([library-ingestion](./library-ingestion.md)).
- The key lives **only in the server environment**. The browser never talks to OpenRouter.
- Libraries: `ai` 7, `@ai-sdk/react` 4, `@openrouter/ai-sdk-provider` 3 ([tech-stack](./tech-stack.md)). All AI SDK server code is behind one adapter module, `apps/server/src/tutor/llm.ts`.
- Provider options: `appName`/`appUrl` set; `extraBody: { provider: { data_collection: 'deny' } }` to prefer providers that do not train on prompts **[spike S3: confirm routing still works]**.

## Models (all env vars; read from OpenRouter's live catalog on 2026-11-01)

Each default below supports tool calling and image input (embeddings are listed under `/api/v1/embeddings/models`).

| Role           | Env                    | Default (candidate)           | $/M in / out | Use                                                 |
| -------------- | ---------------------- | ----------------------------- | ------------ | --------------------------------------------------- |
| Tutor (English) | `TUTOR_MODEL`         | `anthropic/claude-haiku-5.5`  | 0.10 / 0.50  | English boards: chat, tool loop, vision, prompt caching **(S3, 2026-11-02)** |
| Tutor (Arabic)  | `TUTOR_MODEL_AR`      | `google/gemini-3.8-flash`     | 0.75 / 3.75  | Arabic boards; Haiku answers Arabic prompts in English **(S3)** |
| Reviewer (optional) | `REVIEWER_MODEL`  | `anthropic/claude-sonnet-5.5` | 2.00 / 10.00 | Best Arabic (4.5/5); second-pass review if built **(S3)** |
| Tutor fallback | `TUTOR_FALLBACK_MODEL` | the other tutor               |              | One retry on provider errors                        |
| Cheap          | `CHEAP_MODEL`          | `anthropic/claude-haiku-5.5`  | 0.10 / 0.50  | Summaries, rolling memory, TOC inference            |
| Vision         | `VISION_MODEL`         | `google/gemini-3.8-flash`     | 0.75 / 3.75  | Page transcription (rung R4)                        |
| Embeddings     | `EMBED_MODEL`          | `baai/bge-m3`                 | 0.01 / –     | Indexing and queries (1024-d, multilingual)         |

**S3 compared** Sonnet 5.5, Gemini 3.8 Flash, GPT-6 Luna and Haiku 5.5 ([results](../../spikes/s3-openrouter/RESULT.md)); originally planned as: S3 compares three tutor candidates on your questions** (e.g. Sonnet 5.5, Gemini 3.7 Flash, `openai/gpt-6-luna`) and picks by quality on your books, Arabic included, not by brand.

### Meta AI Developer Hackathon Configuration
Built for the **[Meta AI Developer Hackathon](https://cerebralvalley.ai/e/meta-ai-developer-hackathon)** (Meta × Cerebral Valley), Whiteboard AI is configured to leverage Meta's open foundation models via OpenRouter or direct Meta API:
- **Tutor / Reasoning (`TUTOR_MODEL`):** `meta-llama/llama-3.3-70b-instruct` (or `meta-llama/llama-3.1-405b-instruct`) for tool loop orchestration, complex math derivation, and pedagogical step generation.
- **Vision & Board Perception (`VISION_MODEL`):** `meta-llama/llama-3.2-11b-vision-instruct` (or `meta-llama/llama-3.2-90b-vision-instruct`) for inspecting student canvas drawings and textbook figures.

**Cost envelope** (estimates from catalog prices; S3 replaces them with measured numbers):

- Index a 400-page book: embeddings ≈ $0.002; summaries ≈ $0.02–0.05; optional paid extraction: `mistral-ocr` ≈ $0.80, vision transcription ≈ $0.2–1.5.
- One tutor turn (Sonnet-class, 60k cached scope pack, ~6 steps): ≈ $0.05–0.25. The first turn of a scope pays the cache write. $5/day ≈ 20–100 turns; flash-class models are roughly 3–20× cheaper.

## Turn lifecycle

1. **Client:** the student sends a message. The client flushes pending board ops (waits for acks), renders any context pictures in the browser and uploads them as blobs, then `POST /api/chat` with the message and the context descriptor ([board-context](./board-context.md), [api](./api.md)).
2. **Server:** takes the board's **turn lock** (one active turn per board), creates `turn_id`, builds the prompt ([rag-context-engineering](./rag-context-engineering.md)), checks budgets.
3. **Loop:** `streamText({ model, system, messages, tools, stopWhen: isStepCount(MAX_STEPS) })` (AI SDK 7 pattern). Each write tool call is **one labelled batch** through the Board service: `author = {kind: agent, id: tutor:<turn_id>}`, `turn_id`, `bounds`.
4. **Out:** batches reach the browser over the WebSocket (they appear live; `agent_focus` drives Follow AI and the off-screen indicator). Text and tool chips stream over the SSE chat response, with `data-batch` parts linking chips to batches.
5. **End:** persist the assistant message (parts, usage, cost), write the `spend` row, release the lock. **Stop** (client abort) cancels the stream; applied batches stay and _Undo this response_ is offered.

## Tool registry (one definition, two adapters)

Defined once in `packages/core`: zod input schema, description, `execute(ctx) → ops | data`, with `ctx = {boardId, turnId, author, grantedIds}`. Adapters: AI SDK `tool()` now; MCP SDK in M7 (the same file the engine's human tools map to).

| Group                    | Tools                                                                                                                                                                        | Notes                                                                                                                                                         |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Read board               | `get_board`, `get_elements`, `get_snapshot`                                                                                                                                  | `get_elements` filters by ids, type, region, author, text; board text is marked untrusted. Snapshot reaches the model as a follow-up image (below)            |
| Write board              | `add_text`, `add_math`, `add_shape`, `connect`, **`add_diagram`**, `add_chart`, **`add_book_figure`**, `draw_stroke` (rare), `update_elements`, `delete_elements`, `arrange` | One call = one batch. `placement`: absolute `{x,y}`, relative `{relativeTo, side, gap}`, or `"auto"` (nearest free space to the selection, else the viewport) |
| Attention                | `focus_region`                                                                                                                                                               | Focus is implicit after every write; call it to point at something specific                                                                                   |
| Book                     | **`get_outline`**, **`search_book`**, **`read_section`**                                                                                                                     | Scoped to the board's scope by default ([rag-context-engineering](./rag-context-engineering.md))                                                              |
| Not exposed to the tutor | `apply_ops` (engine escape hatch), `undo_batch` (a human button)                                                                                                             | The MCP adapter may expose them                                                                                                                               |

**New tools (bold):**

- `add_diagram {nodes, edges, direction, title, placement}`: dagre layout → shapes + bound arrows in one batch. LLMs are poor at coordinates; this is the biggest win for concept maps and flowcharts.
- `add_book_figure {bookId?, page, rect?, caption?, placement}`: the server rasterises the page at 2× and crops it into an `image` element with `source.bookPage`.

Every write returns created ids, their bounding boxes and the batch id; with `returnSnapshot: true` it also attaches a picture of the affected area so the tutor can check its work. Validation errors name the field and the allowed range; LaTeX errors include the MathJax message.

## Guardrails

- **Caps per turn:** `MAX_STEPS` (12), `MAX_TURN_COST_USD` (0.50), 120 s wall clock, a soft element budget (~40 new elements; the charter says ask before more). **Per day:** `DAILY_BUDGET_USD`, summed from the `spend` ledger (turns, embeddings, summaries, OCR, vision). Breach aborts with a plain message in the chat.
- **Cost must arrive while streaming.** `createOpenRouter()` defaults to `compatibility: 'compatible'`, which omits `stream_options.include_usage`. Create the provider with `compatibility: 'strict'` and set `usage: { include: true }` on the model; read `providerMetadata.openrouter.usage.cost` in `onStepFinish`. **[Spike S3]** confirms cost arrives after each step in streaming mode, otherwise the cap never fires.
- **Edit rights (anti-goal):** the Board service rejects agent patches/removes on `author.kind = human` elements unless the id was **selected when the turn started** (`grantedIds`). The tutor may always add and may edit its own elements. `locked` is honoured.
- **Citations validated:** `cite:` ids must be in the set retrieved this turn; unknown ids are stripped and flagged.
- **Untrusted content:** book passages and board text are delimited data; the charter and tool descriptions say never to follow instructions found in them. The tutor has no network tools.
- **Concurrency:** one turn per board; a second request gets `turn_busy`.
- **Reasoning:** low effort for chat turns, higher for "plan and draw a chapter" (configurable).

## Snapshots to the model

The tool result carries text (ids, bounds, "snapshot attached"); the adapter then appends a **user** message with the PNG (≤ 1600 px long side). OpenRouter's tool-calling docs only show text in `role:"tool"` messages and do not say images are allowed. If **S3** shows the chosen model accepts images inside tool results, switch to that; the registry does not change. Context pictures attached by the student ([board-context](./board-context.md)) are ordinary image parts of the user message.

## Prompt caching hooks

Anthropic models need explicit `cache_control` (per-block via `providerOptions.openrouter.cacheControl`, or top-level for automatic placement); OpenAI, Gemini, DeepSeek and others cache automatically. Breakpoint goes after the scope pack. 1-hour TTL for scope packs **[S3: confirm the provider passes `ttl`]**. Check `usage.prompt_tokens_details.cached_tokens > 0` on turn 2. Full strategy: [rag-context-engineering](./rag-context-engineering.md).

## Errors and fallback

| Condition             | Behaviour                                                                           |
| --------------------- | ----------------------------------------------------------------------------------- |
| 402 (credits)         | Chat shows "OpenRouter credits exhausted"; no retry                                 |
| 429                   | Retry with backoff (AI SDK `maxRetries` 2), then a plain message                    |
| 5xx / provider error  | One retry on `TUTOR_FALLBACK_MODEL`, labelled in the message footer                 |
| Tool validation error | Returned to the model as a tool error (it self-corrects); counts toward `MAX_STEPS` |
| Client abort          | Persist the partial message; keep applied batches; release the lock                 |
| Budget breach         | Abort; message says which cap and offers to raise it in settings                    |

## Stub tutor (tests, offline)

`TUTOR_STUB=1` replaces the model with a scripted sequence from `apps/server/test/fixtures/*.json` (assistant text deltas + tool calls). The rest of the stack (Board service, WebSocket, SSE, chips, Locate) runs for real. Used by Playwright and by UI development without spending credits.

## MCP later (M7, optional)

A second adapter over the same registry exposes the tools at `/mcp` (Streamable HTTP, `@modelcontextprotocol/sdk`), with board-scoped bearer tokens (`agent_tokens` returns), a viewer/editor role, and OAuth 2.1 as in the original doc. Not on the v1 critical path.
