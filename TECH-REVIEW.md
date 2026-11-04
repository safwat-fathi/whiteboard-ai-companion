# Technical review: performance, bottlenecks and system design

**Date:** 2026-11-04 · **Commit:** `main` @ `f4f9132` · **Scope:** `apps/server`, `apps/web`, `packages/core`, `packages/math` (spikes ignored)
**Companion:** `docs/REVIEW-2026-11-04.md` covers doc/code alignment. This file covers runtime behaviour, scaling and design.
**Status:** findings written at `f4f9132`; the guardrail batch in §9 was then fixed on top of `fc1844e` (uncommitted).

## 1. Verdict

The architecture is sound for what it is: a **single-owner, single-process, local-first** app. SQLite + WAL, an authoritative op log, optimistic client sync with rollback/replay, an R-tree-culled two-canvas renderer, a stub-model test harness and conflict-aware undo are all good decisions, and the test discipline is unusually strong. Most findings below are **not design errors**. They are *unbounded growth* and *synchronous work on the one event loop* that the single-user assumption currently hides.

Three themes account for most of the risk:

1. **One event loop does everything.** Snapshot gzip, PDF parsing, exports, blob I/O and brute-force vector search all run on the thread that also acks WebSocket edits. Ingest is the only thing already moved to a worker.
2. **Nothing is ever pruned.** Snapshots, the op log, blobs, page-image cache and undo history all grow without a bound or a GC.
3. **AI spend is not actually capped by default.** Cost control depends on optional price env vars, and several paid call paths are never metered.

Severities assume the stated deployment (loopback bind behind Caddy basic auth, one owner). Where severity would change under multi-user, it says so.

## 2. Fix first (ranked)

| # | Finding | Why first | Effort |
|---|---|---|---|
| 1 | **A-01** Spend cap is inert by default; R4 vision, summaries, memory summaries unmetered; no `maxOutputTokens` | Direct money risk: a 2,000-page scanned PDF is unbounded | S |
| 2 | **S-01 / S-05** Snapshots and op log never pruned; unbounded join tail | Disk and join latency grow forever; cheap fix | S |
| 3 | **S-04** `join` gunzips + parses the snapshot even when unused; snapshots stall the loop | Every reconnect pays it; blocks all boards | S |
| 4 | **S-02 / A-09** pdfjs on the main thread in upload, estimate, preview, page-image, `add_book_figure` | 3x file size in RAM and multi-second stalls that freeze sync | M |
| 5 | **A-02** Turn lock can leak until restart; aborted turns lose spend | Board becomes permanently `turn_busy` | S |
| 6 | **S-06** No WebSocket backpressure | Slow reader balloons memory during AI turns | S |
| 7 | **W-05** Chat re-parses all messages per keystroke/token; `Markdown` remounts `MathSpan` each render | Most visible UI jank during streaming | S |
| 8 | **W-01** RenderCache cliff (1.6 fps zoom, dense text, DPR 2) | Already logged as an open owner decision | S–M |
| 9 | **S-08** Missing indexes (`board_ops` batch, `messages`) | Quick wins, confirmed by EXPLAIN | S |
| 10 | **S-03** Unbounded concurrent exports, GET so no Origin gate | Memory spike, cross-site triggerable | S |

## 3. Server core (S-xx)

