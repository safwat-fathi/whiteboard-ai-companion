# S1 canvas: result

## Environment

browser.commit: measured at 3e1107b
browser.machine: MacBookAir10,1, Apple M1, 8 GB, macOS 27.0.1, AC power, Low Power Mode off, no thermal warning recorded
browser.display: built-in Retina at 1680x1050, 60 Hz, device DPR 2
browser.chrome: Google Chrome 156.0.8078.48, headed, launched by chrome-devtools-mcp 1.11.0, DevTools UI closed, tab visible and focused at the start and end of every run
browser.ua: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36
browser.glRenderer: ANGLE (Apple, ANGLE Metal Renderer: Apple M1, Unspecified Version)
browser.headless: false
browser.toolchain: Node 22.21.1, pnpm 12.8.1, Vite 8.3.5 dev server, rbush 4.0.1, perfect-freehand 1.2.3
browser.canvas: 1440x900 CSS px, fixed (2880x1800 at dpr 2, 1440x900 at dpr 1), window inner 1440x876; opaque scene canvas plus transparent overlay
browser.idleRaf: 59.0 fps in every run, so the 58 fps threshold has about 1 fps of headroom on this machine
browser.backgroundLoad: during the runs ANECompilerService used about half a CPU core (47% at the start) and the animated Aerial wallpaper was decoding video (WallpaperAerials about 40% CPU, WindowServer about 24%)
browser.clock: performance.now() steps in 0.1 ms (no cross-origin isolation); rbush move and getStroke times are means over 1,000 and 100 calls
browser.scene: seeded; 5,000 elements packed into a 1000x600 world rect, element bounding boxes covering it 36 times over. Mix: 1,800 shapes (25% rotated), 500 lines/arrows, 1,500 text (60% Latin, 40% Arabic, 12 to 32 px, browser default sans-serif), 400 math and 300 images drawn from 8 and 3 pre-rasterised bitmaps, 500 freehand strokes of 40 to 200 points
browser.method: unmeasured warm-up first: one cold frame per zoom bucket, then 1 s of each camera path. Measured phases: 5 s pan on a Lissajous path (±150 by ±100 world units at 0.6 and 0.4 Hz, zoom 1), then 5 s zoom 1 ± 0.4 (period 2.5 s) about the centre. meanFps is 1000 / mean rAF delta, p95 is nearest-rank, drawMsMean is renderScene JS time. Cached bitmaps are keyed by zoom bucket 2^ceil(log2 zoom), id and v; bitmaps over 4096 px a side are drawn directly. First ink starts once the render loop has been idle for 500 ms on every thread; then 20 pointerdowns 50 to 100 ms apart.
browser.runs: all at 3e1107b, in order: direct dpr2, cached dpr2, worker dpr2, direct dpr1, cached dpr1

## Numbers

