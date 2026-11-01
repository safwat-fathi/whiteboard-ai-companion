# S1 canvas: result

## Environment

browser.machine: MacBookAir10,1, Apple M1, 8 GB, macOS 27.0.1, AC power, Low Power Mode off, no thermal warning recorded
browser.display: built-in Retina at 1680x1050, 60 Hz, device DPR 2
browser.chrome: Google Chrome 156.0.8078.48, headed, launched by chrome-devtools-mcp 1.11.0, DevTools UI closed, tab visible and focused at the start and end of every run
browser.ua: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36
browser.glRenderer: ANGLE (Apple, ANGLE Metal Renderer: Apple M1, Unspecified Version)
browser.headless: false
browser.toolchain: Node 22.21.1, pnpm 12.8.1, Vite 8.3.5 dev server, rbush 4.0.1, perfect-freehand 1.2.3
browser.canvas: 1440x900 CSS px, fixed (2880x1800 at dpr 2, 1440x900 at dpr 1), window inner 1440x876; opaque scene canvas plus transparent overlay
browser.idleRaf: 58.9 to 60.1 fps across runs, so the 58 fps threshold has 1 to 2 fps of headroom on this machine
browser.backgroundLoad: during every run ANECompilerService used about one CPU core and the animated Aerial wallpaper was decoding video (WallpaperAerials about 30% CPU, WindowServer about 21%)
browser.clock: performance.now() steps in 0.1 ms (no cross-origin isolation); rbush move and getStroke times are means over 1,000 and 100 calls
browser.scene: seeded; 5,000 elements packed into a 1000x600 world rect, element bounding boxes covering it 36 times over. Mix: 1,800 shapes (25% rotated), 500 lines/arrows, 1,500 text (60% Latin, 40% Arabic, 12 to 32 px, browser default sans-serif), 400 math and 300 images drawn from 8 and 3 pre-rasterised bitmaps, 500 freehand strokes of 40 to 200 points
browser.method: unmeasured warm-up first: one cold frame per zoom bucket, then 1 s of each camera path. Measured phases: 5 s pan on a Lissajous path (±150 by ±100 world units at 0.6 and 0.4 Hz, zoom 1), then 5 s zoom 1 ± 0.4 (period 2.5 s) about the centre. meanFps is 1000 / mean rAF delta, p95 is nearest-rank, drawMsMean is renderScene JS time. Cached bitmaps are keyed by zoom bucket 2^ceil(log2 zoom), id and v; bitmaps over 4096 px a side are drawn directly.
browser.runs: final code, in order: worker dpr2, direct dpr2, cached dpr2, direct dpr1, cached dpr1 (earlier runs are in the task report)

## Numbers

browser.frames.direct.dpr2.pan: meanFps 55.0, p95FrameMs 18.1, drawMsMean 8.83 (FAIL)
browser.frames.direct.dpr2.zoom: meanFps 6.3, p95FrameMs 216.6, drawMsMean 7.56 (FAIL)
browser.frames.cached.dpr2.pan: meanFps 45.2, p95FrameMs 33.4, drawMsMean 6.54 (FAIL)
browser.frames.cached.dpr2.zoom: meanFps 39.9, p95FrameMs 35.3, drawMsMean 7.2 (FAIL)
browser.frames.worker.dpr2.pan: meanFps 43.6, p95FrameMs 33.4, drawMsMean 6.34 (FAIL)
browser.frames.worker.dpr2.zoom: meanFps 38.9, p95FrameMs 50.0, drawMsMean 7.01 (FAIL)
browser.frames.direct.dpr1.pan: meanFps 49.3, p95FrameMs 33.4, drawMsMean 7.85 (FAIL)
browser.frames.direct.dpr1.zoom: meanFps 8.7, p95FrameMs 149.9, drawMsMean 7.44 (FAIL)
browser.frames.cached.dpr1.pan: meanFps 43.9, p95FrameMs 33.4, drawMsMean 4.7 (FAIL)
browser.frames.cached.dpr1.zoom: meanFps 45.4, p95FrameMs 33.4, drawMsMean 5.61 (FAIL)
browser.frames.minDrawn: 5000 in every phase of every run
browser.frames.verdict: FAIL at DPR 2 for direct, cached and worker (needs meanFps >= 58 and p95FrameMs <= 17.5 in both phases); next rung WebGL, not built in M0. An exploratory ablation, recorded in the Task 1 report and not part of this benchmark, shows the shortfall is text-driven.
browser.coldFrameMs: cached dpr2 299.2 at bucket 1 and 370.8 at bucket 2; worker dpr2 344.1 and 350.8; direct dpr2 51.3 and 11.3
browser.bitmapCacheMB: cached dpr2 563.3, worker dpr2 563.3, cached dpr1 141.6
browser.open20kMs: direct dpr2 254.6, cached dpr2 1178.5, worker dpr2 1227.5, direct dpr1 300.0, cached dpr1 1124.2 (PASS, < 2000). Camera fits the whole 2000x1200 board, all 20,000 elements drawn in the first frame, 8.9 MB JSON, cold caches.
browser.firstInkP95Ms: direct dpr2 0.7, cached dpr2 22.1 (FAIL), worker dpr2 1.0, direct dpr1 5.8, cached dpr1 12.6 (threshold <= 16)
browser.firstInk.note: measured to the end of the painting rAF, not to the screen; an idle Chrome runs the requested rAF almost at once. The first 1 to 3 pointerdowns after heavy scene work waited 5 to 331 ms behind the GPU backlog in every variant; the rest painted in under 1 ms.
browser.zoomExtremes: holds in every run (zoom 0.05: 5000 drawn = 5000 R-tree = 5000 brute force; zoom 20: 152 = 152 = 152)
browser.sceneMix: per-type counts, 25% rotated shapes and 40% Arabic text asserted for 5,000 and 20,000 elements; no assertion failed
browser.rbush.load20kMs: 8.6 to 11.8 (median of 5 per run; PASS, <= 50)
browser.rbush.queryP95Ms: 0.2 in every run (1000x600 queries on the 20k tree over a 2000x1200 world, about 6,245 hits each; PASS, <= 1)
browser.rbush.moveAvgMs: 0.0035 to 0.0058 (remove plus insert, mean of 1,000; PASS, <= 0.1)
browser.freehand.getStrokeMs: 0.122 to 0.152 at 1,000 points across runs 3 to 7 (PASS, <= 2); run 3 also measured 0.099 at 500 points and 0.625 at 5,000 points

## Decisions

textStrategy: cached
renderThread: main
spatialIndex: rbush
freehand: perfect-freehand