| ID | Sev | Finding | Evidence | Fix |
|---|---|---|---|---|
| S-01 | High | **Board snapshots never pruned.** `INSERT OR REPLACE` keyed `(board_id, seq)` adds a row per snapshot (every 500 batches, every 5 min active, on evict/close). Grep finds no `DELETE FROM board_snapshots`. | `db/boards.ts:126`, `board-service.ts:216,276,280`, `migrations/0001_init.sql:27` | After each save, delete older seqs (keep newest 1–2). |
| S-02 | High | **pdfjs on the main thread** with whole-file buffering for upload page-count, estimate, preview and page image. Bypasses the worker that `worker.ts` says exists to keep WS responsive. ~3x file size RAM, up to 200 MB. No single-flight per page. | `http-books.ts:171,234`, `library/page-image.ts:36-44`, `library/pdf.ts:~70` | Run all pdfjs work in the worker or a small pool; dedupe by `(book,page,width)`. |
| S-03 | High | **Unbounded export renders.** Up to 4096x8192 (~134 MB RGBA), synchronous `render()`, no semaphore, GET skips the Origin check, so a cross-site `<img>` can trigger it. | `export.ts:103-115,167`, `http.ts:175-214` | Semaphore (1–2) + 429; cache by `(board, headSeq, rect, width)`. |
| S-04 | High | **Heavy sync CPU on the hot path.** `gzipSync(JSON.stringify(scene))` inside `submit` every 500 batches; `tick()` snapshots every live board back-to-back; `join` always calls `latestSnapshot` (gunzip + parse) though it is only needed when `fromSeq < snap.seq`; `DELETE FROM boards` cascades synchronously. | `db/boards.ts:214`, `board-service.ts:216,241,271-284`, `db/boards.ts:190` | `latestSnapshotSeq` query without the blob; async/worker gzip; cap snapshots per tick; chunk deletes. |
| S-05 | High | **Op log never compacted; join tail unbounded.** No `DELETE FROM board_ops`. `join`/`load` use `opsAfter(..., -1)`; snapshot + tail go in one frame with no outbound size cap, so a stalled snapshot (stale board, failures) ships the whole log. | `board-service.ts:254,258,319`, `gateway.ts:114` | Size-cap the tail and fall back to a snapshot; define retention (keep what undo/activity need). |
| S-06 | High | **No WebSocket backpressure.** `ws.send` with no `bufferedAmount` check; heartbeat only kills sockets that stop answering pings. | `gateway.ts:94-96,134-143` | Terminate when `bufferedAmount` > ~4–8 MB (client resyncs by `join`); per-socket message rate cap. |
| S-07 | Med* | **No server-side auth.** Host/Origin checks are CSRF and DNS-rebinding defence, not authentication; WS author hard-coded `OWNER`. Safe only while bound to loopback behind Caddy basic auth (the default). *Critical if ever bound to `0.0.0.0` without a firewall.* | `http.ts:129-152`, `gateway.ts:11,69-73`, `config.ts:145`, `deploy/Caddyfile:5` | Refuse non-loopback bind unless an auth secret is set, or add a bearer check; warn at startup. |
| S-08 | Med | **Missing/ineffective indexes** (EXPLAIN-confirmed). `board_ops` by `batch_id` scans the whole board; `messages` page sorts via temp B-tree; `messages.byTurn` + `opsByTurn` is 2N queries per activity page; `usage.tokensByDay` is `SCAN messages` with `json_extract`; `book_sections` lacks a `book_id` index. | `db/boards.ts:123`, `db/messages.ts:52,57`, `tutor/activity.ts`, `db/usage.ts:13` | `board_ops(board_id,batch_id)`, `messages(board_id,turn_id)`, `(role,created_at)` or a cost column, `book_sections(book_id)`. |
| S-09 | Med | **Blobs never garbage-collected.** `remove` only for book files; deleting a board or element leaves blob rows/files; `quota` error code unused. | `http-books.ts:195`, `db/boards.ts:190` | Mark-and-sweep from latest scenes; total-bytes cap. |
| S-10 | Med | **Sync blob I/O.** `readFileSync` + copy per GET (up to 10 MB), HEAD reads the whole file, double hashing, no fsync before rename (post-crash empty file looks present via `existsSync`), no Range/ETag. | `blobs.ts:96-111`, `http.ts:240,267` | `createReadStream`, answer HEAD from the row, hash once, fsync temp file. |
| S-11 | Med | **`synchronous=NORMAL` + ack-after-commit.** On host power loss the client can be ahead of the server and `join` overwrites its acked edits. Process crash is safe. | `db/open.ts:18`, `gateway.ts:123`, `board-service.ts:242` | Document, or `FULL` for board writes (cheap at this write rate). |
| S-12 | Med | **Vector search on the main thread.** Cold cache does a blocking `chunksOf(withEmbedding)`; brute-force `topK` on the loop. ~100k chunks x 1024 dims = tens to hundreds of ms stall. | `library/search.ts:13-51,75-118` | Worker thread or sqlite-vec past ~100k chunks. |
| S-13 | Med | **Writer contention with the ingest worker.** `busy_timeout=5000` makes the main thread sleep inside SQLite for up to 5 s while indexing. | `db/open.ts:20`, `library/worker.ts:40`, `db/books.ts:92` | Low timeout + retry on main, or serialise writes. |
| S-14 | Med | **No HTTP timeouts/limits configured** (`requestTimeout`, `headersTimeout`, `maxConnections`). Node defaults may cut a 200 MB upload on a slow link. Default value not verified here. | `http.ts:282`, `library/files.ts:9` | Set explicitly; idle-timeout for the upload route. |
| S-15 | Med | **Container/process hardening.** Root user, dev deps, `COPY . .`, `pnpm … start` wrapping `tsx` as PID 1 (SIGTERM may not reach node → final snapshots skipped), no `HEALTHCHECK`, no systemd memory/restart limits. | `Dockerfile:2-15`, `deploy/whiteboard-server.service:9` | Build to JS, `CMD node`, `USER node`, `--init`, healthcheck, `MemoryMax`, `TimeoutStopSec`. |
| S-16 | Med | **Backup gaps.** `VACUUM INTO` onto the same disk; off-box only if `RCLONE_REMOTE` set; no integrity check; blobs and DB copied at different instants; no restore runbook. | `deploy/backup.sh:15-29`, `db/migrate.ts:31` | Mandatory/loud off-box, `integrity_check`, restore doc. |
| S-17 | Low | Page-image cache unbounded (any width 256–2048, ~1,800 variants/page). | `library/page-image.ts:32` | Snap widths to buckets; cap size. |
| S-18 | Low | Deleting a board leaves sockets subscribed to an orphan set; `settings` rows leak. | `board-service.ts:100` | Close with 4404; delete keys. |
| S-19 | Low | Broadcast stringifies once per subscriber. | `gateway.ts:111` | Stringify once. |
| S-20 | Low | Cold `load` replays every op with no try/catch; one bad op makes the board unopenable. | `board-service.ts:319` | Log, skip, flag; fall back to snapshot. |
| S-21 | Low | Server does not dedupe by `batchId` on the snapshot path; yields a spurious "not accepted" notice. | `sync.ts:130,159`, `scene.ts:90` | Return the stored seq if the batch exists (needs the S-08 index). |
| S-22 | Low | `/api/health` omits writability, WAL size, live boards, clients. | `http.ts:161` | Add; the methods exist. |

