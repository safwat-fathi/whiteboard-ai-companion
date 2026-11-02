# Bench: real renderer against S1

Run with `pnpm bench` (builds the app, then Playwright starts `next start` on :3100, runs `/bench?n=5000` and `/bench?n=20000` five times each in headed Google Chrome at DPR 2 and DPR 1, and stops the server). Raw per-run JSON goes to `test-results/` (git-ignored). The page is `apps/web/app/bench/page.tsx`, the method is `apps/web/src/bench/run.ts`, the scene generator is `apps/web/src/bench/scene.ts`.

## Environment

bench.commit: measured on the working tree on top of ff9a265 and committed with this task (the commit that adds these lines)
bench.machine: MacBookAir10,1, Apple M1, 8 GB, macOS 27.0.1, AC power (100%, charged), Low Power Mode off, no thermal warning recorded; same Mac as S1
bench.display: built-in Retina (2560x1600 native, reported as screen 1680x1050, 60 Hz), device DPR 2. A DELL P2419H 4K external display was also connected (S1 does not mention one); Chrome opened on the built-in display (`screen` 1680x1050 in the dpr2 runs)
bench.chrome: Google Chrome 156.0.8078.48 (the same build as S1), headed, launched by Playwright 1.64.0 with `channel: 'chrome'` (installed Chrome, not bundled Chromium), a new page per run, `bringToFront()` before and after navigation; document visible and focused at the start and the end of every run
bench.glRenderer: ANGLE (Apple, ANGLE Metal Renderer: Apple M1, Unspecified Version); headless false
bench.toolchain: Node 22.21.1, pnpm 12.8.1, Next 16.4.3 production build served by `next start`, Playwright 1.64.0
bench.dpr2: no emulation: `viewport: null`, a real 1440x990 window (`--window-size`), window inner 1440x903 (S1: 1440x876), `devicePixelRatio` 2
bench.dpr1: emulated (Playwright needs a viewport to set `deviceScaleFactor`): viewport 1440x900, `deviceScaleFactor: 1`, `devicePixelRatio` 1. S1's dpr1 row was a 1x backing store on the same Retina display, so both are 1x canvases, but this row is an emulated context
bench.dpr2.emulated: a side check at the final code (3 runs, `viewport` 1440x900 with `deviceScaleFactor: 2`): pan 47.5, zoom 36.9, i.e. emulation reads about 3 to 5% higher than the real window; the table below uses the real window
bench.canvas: the Editor mounted on a fixed 1440x900 CSS px host (2880x1800 canvas pixels at DPR 2, 1440x900 at DPR 1), so the result does not depend on the window. Two canvases, as in S1, but the Editor's scene canvas is not opaque (S1 used `alpha: false`); render() paints a white background itself
bench.idleRaf: 60 fps in every run (59 to 60.1), so the 58 fps threshold of S1 has about 2 fps of headroom
bench.backgroundLoad: load average about 5 at the start. Same kind of load as S1: WallpaperAerialsExtension about 28% CPU (animated wallpaper decoding), WindowServer about 24%, VTDecoderXPCService about 9%, a Brave Browser instance open and idle, the Claude CLI at about 19%. Nothing else was run on the machine while `pnpm bench` was running
bench.clock: `performance.now()` steps in 0.1 ms; the frame timestamp is `document.timeline.currentTime`, checked to be identical to the rAF timestamp in this Chrome
bench.scene: seeded (seed 1 for n=5000 in a 1000x600 world rect, seed 2 for n=20000 in 2000x1200), packed with every bounding box (core `bounds()`) inside the world rect, so the boxes cover it 23.5 times over at 5,000 and 24.1 times at 20,000 (S1: 36, with 400 math, 300 images and 500 freehand strokes, none of which exist in M1). Mix at 5,000, restricted to M1 element types: 2,100 shapes (rect, ellipse, diamond, triangle; exactly 25% rotated = 525), 600 lines/arrows (50% arrows, never rotated), 2,300 text (exactly 40% Arabic = 920, 12 to 32 px, 1 to 3 generated words, every string distinct, Plex Arabic + Plex Latin from the app's font stack, box = core `layoutText` size). The 20,000 scene is the same mix times 4. Elements validate against core `ElementSchema` (z = core `zBetween` sequence, author human, opacity 1, dash solid); `scene.test.ts` asserts this, the mix, determinism, 25% rotated and 40% Arabic
bench.mix.note: against S1 the text count is 2,300 against 1,500 (and 9,200 against 6,000 at 20,000), with a 1.4 line height against S1's 1.25, so the text-bitmap load is about 1.7 times S1's. The non-text bitmap load is lower (no math or images), the path count is similar (2,700 against 2,800). The mix was fixed before any number was seen
bench.method: S1's, driven through the real Editor. Unmeasured warm-up first: setScene (cold caches), one cold frame at zoom 1, 0.6 and 1.4 (the RenderCache buckets are zoom times DPR: at DPR 2 the buckets are 2 and 4, at DPR 1 they are 1 and 2, the same bitmap sizes as S1's), then 1 s of each camera path. Measured phases: 5 s pan on a Lissajous path (+-150 by +-100 world units at 0.6 and 0.4 Hz, zoom 1), then 5 s zoom 1 +- 0.4 (period 2.5 s) about the centre of the world; S1's centre-based cameras are converted to the core's top-left camera. The camera is advanced from `Tool.onFrame` (the first thing `Editor.frame()` does), followed by `editor.invalidate()`, so the Editor's own rAF loop paints every frame; meanFps is 1000 / mean rAF delta, p95 is nearest-rank over the deltas, drawMsMean is the mean `render()` JS time of the previous frame (`Editor.lastRender.ms`)
bench.firstInk.method: M1 has no pen, so this is the Editor's pointerdown to overlay-frame latency with the select tool starting a marquee: 20 synthetic `pointerdown` events (pointerId 1, 'mouse') on the overlay canvas, 50 to 100 ms apart, after 500 ms of render idle, on empty board (the camera fits the board with a 150 px empty band on top and the pointer lands in it), each followed by a `pointerup`. Latency runs to the end of the next painting rAF (a rAF registered right after the dispatch runs after the Editor's). The marquee is empty (no stroke is drawn). Also recorded: wait (dispatch to frame start, the vsync alignment) and work (frame start to frame end), and how many of the 20 frames repainted the scene
bench.open20k.method: the 20,000 scene is generated and stringified before the timer; the timer covers `JSON.parse` of the 6.5 MB JSON, `Editor.setScene` (store, index load, cache dispose) and the end of the first painted frame with all 20,000 elements fitting the camera (zoom 0.72, 9,200 texts laid out and rasterised), cold RenderCache, layout memo and path cache (new element objects). S1's board JSON was 8.9 MB. The reported value is the n=5000 run's; in the n=20000 runs the timer also pays for replacing a populated 20,000 scene and cache and reads about 500 ms higher (2,267 ms at DPR 2, 2,271 ms at DPR 1), probably for that reason (not isolated)
bench.runs: five fresh page loads per row, medians reported (min to max in the raw JSON), one worker, in order: dpr2 n=5000, dpr2 n=20000, dpr1 n=5000, dpr1 n=20000

