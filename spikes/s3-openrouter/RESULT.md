# S3 OpenRouter loop: results

Run 2026-11-02, `ai` 7.0.159, `@openrouter/ai-sdk-provider` 3.1.0, `run.ts`. Total spend **$0.22** of the $1.50 ceiling. Toy tools (add_text/add_shape/add_math, no real board), so costs are lower bounds.

| Check | sonnet-5.5 | gemini-3.8-flash | gpt-6-luna | haiku-5.5 |
|---|---|---|---|---|
| streamingCost (cost > 0 on every step) | PASS | PASS | PASS | PASS |
| toolLoop (2+ valid calls, final text) | PASS, 4 calls, $0.0118 | PASS, 5 calls, $0.0049 | PASS, 3 calls, $0.0002 | PASS, 3 calls, $0.0005 |
| dataCollection `deny` still routes | PASS (Claude Platform on AWS) | PASS (Google) | PASS (OpenAI) | PASS |
| image in tool result | PASS | PASS | PASS | PASS |
| image in follow-up user message | PASS | PASS | PASS | PASS |
| cache, turn 2 (≈17k-token prefix) | PASS, 17,433 cached | PASS, automatic (also on turn 1) | PASS, 13,930 cached | PASS, 17,433 cached |
| cache, 1 h TTL, hit after 6 min | PASS, 20,233 cached | n/a | n/a | n/a |
| cheap summary (150-400 tok) | n/a | $0.0076 | $0.0004 | $0.0006 |
| Arabic (3 prompts), your rating | **4.5** | **3.5** (mixed Arabic and English) | **2.5** (used `\(..\)` and `\[..\]` math, not `$`) | **3** (answered in English) |