## 4. AI / RAG pipeline (A-xx)

| ID | Sev | Finding | Evidence | Fix |
|---|---|---|---|---|
| A-01 | High | **Spend cap is inert by default.** `price` is null unless `TUTOR_PRICE_*` is set, so `costOf` returns null, the turn writes spend only if `cost > 0`, and the daily and per-turn caps never fire. R4 vision, section summaries and memory summaries are never recorded (`addSpend` accepts `summary`/`vision` but nothing writes them). `streamText` sets no `maxOutputTokens`. Worst case: 2,000 R4 pages x 12k (24k on retry). | `config.ts:101-141`, `tutor/turn.ts:150,251,354`, `llm.ts:38`, `db/books.ts:544`, `library/providers.ts:118,274` | Set `maxOutputTokens`; record token usage per call with a price table (or flag "unpriced" loudly); count R4/summaries in `budget()`; refuse to run unpriced under a non-zero cap. |
| A-02 | Med | **Turn lock can leak.** `active.set` at `:165`, but `messages.append` at `:176` is outside the try/catch that releases it, so a SQLite error leaves the board `turn_busy` until restart. After abort/error `result.steps` is `.catch(() => [])`, so spend is lost; spend is written only at the end, so a crash mid-turn leaves applied ops with no spend row. | `tutor/turn.ts:165-176,308,353-360` | `try/finally` around everything after the lock; accumulate usage in `onStepFinish`. |
| A-03 | Med | **Retry/fallback is weaker than it looks.** Default fallback model == primary; fallback is an immediate duplicate call nested in the SDK's `maxRetries: 2` (up to 6 calls on a 5xx outage); `RetryError` has no `statusCode`, so the "rate limited"/"quota" messages are probably unreachable (inferred from SDK source, not run); no jitter. | `config.ts:103`, `llm.ts:56,109`, `turn.ts:290` | Unwrap `lastError`; skip fallback when identical; no SDK retry on the fallback leg. |
| A-04 | Med | **Context size estimated, not measured.** Three estimators disagree (chars/3, chars/4, flat 1,500 per image). LaTeX/Arabic likely tokenize denser than assumed, so the 60k-est. pack may be well over. `search_book` can return ~60 chunks; only `read_section` is capped; every later step resends earlier tool results. | `tutor/scope.ts:5`, `library/chunk.ts:30`, `context.ts:12`, `tools/book-tools.ts:96`, `config.ts:121` | Cap tool-result tokens per call and per turn; calibrate chars/token from observed `inputTokens`. |
| A-05 | Med | **Untrusted book text has system-role privilege.** Scope pack goes in `instructions`; `defang` is an 8-tag allowlist; the summariser prompt interpolates raw page text with no defang, so a hostile PDF can inject into a stored summary the tutor later trusts. Blast radius is limited (no network tools; edits constrained; cites validated). | `turn.ts:260`, `prompts.ts:35`, `scope.ts:10`, `ingest.ts:327` | User-role placement or strict defang; treat stored summaries as untrusted. |
| A-06 | Med | **Abort stops the model, not tools or retries.** Tools take no `abortSignal`; `retryFetch` has no signal, timeout or jitter (waits up to 1.5/3/6 s). | `http-tutor.ts:66`, `board-tools.ts:136`, `book-tools.ts:108`, `providers.ts:37-67` | Thread the signal into tools and `embed`; `AbortSignal.timeout` per request. |
| A-07 | Med | **Chat memory gap + O(n) scan + race.** Messages between the summary's `upTo` and the 16-message window are in neither until the 8k trigger fires. `maybeSummarise` parses up to 1,000 messages after every turn, runs after the lock is released, and is unmetered. | `tutor/memory.ts:63-101` | Summarise incrementally on window eviction from a stored counter; run under the lock. |
| A-08 | Med | **Retrieval guardrails.** Always adds 30 vector candidates with no score floor, so the "nothing matched" branch almost never fires; cross-book RRF ties weak and strong books; FTS drops one-letter tokens (`x`, `a`) and has no stopwords; no rerank/MMR; `ftsSearch` MATCHes the whole table then filters `book_id`; a failed query embedding silently degrades to keyword-only. | `library/search.ts:189,226-233`, `chunk.ts:20`, `db/books.ts:264`, `book-tools.ts:123` | Cosine floor; normalised cross-book fusion; log degraded mode; rerank only if eval shows recall is the bottleneck. |
| A-09 | Med | **Ingest robustness.** `retryFetch` throws on non-429 4xx and `pool` stops on first failure, so one bad page aborts the book and fails the same way on retry; queue is in-memory/serial with no auto-resume; embedding batches sequential; worker has no `resourceLimits` or watchdog; peak ≈ 3x file size (bytes + pdfjs copy + pdf-lib doc). | `providers.ts:56`, `ingest.ts:44-63,101,145,227`, `queue.ts`, `main.ts:39` | Per-page quarantine after N failures; worker limits + timeout; auto-resume. |
| A-10 | Low–Med | **Eval is a weak regression gate.** 30 questions total (±25 pts CI per book), manual, no stored baseline, retrieval-only, not in CI. | `eval/*.jsonl`, `.github/workflows/ci.yml` | Larger sets; snapshot metrics JSON and diff; stub-embedding smoke test in CI. |
| A-11 | Low | **Wasted re-embedding/summarising.** `createBook` uses a fresh UUID so a re-upload re-does everything (blob is deduped, book is not); an `EMBED_MODEL` change clears section summaries that don't depend on it; query embeddings uncached. | `http-books.ts:244`, `ingest.ts:201` | Dedupe by `file_blob`; key embeddings by hash(text, model); keep summaries. |
| A-12 | Low | **Prompt-cache friendliness partial.** System prefix is stable (good), but the sliding 16-message window changes the history prefix every turn; `costOf` bills cached tokens at full price (over-reports). | `memory.ts:66`, `llm.ts:37` | Stable summary boundary; cache-aware pricing if the provider reports it. |
| A-13 | Low | **Concurrency/idempotency.** One turn per board only; N boards can overshoot the daily cap by N x `maxTurnCostUsd`; no client idempotency key; undo marks written non-atomically after `submit`. | `turn.ts:131,146`, `undo.ts:50-60` | Global reservation; idempotency key; one transaction. |
| A-14 | Low | **Search allocations.** Scoped queries copy a `Float32Array` per query; a topic-scope board loads every ready book. Fine at personal scale (~3 MB/book). | `search.ts:213-225` | Revisit past ~100k chunks (see S-12). |
| A-15 | Low | **Two HTTP stacks** (AI SDK for the tutor, hand-rolled `retryFetch` elsewhere) with different retry/error semantics; provider-specific params and `R3_CARRIER_MODEL` hard-coded. No SSRF path found (base URLs from env only; keys not in DB). | `llm.ts`, `providers.ts:119,233`, `turn.ts:294` | Converge on one client over time. |