## Numbers

S1 values are `cached` from spikes/s1-canvas/RESULT.md. New values are medians of five runs at the final code, n=5000.

### DPR 2 (real window)

bench.dpr2.pan: meanFps 45.1 (S1 46.5), p95FrameMs 33.4 (S1 33.4), drawMsMean 8.99 (S1 6.12), runs 43.3 to 48.6
bench.dpr2.zoom: meanFps 35.4 (S1 40.7), p95FrameMs 49.2 (S1 33.4), drawMsMean 9.73 (S1 6.75), runs 34.1 to 36.5
bench.dpr2.frames.drawn: 5000 drawn and 0 culled in every pan and zoom frame of every run (S1 minDrawn 5000)
bench.dpr2.firstInkP95Ms: 16.5 (S1 0.9), runs 15.5 to 18.0, max sample 17.3; wait p95 16.5, work p95 0.1, scene repainted in 0 of 20 pointerdowns
bench.dpr2.open20kMs: 1797.7 (S1 1412.0), runs 1667.3 to 1869.8; drawn 20000; first-frame render() 1703.5 ms; bitmap cache after open 619.2 MB
bench.dpr2.cacheMB: 741.8 after the pan and zoom phases (S1 563.3), cap 1,024 MiB
bench.dpr2.coldFrameMs: 537.5 at zoom 1 (bucket 2), 11.2 at zoom 0.6 (bucket 2, warm), 860.8 at zoom 1.4 (bucket 4) (S1: 370.3 and 510.7, in its buckets 1 and 2)