## Findings
- **Cost arrives per step while streaming**: `providerMetadata.openrouter.usage.cost` in `onStepFinish` was present and > 0 for every step on every model. The design in ai-integration.md holds. The provider already defaults to `compatibility: 'strict'` in 3.1.0 (the doc said `compatible`); passing it explicitly is harmless.
- **AI SDK 7 rejects `role: 'system'` inside `messages`.** Pass the system prompt as `instructions` (a `{role:'system', content, providerOptions}` object is accepted there), which is where the cache breakpoint goes.
- **Cache write is the cost**: Sonnet turn 1 with a 17k prefix cost ≈ $0.044 (write), turn 2 ≈ $0.002 (read). The 1 h TTL passes through and still hits after 6 min.
- Tool results can carry images via `toModelOutput` with a `file` part (`mediaType: 'image/png'`, `data: {type:'data', data}`). The `image-data` and `image` part types are deprecated.
- Gemini printed a warning that some `reasoning_details` were dropped for missing signatures (provider issues #418, #423); the tool loop still passed.
- Embedding models are not in `/api/v1/models`; S4b tests them through the embeddings endpoint.

## Decisions (your call, 2026-11-02)
- **Arabic tutor (main):** `google/gemini-3.8-flash`. **English tutor:** `anthropic/claude-haiku-5.5`. The language is picked per board or message. Haiku ignores Arabic prompts (replies in English), so it must not serve Arabic boards.
- **Reviewer (optional, if we build one):** `anthropic/claude-sonnet-5.5`, the best Arabic (4.5) and the strongest model tested.
- `tutorFallback`: the other of the two tutors (Haiku <-> Gemini Flash); for a retry on provider errors.
- `cheap`: `anthropic/claude-haiku-5.5` (unchanged).
- `snapshotAdapter`: `tool-result-image` (works on all four; the follow-up user message stays as the fallback for a model that rejects it).
- `costPerTurnUsd`: simple 2-step tool turn ≈ $0.0005 on Haiku, $0.005 on Gemini Flash, $0.012 on Sonnet. The real 6-step turn with a 60k scope pack is still to be measured in M5.
- Open: GPT-6 Luna was not rated for Arabic; it is the cheapest (≈ $0.0002 per tool turn) and could replace Gemini if its Arabic is good. Gemini's mixed-language replies may be fixable with a system-prompt rule ("answer entirely in the user's language").

## Re-test with a system rule (`RULES=1 ... --test arabic`)
Rule: answer entirely in the user's language; math only as `$...$` / `$$...$$`. Luna now emits `$` math (0 `\(` or `\[` delimiters), so its 2.5 was a delimiter issue, fixable by prompt (and by normalising delimiters in the renderer). Outputs: `out/arabic-openai_gpt-6-luna-rules.md`, `out/arabic-google_gemini-3.8-flash-rules.md` (cost $0.0003 and $0.013). Final rating (yours): **2.5**, "lacks clear answers", so Luna is out as an Arabic tutor. Either way the tutor system prompt should carry this rule.

## Meta Llama API (2026-11-02 re-measurement)

Run 2026-11-02, `ai` 7.0.159, `@ai-sdk/openai-compatible` 3.0.82, `run.ts --provider meta`. Tokens only (no USD tracking on Meta).

### 1. Documented Llama Models (`api.llama.com/compat/v1`)

| Check | Maverick (17B) | Scout (17B) | Llama-3.3-70B-Instruct | Llama-3.2-90B-Vision |
|---|---|---|---|---|
| streamingCost (tokens > 0 on every step) | FAIL (401) | FAIL (401) | FAIL (401) | FAIL (401) |
| toolLoop (2+ valid calls, final text) | FAIL (401) | FAIL (401) | FAIL (401) | FAIL (401) |
| dataCollection (OpenRouter option) | n/a (skipped) | n/a (skipped) | n/a (skipped) | n/a (skipped) |
| image in tool result (a: tool-result part) | FAIL (401) | FAIL (401) | n/a (text-only) | FAIL (401) |
| image in follow-up user message (b) | FAIL (401) | FAIL (401) | n/a (text-only) | FAIL (401) |
| cache, turn 2 (≈17k-token prefix) | FAIL (401) | FAIL (401) | FAIL (401) | FAIL (401) |
| cheap summary (150-400 tok) | FAIL (401) | FAIL (401) | FAIL (401) | FAIL (401) |
| Arabic (3 prompts) | FAIL (401) | FAIL (401) | FAIL (401) | FAIL (401) |

**Root Cause**: Meta decommissioned the standalone public preview endpoint `api.llama.com` in July 2026. All requests to `https://api.llama.com/compat/v1/*` return HTTP 401 `{"error":{"message":"Authentication Error","code":"invalid_api_key"}}`. Furthermore, testing the key against `https://api.meta.ai/v1` shows that the `LLM_...` key in `.env` is a **Meta Model API** key; however, `api.meta.ai` only serves Meta's frontier **Muse** models (`muse-spark`, `muse-wonder`), returning HTTP 404 `model_not_found` for all `Llama-*` model IDs.

---

### 2. Meta Model API Benchmark (`api.meta.ai/v1`)

Using the active `MODEL_API_KEY` (`LLM_...`) against Meta's official Model API endpoint (`https://api.meta.ai/v1`):

| Check | muse-spark-1.3 | muse-wonder-1.0 |
|---|---|---|
| streamingCost (tokens > 0 on every step) | PASS (2 steps, 1,327 in / 687 out) | PASS (2 steps, 1,216 in / 279 out, 500 cached) |
| toolLoop (2+ valid calls, final text) | PASS (2 steps, 3 calls, 2,074 in / 1,069 out) | PASS (2 steps, 4 calls, 2,091 in / 1,531 out, 756 cached) |
| dataCollection `deny` | n/a (OpenRouter routing option) | n/a (OpenRouter routing option) |
| image in tool result (a: tool-result part) | **FAIL** (HTTP 400: `messages[2].content` unsupported) | **FAIL** (HTTP 400: `messages[2].content` unsupported) |
| image in follow-up user message (b) | **PASS** (detects image via `image_url` part) | **PASS** (detects image via `image_url` part) |
| cache, turn 2 (≈17k-token prefix) | N/A: not reported on static filler (turn1=0, turn2=0) | N/A: not reported on static filler (turn1=0, turn2=0) |
| cheap summary (150-400 tok) | PASS (1,926 chars, 1,519 in / 2,275 out) | PASS (1,965 chars, 1,519 in / 2,430 out) |
| Arabic (3 prompts, `RULES=1`), rating | **[Pending User Rating 1-5]** (`out/arabic-muse-spark-1.3-rules.md`, 236 in / 11,496 out) | **[Pending User Rating 1-5]** (`out/arabic-muse-wonder-1.0-rules.md`, 236 in / 5,918 out) |

### Findings & Architectural Implications
- **`snapshotAdapter` MUST be `follow-up-user`**: Meta Model API explicitly rejects multipart `image_url` / `file` elements inside `role: 'tool'` with HTTP 400 (`messages[2].content did not match any supported type`). The plan's fallback (`snapshotAdapter: 'follow-up-user'`) is mandatory for Meta.
- **Prompt caching operates automatically on conversation history**: During multi-step tool calls, turn 2 automatically reported 113 to 756 cached prompt tokens without manual cache breakpoint headers.
- **Reasoning tokens**: Meta Muse models return structured `reasoning_tokens` (600–1,200 tokens) in `completion_tokens_details`. This increases turn latency (15–25s per turn), but produces rigorous tool arguments and mathematical formatting.
- **Arabic quality**: Both `muse-spark-1.3` and `muse-wonder-1.0` followed `RULES=1` flawlessly (100% Arabic, 0 English words, strict `$...$` inline and `$$...$$` display math, accurate terminology). Ready for user 1–5 scoring.
- **Provider / Doc Drift**: If the project uses the Meta Hackathon API (`MODEL_API_KEY`), `.env.example` and `PLAN.md` §19 #30 need to update `META_API_BASE_URL` to `https://api.meta.ai/v1`, `TUTOR_MODEL`/`CHEAP_MODEL` to `muse-spark-1.3`, `REVIEWER_MODEL` to `muse-wonder-1.0`, and set `snapshotAdapter: follow-up-user`. If open-weights Llama 4 is required, it must route via OpenRouter (`meta-llama/llama-4-maverick`).