## 5. Web app and engine (W-xx)

Measured numbers come from `apps/web/src/bench/RESULT.md`. Anything at 50k elements is **extrapolated from the 20k runs**, not measured.

| ID | Sev | Finding | Evidence | Fix |
|---|---|---|---|---|
| W-01 | High | **RenderCache cliff.** Dense text at DPR 2 (5,000 text): pan 32 fps, **zoom 1.6 fps**; 20k: zoom 0.5 fps. The cache cap tops out at ~491 MB because Chrome's `deviceMemory` is capped at 8 GB, and the working set (~742 MB) exceeds it, so every element misses every frame (LRU walked in z order). Per-element power-of-two buckets make zoom 1–1.4 at DPR 2 draw 4x bitmaps. Already logged `needs-user-decision`. Realistic scenes (200 text, 200 math, 50 images) hold 60 fps, so this hits only very dense boards. | `RESULT.md:53,124-128`, `render.ts:57,115-133,225-268`, `cachebudget.ts` | Direct `fillText` when the cache is near its cap (path exists at `render.ts:239`); finer buckets (1.25x); per-frame visible-set budget. |
| W-02 | High | **Per-frame full-scene work.** `render()` loops every element, runs `routeArrow`/`map`/`Math.min(...xs)` per line/arrow, rebuilds bound arrows, and sorts visible elements every frame. Unprofiled share of the 52 ms / 9.8 fps pan at 20k. | `render.ts:841-856,899,922-927` | Put lines/arrows in the R-tree (bound arrows by endpoint union); cache the z-sorted visible list while the scene is unchanged. |
| W-03 | High | **`applyBatch` copies the whole scene Map** (`new Map(scene.els)`) per batch, `structuredClone` + full zod parse per patched element (a moved stroke re-parses up to 10k points), and `buildBatch` copies again — three whole-scene passes per Move. `applyServer` rolls back and replays *all* pending edits per incoming server batch: O(pending x n) while an AI turn streams, unbounded while offline. | `scene.ts:83-113`, `ops.ts:73-95`, `transform.ts:91-101`, `sync.ts:128-151` | Mutate a live map with an undo log; skip full parse for numeric leaf patches; rebase pending once per tick. |
| W-04 | High | **Snap scans every element on every pointermove.** Builds `[...els.values()].filter(...).map(bounds)` each move; Alt bypasses it, default drag does not. Likely fine at 5k, drops frames at 50k (extrapolated). | `tools/select.ts:231-234`, `snap.ts:25` | Query the R-tree within snap tolerance. |
| W-05 | High | **Chat re-parses everything constantly.** No `React.memo` on `MessageView`/`Markdown`; `Markdown` builds its `components` map in render, so `a`/`code`/`pre` are new component types each time and `MathSpan` remounts and re-runs `renderMath` per token (inferred from react-markdown semantics, not observed); the composer's `text` state shares a component with the message list (each keystroke re-parses all); `setMessages` per stream chunk without rAF batching; `scrollIntoView` on every change; `Workspace` re-renders per AI batch via `useJump`/`bumpActivity`. 50-message pages, no virtualisation. | `Markdown.tsx:108-154`, `ChatTab.tsx:111,238,362,610`, `useTutorChat.ts:~178`, `jump.tsx:~106`, `Workspace.tsx:260` | `useMemo` the components map; `memo(MessageView)`; extract the composer; rAF-coalesce `setMessages`; scroll only when pinned. |
| W-06 | High | **Full-board autosave** on every commit *and* every camera move (500 ms during a pan): `ordered()` sort, `structuredClone` of all elements, undo clone, then IndexedDB clones again. Measured ~42 ms clone + ~31 ms validation at 20k, on the main thread. Local mode only. | `persist.ts:15-22,353`, `editor.ts:738-751` | Camera under its own key; split undo from elements; incremental writes in `requestIdleCallback`. |
| W-07 | Med | **`ordered(scene).at(-1)` (full O(n log n) sort) to find top z**, at 8 create sites plus `getSnapshot`. | `editor.ts:527,742`, `tools/ink.ts:84`, `shape.ts:47`, `text.ts:190`, `math.ts:221`, `chart.ts:43`, `group.ts:93`, `make.ts:8` | Track `maxZ` in the scene, updated in `applyBatch`. |
| W-08 | Med | **Camera events drive React at pointer rate**, uncoalesced: `SelectionToolbar` (bounds + `getBoundingClientRect` + `setPos`), `GhostFrame`, `AiPresence`, edge indicator (state lives in `Workspace`, so every pan re-renders dock + chat), and `AiTag` runs a second `index.pick` per move. | `editor.ts:796`, `SelectionToolbar.tsx:59-89`, `jump.tsx:165-193,263,295`, `AiTag.tsx:52` | Coalesce to the editor's rAF `frame()`; `useSyncExternalStore` or CSS transform; skip unchanged `setState`. |
| W-09 | Med | **`Editor.frame()` copies the scene Map per frame while text is edited**; `text.ts` re-lays-out per frame and defeats the `layoutText` WeakMap memo; forced layout via `getBoundingClientRect`. | `editor.ts:863`, `text.ts:38,174` | Pass a `skip` id to `render()`; sync only on input/camera/resize. |
| W-10 | Med | **Live ink recomputes the outline from all points every frame**, RDP only on release. 0.12–0.71 ms at 1k–5k points (measured on static strokes); 240 Hz coalesced samples can reach 5k. | `tools/ink.ts:57-74,133-146`, `RESULT.md:165` | Thin samples in `take()`; cache the committed prefix outline. |
| W-11 | Med | **Undo has no byte budget** (200 entries, each original + inverse + full clones) and is persisted on every save. | `undo.ts:61`, `scene.ts:95` | Cap by bytes; don't persist, or persist the last N. |
| W-12 | Med | **Object URLs never revoked** (chat attachments, board-context thumbnails ≤ 1600 px); only `editor/math.ts` revokes. | `ChatTab.tsx:195`, `board-context.ts:50` | Revoke on remove/close/unmount. |
| W-13 | Med | **Activity refetch per agent batch**, no `AbortController`. | `Workspace.tsx:260`, `useActivity.ts:18-33` | Debounce, or refetch at turn end. |
| W-14 | Med | **Library polling dies after one failed request** (the next poll is scheduled only when `books` changes), fixed 1.5 s, ignores a hidden tab. Same in the book page. | `library/page.tsx:55-60`, `[bookId]/page.tsx:78`, `library/status.ts:3` | Reschedule in `finally`; backoff; pause on `document.hidden`. |
| W-15 | Med | **A transient blob error marks the image "missing" for the session.** | `blobs-http.ts:62`, `images.ts:211` | Mark missing only on 404; retry otherwise. |
| W-16 | Med | **Sync client:** no jitter, no heartbeat (half-open sockets undetected), no `online`/visibility trigger; `setScene` disposes the whole bitmap cache on any snapshot rejoin. | `sync.ts:220`, `editor.ts:~655` | Jitter; ping; reuse cache when `v` matches. |
| W-17 | Med | **Bundle/code-splitting (static reading only).** All pages `"use client"`; `ai`, `react-markdown`, `remark-*` and `MathSymbols` load in local mode where unused; `core` re-exports server tool schemas to the browser, no `sideEffects:false`; `/bench` ships as a production route; no `next/font`, canvas fonts fetched after JS; `NEXT_PUBLIC_API_BASE` baked at build in the Dockerfile. | `app/*`, `packages/core/package.json`, `Dockerfile:15` | `next/dynamic` for the chat dock; `sideEffects:false`; preload woff2; drop `/bench` in prod. |
| W-18 | Low | Per-sample `getBoundingClientRect`; dock drag resizes canvases synchronously and writes `localStorage` per move; no cap on canvas pixels at high DPR; unbounded `entries` Map in `editor/math.ts`; `bridge` recreated per reconnect; `location.assign` full reload; thumbnails unbounded. | `editor.ts:811,1022`, `Dock.tsx`, `Workspace.tsx:138,267` | Read the rect once per event; rAF-throttle resize. |