### DPR 1 (emulated)

bench.dpr1.pan: meanFps 43.1 (S1 43.3), p95FrameMs 33.4 (S1 33.4), drawMsMean 8.02 (S1 4.4), runs 37.4 to 44.1
bench.dpr1.zoom: meanFps 44.7 (S1 44.5), p95FrameMs 33.4 (S1 33.4), drawMsMean 8.36 (S1 5.48), runs 38.9 to 45.9
bench.dpr1.frames.drawn: 5000 drawn and 0 culled in every frame
bench.dpr1.firstInkP95Ms: 15.4 (S1 1.0), runs 12.8 to 16.7; wait p95 15.4, work p95 0.1, scene repainted in 0 of 20
bench.dpr1.open20kMs: 1749.5 (S1 1397.0), runs 1709.9 to 1890.4; first-frame render() 1657.4 ms; cache after open 155.9 MB
bench.dpr1.cacheMB: 186.3 after the phases (S1 141.6)
bench.dpr1.coldFrameMs: 454.9 at zoom 1 (bucket 1), 12.0 at zoom 0.6, 494.6 at zoom 1.4 (bucket 2) (S1: 363.8 and 388.8)

### 20,000-element scene (extra, S1 did not measure frames at 20,000)

bench.n20000.dpr2: pan meanFps 9.8 (p95 233.2, render 52.2 ms, 12,656 of 20,000 drawn), zoom meanFps 0.5 (p95 3031, render 1717 ms); cache pinned at the 1,024 MiB cap (1023.8 MB), so the visible text set no longer fits and the LRU thrashes
bench.n20000.dpr1: pan meanFps 16.1 (p95 67.5, render 26.6 ms), zoom meanFps 17.8 (p95 116.6, render 26.3 ms); cache 597.1 MB
bench.n20000.firstInk: p95 16.4 (dpr2) and 16.5 (dpr1), work p95 0.1, scene repainted 0 times

### As built, before the fixes below (dpr2 emulated with `deviceScaleFactor: 2`, 5 runs, n=5000)

bench.asBuilt.dpr2.pan: meanFps 30.3 (runs 24.1 to 33.9), p95FrameMs 99.9, drawMsMean 18.45
bench.asBuilt.dpr2.zoom: meanFps 1.8 (runs 1.3 to 1.8), p95FrameMs 1049.8, drawMsMean 493.3
bench.asBuilt.dpr2.firstInkP95Ms: 29.6 (every pointerdown repainted the whole scene)
bench.asBuilt.dpr2.open20kMs: 1887.4; cacheMB pinned at 255.7 (the 256 MiB cap)

### What each fix bought (dpr2 emulated, medians of 1 to 3 runs, n=5000, one fix added at a time)

bench.fixes.cap: RenderCache cap 256 MiB to 1,280 MiB: pan 40.3, zoom 31.5 (one run; 1,024 MiB is enough, 741.8 MB is held)
bench.fixes.saveRestore: ctx.save/restore and setLineDash only for elements that need them: pan 41.2, zoom 30.2, drawMsMean 14.3 (from about 18)
bench.fixes.overlayOnly: Editor.invalidateOverlay(), scene not repainted for selection and gesture previews: pan 42.3, zoom 33.1; first ink 30.4 to 16.6
bench.fixes.cullAndLayout: cull loop without bounds() for unrotated boxes, a cache hit skips layoutText: pan 42.9, zoom 33.8, drawMsMean 12.4
bench.fixes.imageBitmap: text bitmaps frozen with transferToImageBitmap (what S1 measured; an OffscreenCanvas as drawImage source is slower): pan 47.5, zoom 36.9, drawMsMean 8.5 (from 12.4)

## Acceptance

Thresholds: pan and zoom at least 90% of S1 cached means (DPR 2: pan 41.9, zoom 36.6; DPR 1: pan 39.0, zoom 40.1).

