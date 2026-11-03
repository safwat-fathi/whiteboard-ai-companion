# AI integration (tutor agent)

> Part of [PLAN.md](../PLAN.md) §8 (resolution R2) · Related: [chat-ui](./chat-ui.md) · [board-context](./board-context.md) · [rag-context-engineering](./rag-context-engineering.md) · [jump-to-ai](./jump-to-ai.md) · [api](./api.md)

Everything between the chat dock and the AI providers: the **Meta Model API** provider (and OpenRouter for embeddings), the tool loop, the tool registry, limits and tests. What goes _into_ the prompt is in [rag-context-engineering](./rag-context-engineering.md) and [board-context](./board-context.md).

## Provider

- **Meta Model API (`MODEL_API_KEY`) for all LLM and vision roles.** Used for: chat completions with tool calling and multimodal image input (tutor, Arabic tutor, fallback, reviewer), cheap ingestion/memory summaries (`CHEAP_MODEL`), and scanned/math page transcription (`VISION_MODEL`, [library-ingestion](./library-ingestion.md)). Connects to `META_API_BASE_URL` (default `https://api.meta.ai/v1`) via `@ai-sdk/openai-compatible`.
- **OpenRouter (`OPENROUTER_API_KEY`) for embeddings only.** Used exclusively at runtime for `baai/bge-m3` embeddings (`POST https://openrouter.ai/api/v1/embeddings`) since Meta's hosted API does not expose an embeddings endpoint, and retained for the historical M0 S2–S4 benchmark scripts (`spikes/`).
- Both keys live **only in the server environment**. The browser never talks to the Meta Model API or OpenRouter.
- Libraries: `ai` 7.0.159 and `@ai-sdk/openai-compatible` 3.0.82 on the server, exact pins (the web app uses `ai` only: `DefaultChatTransport` and `readUIMessageStream`; there is **no** `@ai-sdk/react`) (plus `@openrouter/ai-sdk-provider` 3 in M0 spike benchmarks; [tech-stack](./tech-stack.md)). All AI SDK server code is behind one adapter module, `apps/server/src/tutor/llm.ts`.
- Provider options: configure `createOpenAICompatible({ name: 'meta-llama', baseURL: process.env.META_API_BASE_URL ?? 'https://api.meta.ai/v1', apiKey: process.env.MODEL_API_KEY, includeUsage: true })`. (In M0 Spike S3 on OpenRouter, `extraBody: { provider: { data_collection: 'deny' } }` was verified to route cleanly.)

## Models (Meta Model API active defaults + M0 S3 benchmarked baseline)