## 6. Done well

- **Persistence:** WAL + FK + busy timeout; all statements prepared once; transactional forward-only migrations with a pre-migrate `VACUUM INTO`; ack only after commit; stale-reload path after a failed write.
- **Gateway and HTTP:** 1 MB max payload, text-only frames, zod-validated messages, author never client-supplied, heartbeat, Host check (DNS rebinding), exact-Origin CSRF on unsafe methods, error envelope without internals, streaming PDF upload with hash + atomic rename, content-addressed blob ids validated by strict regex, sniffed types, pre-decode dimension checks, decode concurrency capped at 2.
- **AI:** stub model with a runaway-loop fixture; step, cost and time stops; `turn_busy` lock taken before the first await; tool errors returned as readable text; zod-validated tool args; element budget enforced inside tools; citations validated against pages actually shown; resumable ingest; atomic chunking of equations/tables/code; Arabic normalisation; unit-normalised vectors; conflict-aware undo.
- **Engine and web:** R-tree culling, two canvases (overlay-only redraw for pen/selection), rAF-coalesced frames, per-element `Path2D` and layout WeakMap caches, `createImageBitmap` + import caps, lazy math/image loading, coalesced/predicted pointer events, IndexedDB with a Web Lock + backup + `pagehide` flush, 1 MiB outgoing frame guard, drift recovery, batchId dedupe (HANDOFF items already fixed), honest bench harness that records its own failures, server-rasterised book pages instead of a PDF viewer.