browser.frames.direct.dpr2.pan: meanFps 54.6, p95FrameMs 32.8, drawMsMean 9.5 (FAIL)
browser.frames.direct.dpr2.zoom: meanFps 6.4, p95FrameMs 216.6, drawMsMean 7.86 (FAIL)
browser.frames.cached.dpr2.pan: meanFps 46.5, p95FrameMs 33.4, drawMsMean 6.12 (FAIL)
browser.frames.cached.dpr2.zoom: meanFps 40.7, p95FrameMs 33.4, drawMsMean 6.75 (FAIL)
browser.frames.worker.dpr2.pan: meanFps 43.9, p95FrameMs 33.4, drawMsMean 6.28 (FAIL)
browser.frames.worker.dpr2.zoom: meanFps 39.8, p95FrameMs 50.0, drawMsMean 7.04 (FAIL)
browser.frames.direct.dpr1.pan: meanFps 52.8, p95FrameMs 33.3, drawMsMean 7.98 (FAIL)
browser.frames.direct.dpr1.zoom: meanFps 8.9, p95FrameMs 135.3, drawMsMean 7.8 (FAIL)
browser.frames.cached.dpr1.pan: meanFps 43.3, p95FrameMs 33.4, drawMsMean 4.4 (FAIL)
browser.frames.cached.dpr1.zoom: meanFps 44.5, p95FrameMs 33.4, drawMsMean 5.48 (FAIL)
browser.frames.minDrawn: 5000 in every phase of every run
browser.frames.verdict: FAIL at DPR 2 for direct, cached and worker (needs meanFps >= 58 and p95FrameMs <= 17.5 in both phases); next rung WebGL, not built in M0. An exploratory ablation at 3e1107b, recorded in the Task 1 report and not part of this benchmark, shows the shortfall is text-driven.
browser.textStrategy.direct.dpr2: pan 54.6 fps, zoom 6.4 fps, firstInkP95Ms 1.9, open20kMs 226.4, bitmapCacheMB 0, coldFrameMs 48.6 (first frame)
browser.textStrategy.cached.dpr2: pan 46.5 fps, zoom 40.7 fps, firstInkP95Ms 0.9, open20kMs 1412.0, bitmapCacheMB 563.3, coldFrameMs 370.3 (bucket 1) and 510.7 (bucket 2)
browser.textStrategy.direct.dpr1: pan 52.8 fps, zoom 8.9 fps, firstInkP95Ms 0.9, open20kMs 220.3, bitmapCacheMB 0, coldFrameMs 55.3 (first frame)
browser.textStrategy.cached.dpr1: pan 43.3 fps, zoom 44.5 fps, firstInkP95Ms 1.0, open20kMs 1397.0, bitmapCacheMB 141.6, coldFrameMs 363.8 (bucket 1) and 388.8 (bucket 2)
browser.textStrategy.rule: the higher worst-phase meanFps at DPR 2 wins; if within 3 fps, the lower cold-fill and memory cost wins. cached 40.7 against direct 6.4, so cached, without the cost tie-break.
browser.renderThread.rule: worker only if, at DPR 2, it beats the best main-thread variant by at least 3 fps in a phase, or passes first ink where main fails. Worker pan 43.9 against direct 54.6 and cached 46.5, zoom 39.8 against cached 40.7; first ink passes on every variant. So main.
browser.coldFrameMs.worker.dpr2: 362.7 (bucket 1) and 558.8 (bucket 2)
browser.bitmapCacheMB.worker.dpr2: 563.3
browser.open20kMs: direct dpr2 226.4, cached dpr2 1412.0, worker dpr2 1123.8, direct dpr1 220.3, cached dpr1 1397.0 (PASS, < 2000). Camera fits the whole 2000x1200 board, all 20,000 elements drawn in the first frame, 8.9 MB JSON, cold caches.
browser.firstInkP95Ms: direct dpr2 1.9, cached dpr2 0.9, worker dpr2 1.2, direct dpr1 0.9, cached dpr1 1.0 (PASS, <= 16)
browser.firstInk.note: measured to the end of the painting rAF, not to the screen; an idle Chrome runs the requested rAF almost at once (wait-for-rAF p95 0.6 to 1.0 ms). Largest single sample 17.5 ms (direct dpr2).
browser.firstInk.history: before the settle and the RTL fix (228d0ec) one cached dpr2 run measured 22.1 ms (FAIL), because its first pointerdowns waited behind the GPU backlog of the zoom-extreme render.
browser.zoomExtremes: holds in every run (zoom 0.05: 5000 drawn = 5000 R-tree = 5000 brute force; zoom 20: 152 = 152 = 152)
browser.sceneMix: per-type counts, 25% rotated shapes and 40% Arabic text asserted for 5,000 and 20,000 elements; no assertion failed
browser.rbush.load20kMs: 8.7 to 11.4 (median of 5 per run; PASS, <= 50)
browser.rbush.queryP95Ms: 0.2 in every run (1000x600 queries on the 20k tree over a 2000x1200 world, about 6,247 hits each; PASS, <= 1)
browser.rbush.moveAvgMs: 0.0036 to 0.0049 (remove plus insert, mean of 1,000; PASS, <= 0.1)
browser.freehand.getStrokeMs: 0.067 to 0.1 at 500 points; 0.12 to 0.151 at 1,000 points (PASS, <= 2); 0.57 to 0.71 at 5,000 points

## Decisions

textStrategy: cached
renderThread: main
spatialIndex: rbush
freehand: perfect-freehand