Built for the **[Meta AI Developer Hackathon](https://cerebralvalley.ai/e/meta-ai-developer-hackathon)** (Meta × Cerebral Valley), Whiteboard AI Companion uses **Meta models** via the Meta Model API (`https://api.meta.ai/v1`) as active defaults across all generative and vision roles, while preserving `baai/bge-m3` via OpenRouter strictly for dense vector embeddings:

| Role                | Env                    | Active Default (Meta Model API)            | Alternative / OpenRouter IDs                                               | Use                                                                                 |
| ------------------- | ---------------------- | ------------------------------------------ | -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Tutor (English)     | `TUTOR_MODEL`          | `muse-spark-1.3`                           | `meta-llama/llama-4-maverick` (OpenRouter) · `muse-spark-1.2`              | English boards: chat, tool loop orchestration, math reasoning, native vision        |
| Tutor (Arabic)      | `TUTOR_MODEL_AR`       | `muse-spark-1.3`                           | `meta-llama/llama-4-maverick` (OpenRouter)                                 | Arabic boards: multilingual chat, tool loop, RTL math/diagram explanation           |
| Reviewer (optional) | `REVIEWER_MODEL`       | `muse-wonder-1.0`                          | `muse-spark-1.3` · `meta-llama/llama-4-maverick` (OpenRouter)              | Second-pass pedagogical & Arabic quality review if enabled                          |
| Tutor fallback      | `TUTOR_FALLBACK_MODEL` | `muse-spark-1.3`                           | `muse-spark-1.2` · `meta-llama/llama-4-scout` (OpenRouter)                 | Automatic one-retry fallback on 5xx / upstream provider errors                      |
| Cheap               | `CHEAP_MODEL`          | `muse-spark-1.3`                           | `muse-spark-1.2` · `meta-llama/llama-4-scout` (OpenRouter)                 | Book/chapter/section summaries, rolling chat memory, TOC inference                  |
| Vision              | `VISION_MODEL`         | `muse-spark-1.3`                           | `muse-wonder-1.0` · `meta-llama/llama-4-maverick` (OpenRouter)             | Whiteboard snapshot inspection & scanned/math PDF page transcription ([library-ingestion](./library-ingestion.md)) |
| Embeddings          | `EMBED_MODEL`          | `baai/bge-m3` *(via `OPENROUTER_API_KEY`)* | –                                                                         | Indexing and queries (`1024-d`, multilingual; `$0.01/M` tokens) **(S4b)**           |

### Previously Benchmarked Models (M0 Spike S3 via OpenRouter, 2026-11-02)

Before switching the active runtime provider to the Meta Model API, Spike S3 ([`spikes/s3-openrouter/RESULT.md`](../../spikes/s3-openrouter/RESULT.md)) benchmarked four candidate models via OpenRouter on tool-loop reliability, streaming cost reporting, `tool-result-image` support, 1-hour prompt caching, `data_collection: 'deny'`, and Arabic pedagogical quality:

| Role (S3 Baseline)  | Env                    | Benchmarked Model (OpenRouter ID) | $/M in / out | S3 Benchmark Findings                                                                 |
| ------------------- | ---------------------- | --------------------------------- | ------------ | ------------------------------------------------------------------------------------- |
| Tutor (English)     | `TUTOR_MODEL`          | `anthropic/claude-haiku-5.5`      | 0.10 / 0.50  | Passed all tool-loop, vision & 1h cache checks (`$0.0005`/turn); English-only (3/5 AR) |
| Tutor (Arabic)      | `TUTOR_MODEL_AR`       | `google/gemini-3.8-flash`         | 0.75 / 3.75  | Passed tool-loop (5 calls, `$0.0049`), auto-caching & Arabic (3.5/5; needs language rule) |
| Reviewer (optional) | `REVIEWER_MODEL`       | `anthropic/claude-sonnet-5.5`     | 2.00 / 10.00 | Strongest Arabic rating (**4.5/5**), 4 tool calls (`$0.0118`), 1h cache hit verified  |
| Candidate (dropped) | –                      | `openai/gpt-6-luna`               | –            | Cheapest (`$0.0002`/turn) and passed tool/cache checks, but rated **2.5/5** on Arabic |
| Cheap               | `CHEAP_MODEL`          | `anthropic/claude-haiku-5.5`      | 0.10 / 0.50  | Section summaries (`$0.0006` for 150–400 tokens)                                      |
| Vision              | `VISION_MODEL`         | `google/gemini-3.8-flash`         | 0.75 / 3.75  | Benchmarked in S2 as R4 page-transcription fallback                                   |

**Cost envelope** (combining S2–S4 measurements with Meta Llama API / OpenRouter pricing):

- Index a 400-page book: `baai/bge-m3` embeddings ≈ `$0.002` (S4b measured `$0.0058` across 3 books); `CHEAP_MODEL` summaries ≈ `$0.01–0.04`; `VISION_MODEL` transcription on scanned/math pages ≈ `$0.05–0.40` (S2 also benchmarked OpenRouter `mistral-ocr` at `$0.0205` / 10 pages).
- One tutor turn (60k scope pack, ~6 steps): ≈ `$0.002–0.03` on Llama 4 Maverick / Scout or Llama 3.3 70B (compared to `$0.0005–0.012` for a 2-step toy turn on the S3 benchmarked models).

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

- **Caps per turn:** `MAX_STEPS` (12), `MAX_TURN_COST_USD` (0.50), 120 s wall clock, a soft element budget (~40 new elements; the charter says ask before more). **Per day:** `DAILY_BUDGET_USD`, summed from the `spend` ledger (turns, embeddings, summaries, vision transcription). Breach aborts with a plain message in the chat.
- **Cost must arrive while streaming.** With the Meta Model API (`@ai-sdk/openai-compatible` configured with `includeUsage: true`), each streamed step reports token usage (`usage.inputTokens`, `usage.outputTokens`); `apps/server/src/tutor/llm.ts` computes step USD cost in `onStepFinish` from a per-model price table (`inputTokens * inPrice + outputTokens * outPrice`), falling back to `providerMetadata.openrouter.usage.cost` when present (verified in **[Spike S3]** on OpenRouter with `compatibility: 'strict'` and `usage: { include: true }`).
- **Edit rights (anti-goal):** the Board service rejects agent patches/removes on `author.kind = human` elements unless the id was **selected when the turn started** (`grantedIds`). The tutor may always add and may edit its own elements. `locked` is honoured.
- **Citations validated:** `cite:` ids must be in the set retrieved this turn; unknown ids are stripped and flagged.
- **Untrusted content:** book passages and board text are delimited data; the charter and tool descriptions say never to follow instructions found in them. The tutor has no network tools.
- **Concurrency:** one turn per board; a second request gets `turn_busy`.
- **Reasoning:** low effort for chat turns, higher for "plan and draw a chapter" (configurable).

## Snapshots to the model

In **S3** on OpenRouter, `toModelOutput` returning a `file` part (`mediaType: 'image/png'`, `data: {type:'data', data}`) inside tool results passed on all four benchmarked models (`SNAPSHOT_ADAPTER=tool-result-image`). However, the **Meta Model API** (`https://api.meta.ai/v1`) explicitly rejects multipart images inside `role: 'tool'` messages with HTTP 400 (`messages[2].content did not match any supported type`). Therefore, `SNAPSHOT_ADAPTER=follow-up-user` is configured by default: the tool result carries text (ids, bounds, `"snapshot attached"`), and the server appends a **user** message containing the snapshot PNG (≤ 1600 px long side). Context pictures attached by the student ([board-context](./board-context.md)) are ordinary image parts of the user message.

## Prompt caching hooks

Keep the system prompt prefix (charter + profile + scope pack) byte-identical across steps and turns (passed via AI SDK 7 `instructions`) so automatic prefix caching hits on providers that support it. (In **S3** on OpenRouter, explicit `cache_control` with 1-hour `ttl` on Anthropic and automatic caching on Gemini/OpenAI were verified via `usage.prompt_tokens_details.cached_tokens > 0` on turn 2.) Full strategy: [rag-context-engineering](./rag-context-engineering.md).

## Errors and fallback

| Condition             | Behaviour                                                                           |
| --------------------- | ----------------------------------------------------------------------------------- |
| 402 (credits/quota)   | Chat shows "AI provider quota/credits exhausted"; no retry                          |
| 429                   | Retry with backoff (AI SDK `maxRetries` 2), then a plain message                    |
| 5xx / provider error  | One retry on `TUTOR_FALLBACK_MODEL`, labelled in the message footer                 |
| Tool validation error | Returned to the model as a tool error (it self-corrects); counts toward `MAX_STEPS` |
| Client abort          | Persist the partial message; keep applied batches; release the lock                 |
| Budget breach         | Abort; message says which cap and offers to raise it in settings                    |

## Stub tutor (tests, offline)

`TUTOR_STUB=1` replaces **only the model** with `MockLanguageModelV4` (from `ai/test`) playing a scripted fixture from `apps/server/test/fixtures/tutor/*.json`: `{match, steps:[{text?, toolCalls?, usage?, chunkDelayMs?}]}`, chosen by a substring of the student's message (`*` matches anything); `$BOOK_ID` and `$PAGE_0` in a step are filled from the board's scope; the last step repeats once the list runs out, so a single tool-call step is a runaway loop for the cap tests. The loop, tools, Board service, WebSocket, SSE, caps and persistence run for real. With the stub on, `GET /api/_test/last-request?boardId=` returns what the model was asked (system prompt, messages with images reduced to byte counts, tool names) so specs can assert the digest and pictures. Used by Vitest and Playwright (`e2e-server/m5-*.spec.ts`).

## M5 as built (2026-11-03)

- **Tools: 15** (`get_board get_elements get_snapshot add_text add_math add_shape connect add_diagram add_book_figure update_elements delete_elements focus_region get_outline search_book read_section`). Board tools are pure builders in `packages/core/src/tools` (`ToolDef` with a zod input, `execute(input, ctx) → read | write | focus`); book, figure and snapshot tools live in `apps/server/src/tutor/tools`; `adapt()` maps both to AI SDK `tool()`. A turn's tool calls run one at a time. `add_diagram` is a layered layout written by hand. Errors the model can fix (bad LaTeX, a missing id, an edit it may not make) are thrown as plain messages and arrive as tool errors.
- **Edit rights** live in `BoardService.submit` (`agentMayEdit`); see PLAN §19 #49.
- **Pricing is optional** (PLAN §19 #50): tokens are always counted, USD only when `TUTOR_PRICE_IN_PER_M`/`TUTOR_PRICE_OUT_PER_M` are set; `MAX_TURN_COST_USD` then applies. `TUTOR_REASONING_EFFORT` is optional and off by default. Model latency is 15–25 s per step, so `TURN_TIMEOUT_MS` (default 120000) may need raising for long turns.
- **Fallback** is a model wrapper: a 5xx before any output goes once to `TUTOR_FALLBACK_MODEL`; 402 and 429 are worded for the student and never echo the provider's text.

## MCP later (M7, optional)

A second adapter over the same registry exposes the tools at `/mcp` (Streamable HTTP, `@modelcontextprotocol/sdk`), with board-scoped bearer tokens (`agent_tokens` returns), a viewer/editor role, and OAuth 2.1 as in the original doc. Not on the v1 critical path.