## 7. Not verified

- Anything dynamic: no profiling, no e2e, no Docker/Caddy, no live model call. Stall durations (S-04, S-12) are estimates from the algorithms.
- Bundle size, tree-shaking, hydration cost (`next build` writes `.next`).
- Whether SIGTERM reaches node through `pnpm` + `tsx` in the container (S-15); Node's `requestTimeout` default (S-14); `RetryError` classification and undici timeouts (A-03, A-06).
- Meta API prompt caching and whether `outputTokens` includes reasoning tokens (A-12).
- Real token/char ratio for Arabic and LaTeX against the chars/3 estimate (A-04).
- Mixed 20k/50k scenes with math, images and ink; a 5,000-element scene with 500 strokes was never benchmarked. Pen, Safari and iOS canvas-memory limits.
- How much of the 20k pan cost is W-02 versus W-01 (needs a profile).
- Files not read by the server reviewer: most of `tutor/*` beyond `activity.ts`/`turn.ts`, `library/ingest.ts`, `embed-search.ts` (the AI reviewer covered these).
- Core read tools' result-size caps (`packages/core/src/tools/*`).

## 8. Suggested sequencing

1. **Guardrails (hours):** A-01, A-02, S-06, S-08 indexes, S-01 snapshot prune, S-03 export semaphore.
2. **Event-loop hygiene (days):** S-04 (snapshot-seq query, async gzip), S-02/A-09 (move all pdfjs to the worker), S-10 (stream blobs), S-12 only if a library passes ~100k chunks.
3. **UI smoothness (days):** W-05, W-07, W-08, W-13, W-14.
4. **Engine scaling (week+, profile first):** W-01 decision, W-02, W-03, W-04, W-06.
5. **Ops (as needed before any non-local deploy):** S-07, S-14, S-15, S-16.

