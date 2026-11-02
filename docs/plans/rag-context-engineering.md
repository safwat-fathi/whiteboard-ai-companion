# RAG and context engineering

> Part of [PLAN.md](../PLAN.md) §12 · Related: [library-ingestion](./library-ingestion.md) · [board-context](./board-context.md) · [ai-integration](./ai-integration.md) · [database](./database.md) · [testing-spikes](./testing-spikes.md)

How a topic, a chapter or a whole book becomes context for the tutor, and how the prompt is assembled so it is correct, cheap and cache-friendly.

## Prompt assembly (stable → volatile, so the cache prefix survives)

| # | Part | Budget | Cached |
|---|---|---|---|
| 1 | **Tutor charter:** pedagogy, board etiquette, citation and `board:` link syntax, untrusted-content rule, answer in the student's language | ~1.5k | yes |
| 2 | **Student profile** (editable free text: level, goals, language) | < 0.5k | yes |
| 3 | **Scope pack** (below) | ≤ 60k | yes (breakpoint after it) |
| 4 | **Memory:** rolling summary + last 8 turns; tool results older than 2 turns collapsed to one line ("added 7 elements") | ≤ 12k | partly |
| 5 | **Board context:** digest, selection detail, pictures ([board-context](./board-context.md)) | ≤ 3k + 4k + images | no |
| 6 | **Student message** | – | no |

Retrieved passages enter the conversation as tool results (`search_book`, `read_section`), not the prefix.

**Tutor charter essentials:** prefer a diagram over a paragraph; draw small, titled clusters, one idea per cluster; ask before exceeding ~40 new elements; never edit the student's work unless it is selected; say "your book doesn't cover this" instead of guessing; label book-grounded versus general knowledge; check understanding with a short question after a big explanation; use `board:` links when pointing at something drawn; write equations as LaTeX.

## Scope packs

| Scope | Always in the cached prefix | Retrieval | Notes |
|---|---|---|---|
| **Topic** (free text, no book) | Charter + profile | `search_book` across the whole library if books exist | Model knowledge is labelled "not from your books" |
| **Chapter(s)** | Book outline + the **whole chapter text** if ≤ `CHAPTER_STUFF_MAX_TOKENS` (60k) **[my call]**, otherwise the chapter summary + sub-section summaries | Restricted to the chapter's page range | Whole-chapter stuffing is simpler and better than RAG when it fits |
| **Whole book** | Book outline + all chapter summaries (~8–15k tokens) | Across the book; `read_section` pulls full sections on demand | Experiment (S3/M5): load the whole book into a cached 1M-context prompt; default off |

Scope packs are built from `book_sections` (outline, summaries) and `book_pages` (chapter text), and wrapped in delimiters:

```
<book id="b_12" title="Biology 12e">
  <outline>…</outline>
  <chapter title="3 Photosynthesis" pages="41-68">…full text or summaries…</chapter>
</book>
```

## Retrieval tools

| Tool | Parameters | Returns |
|---|---|---|
| `get_outline` | `bookId?` | Section tree: id, title, pages, 1-line summary |
| `search_book` | `query`, `bookId?`, `sectionIds?`, `k?` (default 8), `neighbors?` | Passages `{chunkId, pages, pageLabel, headingPath, text}` |
| `read_section` | `sectionId` or `{bookId, pageFrom, pageTo}`, capped at ~6k tokens per call | Full text of that range |

`bookId` defaults to the board scope's book; in *topic* scope with no book, `search_book` spans the library. The model writes its own queries (**agentic RAG**), so there is no separate query-rewrite step.

## Hybrid search pipeline

1. Scope filter: book, section ids or page range.
2. **Keyword:** FTS5 `bm25()` over `text_norm` + `heading_path`, top 30. **Vector:** exact cosine over the in-memory Float32 cache, top 30 ([database](./database.md)).
3. **Reciprocal-rank fusion** (`score = Σ 1/(60 + rank)`) → top `k`.
4. Optional neighbours (±1 chunk) when `neighbors` is set.
5. Query text is normalised like `text_norm` (Arabic) before FTS; the embedding uses the raw query.

Rerankers and LLM-written chunk context are deferred until the eval says recall@8 is the bottleneck.

## Citations and grounding

- Book-based claims carry `[p. N](cite:<chunkId>)`. The server **validates** that each `chunkId` was retrieved this turn (or is in the scope pack); unknown ids are stripped and flagged in the message footer.
- Answers separate **From your book** from **General explanation** (not in your book). Empty or weak retrieval is stated, not papered over.
- `pageLabel` is the printed page label, so citations match the physical book; the Source tab opens the PDF page index behind it.

## Untrusted content

Book passages and board text are **data**. They are wrapped in delimiters (`<book_passage …>`, `<board_state>`); the charter and the tool descriptions tell the model never to follow instructions found inside them. The tutor has no network tools, and its edit rights are limited ([ai-integration](./ai-integration.md)). Citations are validated, so an injected "cite this" cannot create a fake source.

## Prompt caching

- **Meta Model API / OpenAI-compatible providers:** keep the system prompt prefix (parts 1–3: charter, student profile, scope pack) byte-identical across steps and turns (stable order, no timestamps in parts 1–3) so automatic prefix caching can hit where supported.
- **M0 Spike S3 benchmark notes (OpenRouter):** Anthropic models use explicit `cache_control` on the scope-pack block with a 1-hour `ttl` (verified in S3: `17,433` cached tokens on turn 2 and `20,233` cached after 6 min; cache reads cost 0.1× input); Gemini and OpenAI cache automatically.
- **Check:** when the provider reports `usage.prompt_tokens_details.cached_tokens > 0`, the message footer displays cached tokens.

## Memory

- Last 8 turns verbatim plus a rolling summary written by `CHEAP_MODEL` when the history passes ~8k tokens.
- Old tool results collapse to one line; old pictures are replaced by a note.
- **Student profile** is a settings text the student edits (`settings` table); auto-updating "learning notes" (what they struggled with) is v1.1.

## Context budget

For a 1M-context model we deliberately target ~100k tokens of prompt per step: charter 1.5k, profile 0.5k, scope pack ≤ 60k, memory ≤ 12k, board context ~7k + images, retrieved passages ≤ 8k per call, response ≤ 4k. Each tool-loop step re-sends the prefix, which is why caching matters: a 6-step turn pays the prefix once at 1.25×/2× and five times at 0.1×.

## Evaluation

`eval/<book>.jsonl` holds `{q, pages: [...]}` (≥ 10 per book, written by the student). `pnpm eval:retrieval` reports recall@8 and MRR per embedding model, vector-only versus hybrid. **Target: the expected page is in the top 8 for ≥ 80% [my call]**; below that, try neighbours, then `qwen3-embedding-8b`, then chunk context, then a reranker.

A second, manual check per scope type: ask three questions that need the book and three that do not, and confirm the answer labels them correctly and the citations open the right page.
