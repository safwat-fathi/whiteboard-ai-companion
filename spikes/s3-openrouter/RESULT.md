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
Rule: answer entirely in the user's language; math only as `$...$` / `$$...$$`. Luna now emits `$` math (0 `\(` or `\[` delimiters), so its 2.5 was a delimiter issue, fixable by prompt (and by normalising delimiters in the renderer). Outputs: `out/arabic-openai_gpt-6-luna-rules.md`, `out/arabic-google_gemini-3.8-flash-rules.md` (cost $0.0003 and $0.013). **Re-rating pending.** Either way the tutor system prompt should carry this rule.