bench.accept.dpr2.pan: PASS, 45.1 fps against 41.9 (97% of S1)
bench.accept.dpr2.zoom: FAIL, 35.4 fps against 36.6 (87% of S1), 1.2 fps short after the fixes
bench.accept.dpr1.pan: PASS, 43.1 against 39.0 (99.5% of S1)
bench.accept.dpr1.zoom: PASS, 44.7 against 40.1 (100.4% of S1)
bench.accept.firstInk: FAIL on the literal metric at DPR 2 (p95 16.5 ms against 16; DPR 1 passes with 15.4). The cause is the display, not the Editor: the next rAF waits for the 60 Hz vsync (the wait is uniform from 0 to 16.7 ms, p95 16.5), and the Editor's own frame takes 0.1 ms at p95 with no scene repaint. S1's Chrome ran the rAF at once after an idle dispatch (wait p95 0.6 to 1.0 ms); this Playwright-launched Chrome does not. Judged on the Editor's work it is PASS by two orders of magnitude; the controller decides which definition is the bar
bench.accept.open20k: PASS at both DPRs, 1797.7 ms at DPR 2 and 1749.5 ms at DPR 1, against < 2000 (S1 1412 and 1397; headroom about 10% at DPR 2)
bench.accept.verdict: pan passes at both DPRs, zoom passes at DPR 1 and misses the 90% bar at DPR 2 by 1.2 fps; first ink passes only if the vsync wait is not counted; open 20k passes. No variant reaches 60 fps (S1 did not either)

## Decisions / needs-user-decision

Code changed outside the benchmark, all found by profiling the as-built numbers (core `render.ts`, `Editor`, select and shape tools; `pnpm test` and `pnpm e2e` pass):

- RenderCache default cap 256 MiB to 1,024 MiB. With the 256 MiB cap the working set of this scene (742 MB at DPR 2) misses on every element every frame, because the LRU is hit in z order (zoom 1.8 fps, cache pinned at 255.7 MB). S1 measured 563 MB uncapped.
- Text bitmaps are frozen with `transferToImageBitmap()` when the canvas has it (browser), as S1 did; Node canvases are unchanged. Cache hits carry their own size and skip `layoutText`.
- `render()` uses `ctx.save/restore` and `setLineDash` only for elements that are rotated, translucent or dashed, and culls unrotated boxes without `bounds()`; pixels are unchanged (all goldens pass).
- `Editor` has `invalidateOverlay()` and a scene-dirty flag: `invalidate()` still repaints everything; the select and shape tools use `invalidateOverlay()` for selection and gesture previews, so a pointerdown no longer repaints the whole scene (30 ms to 16.5 ms, all of it vsync wait). `Editor.lastRender` and `Editor.cacheBytes` (and `RenderCache.bytes`) expose what the page reads.

needs-user-decision: DPR 2 zoom is 35.4 fps, 1.2 fps short of the 90% bar (87% of S1 cached), and no variant reaches 60 fps. Options: (a) accept for M1 (pan passes, DPR 1 passes, the scene has 2,300 visible texts at DPR 2 against S1's 1,500, and a real board is far lighter); (b) cheaper text buckets (finer than powers of two, so zoom 1 to 1.4 at DPR 2 does not draw 4x bitmaps; not tried); (c) schedule the worker-canvas or WebGL rung (glyph atlas)
needs-user-decision: the 1,024 MiB RenderCache cap. It is what makes the 5,000-element scene work at DPR 2 (742 MB held) and is far above the old 256 MiB; it is a lot for a laptop with 8 GB and too much for iOS Safari's canvas memory budget. At 20,000 elements and DPR 2 the visible set still exceeds it (cache pinned at the cap, zoom 0.5 fps). Options: keep 1 GiB for desktop, set the cap from the device (`navigator.deviceMemory`, DPR), or draw text from a glyph atlas instead of per-element bitmaps
needs-user-decision: first-ink definition. Keep "dispatch to end of the next painting rAF, p95 <= 16 ms" (fails at DPR 2 by 0.5 ms because of vsync, in this Chrome) or use frame work (0.1 ms) as the bar

Not verified / limits: the first-ink event is synthetic (S1's method) and an empty marquee, not a stroke; real input goes through the browser's rAF-aligned input path. One machine, one Chrome build, a wallpaper-decoding background (like S1). The 20,000-element frame rows are single-purpose information, not acceptance rows. The step-by-step fix rows are 1 to 3 run medians at DPR 2 emulated. A final cosmetic rename in `render.ts` (a shadowed variable) was made after the five-run measurement; tests and e2e pass on it.
