# S4 embeddings and search: result

## Environment

search.commit: measured on the working tree on top of fae964e and committed with this task (the commit that adds these lines); a re-run after the commit is in the Task 3 report
search.machine: MacBookAir10,1, Apple M1 (4 performance + 4 efficiency cores), 8 GB, macOS 27.0.1 (arm64), AC power, Low Power Mode off, no thermal or performance warning recorded
search.toolchain: Node 22.21.1, pnpm 12.8.1, tsx 4.23.15, better-sqlite3 13.0.3 (SQLite 3.53.4), run as `pnpm --filter s4-search latency` (`tsx --expose-gc latency.ts`)
search.fts5: `select sqlite_compileoption_used('ENABLE_FTS5')` returns 1 (asserted at the start of every run; the script throws otherwise)
search.nativeBuild: `pnpm approve-builds better-sqlite3` printed "not awaiting approval" and still wrote `better-sqlite3: true` to `allowBuilds` in pnpm-workspace.yaml (next to `esbuild: false`); better-sqlite3 13.0.3 ships prebuilds (darwin-arm64/x64, linux-arm64/x64, linuxmusl-arm64/x64, win32-arm64/x64) and has no install script, so the setting changes nothing today: it loaded and passed `pnpm install --frozen-lockfile` before the approval too, and on a VPS of another arch or libc nothing would compile it
search.backgroundLoad: during all runs ANECompilerService used about 77% of a core, the animated Aerial wallpaper decoded video (WallpaperAerials about 37%, WindowServer about 26%, VTDecoderXPCService about 9%); loadavg at the start of the three runs 2.66, 2.56 and 6.13 (the third includes the `top` sampling just before it)
search.memoryPressure: the Mac was short of memory (about 60 MB free before the first run, swap 3.7 GB of 5 GB used, 278k pages in the compressor before it and 363k after the third run), so RSS can under-report: macOS compresses or swaps resident pages out. The Float32Array alone is 390.6 MiB; measured RSS deltas of 372 to 391 MiB are that array less whatever macOS had compressed. A machine without pressure shows at least 390.6 MiB
search.vectors: synthetic, 1024-d, unit length (components uniform in [-1,1) from a seeded mulberry32, normalised in place), one Float32Array per N, row-major; 5 warm-up and 50 timed queries per N, each a different random unit vector
search.method: `topK(vectors, dims, query, k)` in topk.ts: for each row four independent dot-product accumulators over the typed arrays, then a k=8 descending insertion list (a candidate is compared with the current 8th score first, so most rows cost one comparison). Timed with performance.now() around each call; p50 and p95 are nearest-rank over the 50 timed calls. RSS delta is process.memoryUsage().rss after the last query minus RSS after two forced GCs before the vectors were allocated (so it holds the vectors, the 55 queries and the JIT state they cause)
search.selfCheck: before any timing, topK is compared with a full sort on 3,000 random 128-d rows (same indices, scores within 1e-9), a planted row returns itself with score 1, k > n returns n rows, k = 0 returns nothing, and dims % 4 != 0 throws
search.coldStart.method: 100,000 rows of 4,096 B (one 1024-d vector each) inserted into `chunks(id integer primary key, embedding blob)` in one transaction (WAL, synchronous NORMAL, the app's pragmas), connection closed; then, with the 100k Float32Array freed and GC'd, a new read-only connection runs `select embedding from chunks order by id` with `.raw().iterate()` and copies each BLOB into one preallocated Float32Array (no array of 100,000 Buffers). The time covers opening the DB, the statement and the copy. The loaded array is checked by running the same probe query as on the original: identical top-8 indices and scores
search.coldStart.cache: the OS page cache is warm (the file was written seconds earlier); a true cold read from disk is not measured here (no sudo purge)
search.dbFile: spikes/s4-search/data/synthetic.db, 439.6 MiB, gitignored through `data/`, deleted after the runs; each run deletes and regenerates it

## Numbers

search.exact.n600: p50 0.476 ms, p95 0.485 ms, max 0.487 ms, rss delta 3.3 MiB (PASS, p95 <= 5)
search.exact.n10k: p50 7.921 ms, p95 8.075 ms, max 8.112 ms, rss delta 39.1 MiB
search.exact.n100k: p50 79.302 ms, p95 79.563 ms, max 79.840 ms, rss delta 390.8 MiB (PASS, p95 <= 100 and rss delta <= 512 MiB; the script applies 512 MiB, and 390.8 MiB also passes the stricter reading of 512 MB = 488.3 MiB)
search.exact.runs: three runs of the final code, N=100,000 p95 80.052, 83.800 and 79.563 ms (p50 79.342, 79.477, 79.302; max 81.863, 91.605, 79.840; rss delta 375.4, 383.2 and 390.8 MiB); N=600 p95 0.483, 0.481 and 0.485 ms; N=10,000 p95 7.991, 8.060 and 8.075 ms. The table lines above are the third run; the 91.6 ms maximum in the second run is one slow query under the background load, and the p95 stayed under 100 ms in every run
search.exact.scaling: about 0.79 ms per 1,000 vectors (79.3 ms for 100,000, 7.9 ms for 10,000, 0.48 ms for 600), i.e. linear; one book of 600 chunks costs 0.5 ms, 200 times under the 100 ms budget
search.exact.headroom: 100,000 vectors leave 20 ms (20%) under the 100 ms limit on this M1 with the background load above; the VPS figure comes from Task 5, which reruns this script
search.exact.memory: 100,000 x 1024 x 4 B = 409.6 MB = 390.6 MiB of vectors. The script's limit is 512 MiB (121 MiB of margin); read as 512 MB (488.3 MiB) the margin is 98 MiB, and 409.6 MB passes either way. At 4 KiB a chunk, 512 MiB holds 131,072 chunks (488.3 MiB holds 125,000)
search.exact.history: the first version of topK had a scalar tail loop for dims not a multiple of 4; N=100,000 then measured p50 93.9 ms and p95 94.2 ms (one run). Removing the tail loop (dims % 4 != 0 now throws) cut it to 79 ms. In a stand-alone micro-benchmark a one-accumulator loop took 97.6 ms, four accumulators 72.4 ms and eight 77.5 ms (top-1 only, constant dims), and a Float64Array query was slower (115 to 132 ms); four accumulators is what topK uses
search.coldStart.write: 100,000 rows in one transaction in 2,214 ms (3 runs: 2,258 / 2,295 / 2,214 ms), file 439.6 MiB
search.coldStart.load: 100,000 rows into one Float32Array in 277 ms, rss delta 405.9 MiB (3 runs: 271 / 273 / 277 ms; rss delta 397.7 / 405.0 / 405.9 MiB, about 15 MiB above the array, probably the SQLite page cache and row Buffers not yet collected; not investigated); page cache warm, so this is the lower bound of a cold start
search.coldStart.roundTrip: top-8 of the probe query on the loaded array equals the top-8 on the original array (checked in all three runs)

## Decisions

vectorSearch: exact