Decisions that are yours, not mine: the RenderCache fraction/bucket policy (W-01), and whether the single-owner assumption is permanent (it makes S-07, A-13 and the unpruned logs acceptable; multi-user changes their severity).

## 9. Resolution log

**Fixed (server suite 438 pass, typecheck clean, new tests for each):**

| ID | Change |
|---|---|
| S-01 | `saveSnapshot` keeps only the newest snapshot per board (insert + prune in one transaction). |
| S-04 (partly) | New `latestSnapshotSeq`; `join` decodes the snapshot blob only when `fromSeq < snapshot seq`. `tick()` writes at most 4 snapshots per call (`maxSnapshotsPerTick`); an idle board that still needs one stays in memory until the next tick. Async/worker gzip is **not** done. |
| S-05 (tail) | A join more than 2000 batches behind (`maxJoinTail`) gets the live scene instead of the op tail, which bounds the frame when snapshots have stalled. The op log itself is still never compacted. |
| S-08 | Migration `0003_hot_path_indexes.sql`: `board_ops(board_id,batch_id)`, `messages(board_id)` (replaces the `created_at` one), `messages(board_id,turn_id)`, `messages(created_at)`. `opsByBatch` uses `INDEXED BY`: with no `ANALYZE` stats the planner ties it with the primary key and scans (found while testing, so the index alone would not have helped). |
| S-06 | `sendBounded`: a socket with more than 8 MB unsent is terminated; the client resyncs by `join`. No per-socket rate cap yet. |
| S-03 | At most 2 concurrent export renders (`maxConcurrentExports`); more get `503 overloaded`. No result cache yet. |
| A-02 (lock) | The user-message insert is inside the try that releases the board lock, and the post-stream section is inside the `finally` that releases it. Token usage is now accumulated per finished step (`onStepEnd`), so an aborted or failed turn keeps what it used. |
| A-01 (partial) | New `TUTOR_MAX_OUTPUT_TOKENS` (default 16384) sent as `maxOutputTokens` on every tutor call. |
| A-01 (R4) | R4 vision pages are budgeted before the first call and recorded in the ledger (`kind: 'vision'`) at `R4_USD_PER_PAGE` (default $0.009, from S2's measurement; an estimate, since Meta returns no cost). Still unmetered: section summaries and chat-memory summaries. |

| S-02, A-09 (PDF part) | New `library/pdf-service.ts`: a long-lived worker thread (`pdf-worker.ts`) runs upload page-count, the routing estimate, the preview and page rasters; `add_book_figure` goes through it too. Jobs take a file path, so a 200 MB book is no longer read and copied on the server thread. Errors keep their code across the thread boundary; a job over 5 minutes kills the thread and the next call respawns it; concurrent requests for one page image share one render. An inline implementation of the same code serves the HTTP tests; `pdf-service.test.ts` runs the same expectations against both and checks that timers keep firing while the worker renders. **Not done:** `resourceLimits` on either worker, the CLI (`pnpm ingest` still parses in its own process, which is fine), per-page quarantine in ingest. |

**Web (web suite 607 pass):**

| ID | Change |
|---|---|
| W-05 | `Markdown` builds its renderers once (reading handlers through a ref) and is `memo`'d; `MessageView` memoises its handlers on the message and the two callbacks; streamed snapshots are applied once per animation frame instead of once per token. A test shows a formula is typeset once while later text streams in (it was 3 times before). The composer still shares a component with the message list, and nothing is virtualised, so those parts of W-05 are open. |
| W-07 | New core `topZ(scene)` (one linear scan) replaces the full sort at the 8 create sites. `getSnapshot` still sorts (W-06). |
| W-14 | New `useRefreshLoop` re-arms after every round, failed or not, skips the request in a hidden tab, and polls 4x slower while the server is failing (library list); used by both library pages. |

**Corrections to the findings above (found while fixing):**

- **A-01:** unpriced-by-default is a documented decision (PLAN §19 #50: Meta publishes no price), so the daily and per-turn USD caps cannot bite until a price is set. Also, R3 OCR *is* recorded in the ledger (`ingest.ts:170`); the unmetered paid paths are **R4 vision transcription**, section summaries and chat-memory summaries. R4 is now covered by a per-page estimate (your decision); summaries remain.
- **S-08:** the `board_ops` EXPLAIN in the original finding was against the schema without any batch index; the fix needed `INDEXED BY` as noted above.
- The repo moved while this was written (`f4f9132` → `fc1844e`, including EXIF, big-batch and resent-batch fixes). Line references in §3–5 are from `f4f9132`.

**Still open, in the order of §8:** S-04 async gzip, S-05 compaction, S-10, A-03 to A-13, W-01 to W-04, W-06, W-08 to W-13, W-15 to W-18.

**Noticed while fixing:** the book preview calls the vision model (paid) without budget check or ledger entry; an existing test asserts it is free, so I left it. Under heavy CPU load (full parallel suite) PDF-heavy tests in `ingest.test.ts` and `figure.test.ts` can exceed vitest's 5 s default once in a while; they passed on every other run.

**Not mine, noticed in passing:** `pnpm lint` reports 1 error on a clean HEAD, `noUnsafeOptionalChaining` at `apps/server/src/tutor/tools/board-tools.test.ts:477`.
