# M2 Math and Images Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Equations and pictures look right at every zoom (0.05 to 20), a person can type LaTeX with a live preview and drop, paste or pick an image and crop it, and the camera can fly somewhere on request with a pulse (the primitive Jump-to-AI needs). M2 gate (PLAN §17): *math and images crisp at every zoom; math security tests pass.*

**Architecture:** A new package `packages/math` owns MathJax (TeX → SVG, allowlisted packages, async `renderMath()` + sync `peekMath()`, Arabic guard, SVG → bitmap and SVG → paths helpers). `packages/core` stays zod-only: it gains the `math` and `image` element types, a `BlobStore` interface, camera flight maths, and `render()` support through two small provider interfaces on `Platform` (`math`, `images`), so the same `render()` runs in the browser and, in M3, on the server. `apps/web` adds the blob store (IndexedDB), image import, the math tool with a floating editor, crop mode, `flyTo` and `pulse`. Everything still goes through `Editor.commit(batch)`: no new write path.

**Tech Stack:** as M1, plus `@mathjax/src` 4.1.3, `@mathjax/mathjax-newcm-font` 4.1.3, `@mathjax/mathjax-mhchem-font-extension` 4.1.3 (pins from S1), `@noble/hashes` or Web Crypto for SHA-256 (prefer Web Crypto, no dependency), `pixelmatch` + `pngjs` (tests only, for parity and sharpness). Pin exact versions at install.

**Spec:** [ROADMAP.md](../../ROADMAP.md) M2 · [math-renderer](../../plans/math-renderer.md) · [whiteboard-engine](../../plans/whiteboard-engine.md) · [testing-spikes](../../plans/testing-spikes.md) · S1 math results in [spikes/s1-canvas/RESULT.md](../../../spikes/s1-canvas/RESULT.md) (`server.math.*`) and the S1 fixtures under `spikes/s1-canvas/fixtures/`.

## Decisions taken in the grill (2026-11-02)

| # | Decision |
|---|---|
| Q1 | Branch `m2-math-images` is stacked on `m1-core`. M1 merges to `main` on its own schedule; M2 then rebases. |
| Q2 | The `RenderCache` cap comes from the device (fraction of `navigator.deviceMemory`, floor 128 MB, ceiling 512 MB, default 256 MB when unknown), replacing M1's fixed 1 GiB. Math and image bitmaps share one budget with text. No glyph atlas. |
| Q3 | Arabic inside math is an **error** (never a mis-shaped render). F14 closes as `latin-only`, enforced. |
| Q4 | Image import: drop, paste, toolbar file picker. PNG, JPEG, WebP, GIF (first frame); **SVG rejected**. ≤ 10 MB per file, long edge downscaled to 4096 px, EXIF orientation applied, SHA-256 dedupe. |
| Q5 | Crop is non-destructive (`data.crop` in source pixels) with a human crop mode. |
| Q6 | Math tool: click places, floating editor with live preview, Cmd/Ctrl+Enter or click-away commits, Esc cancels, double-click edits. No `$…$` inside text elements. |
| Q7 | `renderMath()` is async; `peekMath()` is the sync cache lookup the frame loop uses; a miss draws a placeholder and invalidates on completion. |
| Q8 | MathJax lives in `packages/math`, not `packages/core/math`. |
| Q9 | `flyTo` (zoom-out arc, cancel on input, reduced motion) and `pulse` (overlay only, never in ops). No Back chip, no Follow AI (M5). |
| Q10 | Perf gate is relative: 200 math ≥ 90% of 200 text; 200-math-only view holds 60 fps at DPR 1. |
| Q11 | Goldens are the Node output (20 fixtures); the browser path is pixel-diffed against them in Playwright. |
| Q12 | `BlobStore` interface; IndexedDB implementation; no GC; missing blob = placeholder. |
| Q13 | Bitmaps ≤ 4096 px a side; math beyond that is drawn as `Path2D`; image crispness is bounded by source resolution. |

### Decisions I add while planning **[my call]**, override any

| # | Decision | Why |
|---|---|---|
| P1 | **Drop `noundefined` from the TeX package list.** An undefined control sequence then throws through `formatError`, and `renderMath` returns `{error: "Undefined control sequence \\href"}`. | S1 found that with `noundefined` the six hostile payloads do not throw, they render red text. The roadmap says "render as errors", and the tutor (M5) needs the message to fix its LaTeX. With the packages not loaded, `\href \url \require \class \style \unicode` are undefined by construction. math-renderer.md's list changes accordingly. |
| P2 | **The Arabic guard checks the whole input**, not only `\text{}`: any letter in U+0600–U+06FF, U+0750–U+077F, U+08A0–U+08FF, U+FB50–U+FDFF, U+FE70–U+FEFF is an error (Arabic-Indic digits too: use 0–9). | Arabic letters in math mode have no glyph in MathJax's font and would draw as boxes. |
| P3 | **An invalid LaTeX commit is allowed in the editor** (the student keeps what they typed). The element stores `latex` and draws it as red monospace source with the message as a tooltip; the editor still shows the error live. `add_math` in M5 will refuse invalid LaTeX (tool result carries the message). | Matches math-renderer.md "Errors that teach" and loses no typing. |
| P4 | **Blob bytes go in a separate IndexedDB database** (`whiteboard-blobs`), not a new store in M1's `persist.ts` database. | M1's `persist.ts` opens its database at version 1 and its reader treats a newer version as unreadable; bumping it would risk locking out boards. |
| P5 | `math` and `image` element schemas keep `w`/`h` **stored** (as every element), computed by the creator from metrics. The renderer draws math fit into `w`×`h` preserving the aspect, so a stale `w`/`h` never stretches. | The schema stays uniform, the R-tree and hit-test need no async metrics, and M3's validator needs no MathJax. |
| P6 | **Path2D rung for math** is a small SVG subset parser in `packages/math` (`path`, `rect`, `g` with `transform`, `use` only if fontCache is none, which it is). On any other node (`<text>`, `<image>`, `<foreignObject>`) it returns `null` and the renderer falls back to the capped bitmap, upscaled. | Keeps the vector-crisp promise for the equations people use, without writing an SVG engine. |

## Global Constraints

- All M1 constraints stand (pnpm only, exact pins, strict TS, Biome, Vitest, one commit per task, tests beside sources, branch discipline, no `npx`).
- S1 math decisions verbatim: MathJax 4.1.3, TeX packages exactly `base, ams, boldsymbol, cancel, mathtools, mhchem` (**without** `noundefined`, see P1), `maxMacros: 1000`, `maxBuffer: 5120`, 4,000-character input limit, `liteAdaptor`, SVG `fontCache: 'none'`, `convertPromise` (dynamic font ranges), `formatError` throws, mhchem font extension registered on the SVG jax (`svgJax.addExtension(MathJaxMhchemFontExtension)`), root `width`/`height` rewritten to px from the `viewBox` (1000 units = 1 em) before rasterising because `ex` resolves differently per engine.
- `packages/core` gets **no** new runtime dependency. `packages/math` is the only package that imports `@mathjax/*`. `apps/web` and the server import `@whiteboard/math`.
- MathJax loads lazily in the browser (dynamic import behind the first `renderMath`), and must not appear in the editor's first-paint bundle. Check the Next build output.
- The frame loop never awaits and never lays out math or decodes images: it calls `peek`, draws a placeholder on a miss, and the provider calls `onReady` which calls `editor.invalidate()`.
- Pulse and flight are view state: never in ops, undo, snapshots, or the IndexedDB record.
- No network: images are never fetched from URLs (PLAN §1.5). Bytes enter only through a `File`/`Blob`.
- Local boards from M1 stay loadable (schema union only grows). Saved boards carry no image bytes, only `blobId`s.
- Element limits (new, from the engine doc's limits table where it speaks, else mine): `data.latex` ≤ 4,000 chars; image `naturalW/H` ≤ 8,192; `data.crop` inside the natural size; `math.data.size` 8..1000 px/em.

## Review Focus

Each line is pinned by a test in the task named. Most likely first.

1. **Hostile LaTeX.** The six payloads from math-renderer.md plus `\def`, `\newcommand`, `\let`, `\input`, `\write`, an `\expandafter` macro bomb, a 4,001-character input, and 100-deep nested braces. Expected: `{error}` always, no link, no network or module load, returns within 1 s → Task 1.
2. **Arabic and mixed input.** `\text{مرحبا}`, Arabic outside `\text`, Arabic-Indic digits, a Latin `\text{area}`. Expected: Arabic → the P2 error naming the fix; Latin `\text` renders → Task 1.
3. **Async seams.** The first frame with 200 uncached equations, a result arriving after the element was deleted or its `v` changed, the same LaTeX requested twice at once, MathJax failing to load (offline font range). Expected: placeholders, no stale draw, one render per key, a visible error state, never an unhandled rejection → Task 4 and Task 5.
4. **Memory.** 200 math + 50 large images at DPR 2 on a 4 GB `deviceMemory` budget; a 8,000 × 8,000 source; a tab that holds the cap while panning. Expected: cache bytes ≤ cap, no thrash loop (a bitmap over the cap is drawn directly, never evicts everything), originals evicted before displayed buckets → Task 5.
5. **Image import edge cases.** A 0-byte file, a renamed `.png` that is SVG or text, a 12 MB file, a 100-megapixel PNG, a rotated-EXIF JPEG, an animated GIF, a duplicate drop, a paste with no image, dropping 10 files at once. Expected: one clear message per failure, nothing added on failure, dedupe by hash, EXIF applied, 10 files land in a grid, one undo step for a multi-file drop → Task 6.
6. **Crop.** Crop then resize, crop then undo, crop to 1 px, a crop on a rotated image, crop handles at zoom 0.05 and 20. Expected: aspect follows the crop, `crop` always inside the natural size, undo restores, hit targets ≥ 7 screen px → Task 8.
7. **Flight.** Interrupted by wheel, drag, keys and a tool change; two flights in a row; target already in view; target 1e6 units away; zero-size rect; `prefers-reduced-motion`. Expected: no NaN, camera always inside zoom bounds, user input wins, a second call replaces the first → Task 9.
8. **Blob store.** Quota exceeded, IndexedDB unavailable (private mode), the second read-only tab, a board referencing a blob that was never stored. Expected: add fails with a visible message and no element, read-only tab renders what it has, missing blob = labelled placeholder → Task 6.

---

## File map

```
packages/math/
  package.json, tsconfig.json, vitest.config.ts
  src/index.ts          renderMath, peekMath, createMathProvider, types
  src/config.ts         TeX package allowlist, limits, MathJax document factory (lazy)
  src/arabic.ts         Arabic guard
  src/svg.ts            fixViewBox (px from viewBox), svgToPaths (P6)
  src/node.ts           rasterizeSvg for @napi-rs/canvas, font registration helper (reuses core/node fonts)
  src/*.test.ts, test/fixtures/equations.json (20), test/golden/*.png
packages/core/src/
  schema.ts             + MathData, ImageData, Crop, element union members, limits
  blob.ts               BlobStore interface, hashBytes(), BlobError
  platform.ts           + MathProvider, ImageProvider, rasterizeSvg?
  geometry.ts           bounds/hit-test/aspect-lock for math, image (box, rotated)
  render.ts             drawMath, drawImage, placeholders; RenderCache cap helper
  flight.ts             flightCamera(from, to, viewport, opts) pure
apps/web/src/editor/
  blobs.ts              IndexedDB BlobStore (database `whiteboard-blobs`)
  images.ts             import pipeline (validate, EXIF, downscale, hash), ImageProvider
  math.ts               MathProvider wiring (lazy import of @whiteboard/math)
  tools/math.ts         math tool + MathEditor overlay (DOM)
  tools/image.ts        image tool (picker), drop/paste hooks live in editor.ts
  tools/crop.ts         crop mode (opened by double-click on an image)
  editor.ts             + flyTo, pulse, cache sizing, provider wiring
apps/web/app/Toolbar.tsx  + Math, Image buttons
apps/web/src/bench/     + math and image scenes (Task 11)
e2e/m2-gate.spec.ts, e2e/math-parity.spec.ts
```

---

### Task 1: `packages/math`: secure, async `renderMath`

**Files:**
- Create: `packages/math/{package.json,tsconfig.json,vitest.config.ts}`, `src/{index.ts,config.ts,arabic.ts}`, `src/render.test.ts`, `src/security.test.ts`, `src/arabic.test.ts`
- Modify: root `pnpm-workspace.yaml` is already `packages/*`; root scripts need no change.

**Interfaces:**
- Produces:
  - `type MathOpts = {display: boolean; color: string}`.
  - `type MathResult = {ok: true; svg: string; width: number; height: number; depth: number} | {ok: false; error: string}`; metrics in em, `depth` = baseline descent (math-renderer.md).
  - `renderMath(latex: string, opts: MathOpts): Promise<MathResult>`: memoised by `hash(latex, display, color)`; concurrent identical calls share one promise; never rejects (failures become `{ok:false}`).
  - `peekMath(latex: string, opts: MathOpts): MathResult | undefined`: sync, cache only.
  - `MAX_LATEX = 4000`; `containsArabic(s: string): boolean`.
- `renderMath` order: length check → Arabic guard (P2, message `Arabic inside math isn't supported; put the label in a separate text element`) → MathJax. SVG `color` is applied as `fill`/`stroke` `currentColor` replacement, so one cached SVG per colour key.

- [ ] **Step 1: Write failing tests.** `security.test.ts`: each of `\href{javascript:alert(1)}{x}`, `\url{https://x.test}`, `\require{html}`, `\class{a}{x}`, `\style{color:red}{x}`, `\unicode{x41}`, `\def\a{b}`, `\newcommand{\a}{b}`, `\let\a=b`, `\input{x}`, `\write18{ls}` returns `{ok:false}` whose `error` names the control sequence; no output contains `<a `, `href`, `xlink` or `javascript:`; spy on `globalThis.fetch` and dynamic `import` (via the MathJax loader hook) shows no request for anything outside the font packages; a macro bomb and 100-deep braces finish in < 1 s with `{ok:false}` or a bounded SVG. `arabic.test.ts`: `\text{مرحبا}`, `مرحبا`, `x = ٣` → the P2 error; `\text{area}` and `\ce{H2O}` → ok. `render.test.ts`: fraction, matrix, `aligned`, `\mathbb{R}`, `\ce{2H2 + O2 -> 2H2O}`, `\cancel`, `\mathtools` `:=`: ok with `width, height > 0`; unbalanced brace and `\notamacro` → `{ok:false}` with MathJax's message; a 4,001-char input → `{ok:false}` mentioning 4,000; memoisation (two calls, one MathJax conversion, same object); `peekMath` is `undefined` before and the result after; different `color` → different SVG, same metrics.
- [ ] **Step 2: Run** `pnpm --filter @whiteboard/math test`, see them fail.
- [ ] **Step 3: Implement** `config.ts` by porting the S1 server math setup (`spikes/s1-canvas/server/`) with the P1 change, behind a lazy `getDocument()` so importing the package is free. Map every MathJax throw to `{ok:false, error}` (first line of the message, no stack). Keep the mhchem font extension registration.
- [ ] **Step 4: Run** tests PASS. **Step 5: Lazy-load proof:** a unit test that importing `@whiteboard/math` does not import `@mathjax/src` until the first `renderMath` call (module-graph spy). **Step 6: Commit** `feat(math): secure async renderMath with Arabic guard`.

---

### Task 2: SVG helpers, Node rasteriser and the golden harness

**Files:**
- Create: `packages/math/src/{svg.ts,node.ts}`, `src/svg.test.ts`, `src/golden.test.ts`, `test/fixtures/equations.json`, `test/golden/*.png`, `test/matchesGolden.ts` (reuses core's tolerance helper if exported, else copy)

**Interfaces:**
- Produces:
  - `fixViewBox(svg: string, pxPerEm: number): {svg: string; w: number; h: number}`: rewrites root `width`/`height` to px from the `viewBox` (1000 units = 1 em).
  - `svgToPaths(svg: string): MathPaths | null` (P6): `{viewBox: [x, y, w, h]; items: {d: string; m: [a,b,c,d,e,f]; fill: string}[]}` with rects converted to paths; `null` on any unsupported node.
  - `rasterizeSvgNode(svg: string, w: number, h: number): Promise<CanvasLike>` using `@napi-rs/canvas` `loadImage`.
- Fixtures: the 20 S1 equations **minus** the two Arabic cases (they move to `arabic.test.ts` as error cases), plus two Latin `\text` cases (`\text{area} = \pi r^2`, `v = \frac{d}{\text{time}}`) and two edge cases (a 3-level nested fraction, a wide `align` with `\tag`-free numbering-less rows). Total 20.

- [ ] **Step 1: Write failing tests:** `svg.test.ts`: `fixViewBox` output has px root size from the viewBox for three fixtures; `svgToPaths` returns non-null for all 20 fixtures and the sum of item bounding areas is within 2% of the rasterised ink area; returns `null` for an SVG containing `<text>`. `golden.test.ts`: every fixture rasterised at 40 px/em matches its committed PNG (tolerance ≤ 0.5% differing pixels, per-channel threshold 16), and re-rasterising the `svgToPaths` output through `Path2D` on `@napi-rs/canvas` matches the SVG raster within ≤ 2%.
- [ ] **Step 2: Run** and see them fail (no goldens yet). **Step 3: Implement** the helpers; generate goldens once with `pnpm --filter @whiteboard/math golden:update` and **inspect the contact sheet by eye** (no blind accepts; same 18-of-18 visual check as S1).
- [ ] **Step 4: Run** PASS. **Step 5: Commit** `feat(math): svg helpers, node rasteriser, 20 golden equations`.

---

### Task 3: Core schema, blob interface, geometry for `math` and `image`

**Files:**
- Modify: `packages/core/src/schema.ts`, `ops.ts` (patch-path check covers new data), `geometry.ts`, `main.ts`
- Create: `packages/core/src/blob.ts`, `blob.test.ts`; extend `schema.test.ts`, `ops.test.ts`, `geometry.test.ts`, `scene.test.ts`

**Interfaces:**
- Produces:
  - `MathData = {latex: string (≤ 4000); display: boolean; size: number (8..1000)}`; element `type: 'math'`; colour is `style.stroke` (as text does); `alt` is the `latex` itself.
  - `Crop = {x: number; y: number; w: number; h: number}` in source pixels; `ImageData = {blobId: string (64 hex chars); naturalW: number; naturalH: number (1..8192, int); crop?: Crop; alt?: string (≤ 500)}`; element `type: 'image'`. Refinement: crop `w,h ≥ 1` and inside `[0,naturalW]×[0,naturalH]`.
  - `ElementSchema` union gains both members (M1 members untouched). Existing M1 boards parse unchanged.
  - `interface BlobStore {put(bytes: Uint8Array, mime: string): Promise<string>; get(id: string): Promise<{bytes: Uint8Array; mime: string} | undefined>; has(id: string): Promise<boolean>}`; `hashBytes(bytes): Promise<string>` (SHA-256 hex, Web Crypto; Node 22 has it); `class BlobError extends Error {code: 'quota'|'unavailable'|'too-large'|'unsupported'}`.
  - Geometry: `boundsOf`, `hitTest` and the rotated hit rule from M1 treat both as rotated boxes; `lockedAspect(el): number | null` returns `w/h` for math and image, `null` otherwise; `fitMath(metrics, size): {w, h}` (pure helper: `w = width * size`, `h = (height + depth) * size`).
- [ ] **Step 1: Write failing tests:** valid math (LaTeX with backslashes, 4,000 chars) and image parse; 4,001-char latex, `size: 7`, `blobId` not 64-hex, `naturalW: 0`, crop outside the natural size, `crop.w: 0`, unknown extra fields stripped; `patch` paths `data.latex`, `data.crop`, `data.crop.x` accepted, `data.nope` rejected; an M1 board snapshot fixture still parses; apply/inverse property test (M1's) extended with math and image elements; rotated image hit-test at zoom 0.05 and 20, DPR 1 and 2 (click 7 screen px outside misses); `lockedAspect`.
- [ ] **Step 2: Run** and see them fail. **Step 3: Implement.** **Step 4: Run** PASS. **Step 5: Commit** `feat(core): math and image elements, blob interface`.

---

### Task 4: `render()` draws math (placeholder, bucket bitmap, Path2D rung)

**Files:**
- Modify: `packages/core/src/platform.ts`, `render.ts`, `render.test.ts`; Create: `apps/web/src/editor/math.ts`

**Interfaces:**
- Consumes: Task 1 and Task 2 APIs through the provider interface (core does not import `@whiteboard/math`).
- Produces in `platform.ts`:
  - `interface MathProvider {peek(latex: string, display: boolean, color: string): {ok: true; width: number; height: number; depth: number; bitmapFor(pxPerEm: number): CanvasImageSource | null; paths(): MathPaths | null} | {ok: false; error: string} | undefined; request(latex: string, display: boolean, color: string, onReady: () => void): void}`.
  - `Platform.math?: MathProvider`, `Platform.rasterizeSvg?(svg: string, w: number, h: number): Promise<CanvasLike>`.
- `drawMath` rules: bucket = `zoomBucket(scale × size / 16)`-style power-of-two as text does, cache key `(bucket, id, v)`; miss on `peek` → dashed placeholder box (size `w`×`h`) and one `request`; `{ok:false}` → red monospace source, wrapped into `w`×`h`, with `data-tip` behaviour left to the DOM layer (the renderer exposes `mathError(id)` via the editor); fit into `w`×`h` preserving the aspect (P5); baseline alignment from `depth`; if the on-screen bitmap would exceed `MAX_BITMAP` (4096) use `paths()`; if that is `null`, draw the capped bitmap upscaled.
- `apps/web/src/editor/math.ts`: `createWebMathProvider(onReady)` does `import('@whiteboard/math')` once, rasterises with `createImageBitmap` from an SVG `Blob` URL revoked immediately after decode (never an `<img>` in the DOM), holds results in a memo keyed like Task 1, and calls `onReady` once per key.
- [ ] **Step 1: Write failing tests (Node, `@napi-rs/canvas`):** with a fake provider: a miss draws the placeholder and calls `request` exactly once across 10 frames; a ready result draws and a second frame hits the cache (no `bitmapFor` call); a result arriving for a deleted element or a changed `v` is not drawn; `{ok:false}` draws red source; a bitmap over 4096 px takes the `paths()` branch, and `paths() === null` takes the upscaled-bitmap branch; rotation, flip and `opacity` use the normal transform; golden: five equations at zoom 0.05, 1, 4, 20 with a real provider on the Node platform match goldens within tolerance.
- [ ] **Step 2: Run** and see them fail. **Step 3: Implement.** **Step 4: Run** PASS. **Step 5: Commit** `feat(core): render math elements with async provider`.

---

### Task 5: `render()` draws images; device-sized `RenderCache`

**Files:**
- Modify: `packages/core/src/platform.ts`, `render.ts`, `render.test.ts`; Create: `apps/web/src/editor/images.ts` (provider part), `packages/core/src/cachebudget.ts`, `cachebudget.test.ts`

**Interfaces:**
- Produces:
  - `interface ImageProvider {peek(blobId: string): {bitmap: CanvasImageSource & {close?(): void}; w: number; h: number} | 'missing' | undefined; request(blobId: string, onReady: () => void): void}`; `Platform.images?: ImageProvider`.
  - `cacheBudgetBytes(opts: {deviceMemoryGB?: number; dpr: number}): number`: `clamp(deviceMemoryGB * 2**30 * 0.06, 128 MB, 512 MB)`, 256 MB when `deviceMemoryGB` is unknown, ×0.75 for `dpr ≥ 3`. `new RenderCache(cacheBudgetBytes(...))` in the editor.
- `drawImage` rules: crop → source rect; zoom-out: bucket-scaled copy cached under key `img:${blobId}:${crop}` with `v = 0` (shared by duplicates), bucket = largest power of two ≤ 1 such that bucket ≥ on-screen scale, never upscaled past the original; zoom-in (bucket would exceed the original) draws the original bitmap directly; a missing blob draws the dashed placeholder labelled `missing image`; originals held by the provider live in the **same** `RenderCache` and are evicted first (their cache entries are marked `tier: 'original'`; `RenderCache` evicts that tier before any displayed bucket).
- `RenderCache` change: eviction never loops when a single entry exceeds the cap (the entry is drawn directly and not retained), and exposes `bytes`/`cap` for the bench.
- [ ] **Step 1: Write failing tests:** crop rect honoured pixel-exact on a 4-colour test image; zoom 0.05 draws a ≤ 1/16 bucket copy, zoom 20 draws the original; two elements with the same blob share one cache entry; originals evicted before buckets under pressure; an entry larger than the cap is not retained and does not evict others; `cacheBudgetBytes` table (2, 4, 8, 16 GB, unknown, DPR 3); `'missing'` draws the labelled placeholder and never throws; `undefined` draws the plain placeholder and requests once.
- [ ] **Step 2: Run** and see them fail. **Step 3: Implement.** **Step 4: Run** PASS. **Step 5: Commit** `feat(core): render images with zoom buckets and device cache budget`.

---

### Task 6: Blob store, image import pipeline, drop / paste / picker

**Files:**
- Create: `apps/web/src/editor/blobs.ts`, `blobs.test.ts`, `images.ts` (import part), `images.test.ts`, `tools/image.ts`
- Modify: `apps/web/src/editor/editor.ts` (drop and paste handlers, `addImages(files, at?)`), `apps/web/app/Toolbar.tsx` (Image button, hidden file input), `tools/index.ts`

**Interfaces:**
- Produces:
  - `createIdbBlobStore(): BlobStore` over database `whiteboard-blobs`, one object store keyed by hash, `put` is idempotent (dedupe), quota and `unavailable` mapped to `BlobError`.
  - `importImage(file: File, store: BlobStore): Promise<{blobId, naturalW, naturalH}>`: checks size ≤ 10 MB, sniffs magic bytes (PNG, JPEG, WebP, GIF; extension and `file.type` are not trusted; SVG and everything else → `BlobError 'unsupported'`), decodes with `createImageBitmap(blob, {imageOrientation: 'from-image'})`, rejects decode of more than 100 megapixels before allocating, downscales the long edge to 4096 and re-encodes (PNG for alpha, JPEG q0.92 otherwise; GIF → first frame as PNG), hashes the stored bytes, `put`s them. Original bytes are not kept when downscaling was needed (only the 4096 version) **[my call]**: the original is never rendered above 4096 px a side anyway, and it halves quota use.
  - `Editor.addImages(files: File[], at?: Point): Promise<{added: Id[]; failed: {name: string; message: string}[]}>`: one batch labelled `Add image` (or `Add N images`), placed at `at` or the viewport centre, a multi-file drop in a grid (4 columns, 24 world px gap), initial width = min(natural, 480 world px at zoom 1, 60% of the viewport), `h` from the aspect.
  - Drop on the canvas, `paste` event (image items only; text paste still goes to the text tool), toolbar picker (`accept="image/png,image/jpeg,image/webp,image/gif"`).
  - Toast-style status line for failures (reuse M1's notice component), one message per file.
- [ ] **Step 1: Write failing tests (`fake-indexeddb`, jsdom or the repo's test env):** the Review Focus 5 and 8 cases: 0-byte file, SVG renamed `.png`, text renamed `.png`, 12 MB file, 100-megapixel header, EXIF-rotated JPEG ends upright (dimensions swapped), animated GIF imports as one frame, duplicate drop stores one blob and adds two elements, paste without an image does nothing, 10 files give 10 elements in one batch and one undo, quota exceeded gives a message and no element, IndexedDB unavailable gives a message and no element, a second read-only tab cannot add.
- [ ] **Step 2: Run** and see them fail. **Step 3: Implement**; wire `Platform.images` to the store through `createBitmapProvider(store, cache, onReady)` (decode once per blob, shared in-flight promise). **Step 4: Run** PASS; manual check in Chrome: drop a PNG, paste a screenshot, pick a JPEG. **Step 5: Commit** `feat(web): blob store and image import (drop, paste, picker)`.

---

### Task 7: Math tool with a floating live-preview editor

**Files:**
- Create: `apps/web/src/editor/tools/math.ts`, `math.test.ts`, `apps/web/src/editor/MathEditor.ts` (DOM overlay), `fonts` note: monospace stack only, no web font
- Modify: `tools/index.ts`, `Toolbar.tsx` (Math button, key `m`), `editor.ts` (`editMath(id)`, `Editor.mathEditing` like `editingId` for text so the element is not drawn under its own editor)

**Interfaces:**
- Produces:
  - Tool `math` (key `m`): click places a new empty math element at the pointer and opens `MathEditor`; double-click on a math element with Select or Math opens it; the element is hidden on the canvas while its editor is open (as text is).
  - `MathEditor`: LTR monospace `<textarea>` (`dir="ltr"`, `spellcheck=false`, `autocapitalize=off`), a preview area using the Task 4 provider (debounced 150 ms, last result wins), the MathJax error in red under the box, a **Display / Inline** toggle, a size control (8..1000 px/em, default 28), colour from the current stroke. Commit on Cmd/Ctrl+Enter or click-away; Esc cancels; empty commit removes the element (new) or keeps the old value (existing, Esc semantics) **[my call]: an empty commit of an existing element deletes it, same as text in M1**. Commit is exactly one batch: `add` (new) or one `patch` of `data.latex`, `data.display`, `data.size`, `w`, `h` (edit); one undo step.
  - Invalid LaTeX commits (P3): `w`/`h` come from measuring the red source text on the platform, `latex` stored as typed.
  - Every other path in the editor treats the element as normal (move, rotate, copy, delete, select); resize keeps the aspect (`lockedAspect`) and changes `data.size` and `w`/`h` together in the same batch.
  - Draft autosave: the M1 text draft mechanism also stores an open math draft in the snapshot, so a reload does not lose typing.
- [ ] **Step 1: Write failing tests:** place, type `\frac{a}{b}`, Cmd+Enter creates one element with `w, h > 0` and one undo step; Esc on new creates nothing; Esc on an existing element changes nothing; click-away commits; empty commit deletes (existing) or creates nothing (new); invalid `\frac{` commits with red source and the error text shown while typing; Arabic input shows the P2 message and still commits as an error element; the preview debounce (fake timers: ≤ 1 render per 150 ms window, stale results dropped); resize keeps the aspect and size patch is atomic with `w`/`h`; draft survives a simulated reload; typing `m` in a text editor does not switch tools.
- [ ] **Step 2: Run** and see them fail. **Step 3: Implement.** **Step 4: Run** PASS. **Step 5: Commit** `feat(web): math tool with live LaTeX preview`.

---

### Task 8: Crop mode for images

**Files:**
- Create: `apps/web/src/editor/tools/crop.ts`, `crop.test.ts`
- Modify: `tools/select.ts` (double-click an image opens crop mode), `editor.ts` (`cropping` state hides selection handles, draws the full image dimmed with the crop window lit on the overlay)

**Interfaces:**
- Produces: crop mode shows the **uncropped** image faded with a bright crop window and 8 handles (≥ 7 screen px hit targets, same at every zoom); drag handles or the window; Enter or click-away commits, Esc cancels. Commit is one `patch` of `data.crop`, `x`, `y`, `w`, `h` (the box keeps its on-screen scale and moves so the visible pixels stay where they were); crop clamps to the natural size and to ≥ 1 source pixel; the element's aspect becomes the crop's aspect; rotation handled by working in the element's local space. Removing the crop (a `Reset crop` button in the selection toolbar, or double-click then drag to full) patches `data.crop` to the full rect or removes it.
- [ ] **Step 1: Write failing tests:** crop to the top-left quarter keeps the quarter's world position; crop then resize keeps the aspect; crop then undo restores `crop`, `x`, `y`, `w`, `h` in one step; crop to 1 px; crop on an image rotated 30°; drag outside the image clamps; handles hit at zoom 0.05 and 20 with 7 px tolerance; Esc leaves the element identical (`v` unchanged).
- [ ] **Step 2: Run** and see them fail. **Step 3: Implement.** **Step 4: Run** PASS. **Step 5: Commit** `feat(web): non-destructive image crop`.

---

### Task 9: Camera `flyTo` and `pulse`

**Files:**
- Create: `packages/core/src/flight.ts`, `flight.test.ts`
- Modify: `apps/web/src/editor/editor.ts`, `editor.test.ts`

**Interfaces:**
- Produces:
  - Core, pure: `flightCamera(from: Camera, to: Camera, viewport: Viewport): (t: number) => Camera` for `t ∈ [0, 1]`: log-space zoom interpolation with an ease-in-out on `t`, and a zoom-out dip that grows with the world distance relative to the viewport (no dip when the target is already on screen); `flightDuration(from, to, viewport): number` = 600 ms scaled by distance, clamped to [250, 1200] ms; `cameraFor(rect: Rect, viewport: Viewport, opts: {padding?: number; maxZoom?: number}): Camera` (fit with padding, default 48 px, `maxZoom` default 2, clamp to `[ZOOM_MIN, ZOOM_MAX]`).
  - Editor: `flyTo(target: Rect | Id[], opts?: {padding?: number; maxZoom?: number; duration?: number}): Promise<'done' | 'cancelled'>` (a second call cancels the first, which resolves `'cancelled'`); `pulse(target: Rect | Id[]): void`; `cancelFlight(): void`. Flight runs in the frame loop (no extra timers) and cancels on `wheel`, pointer down, key down, tool change and `setScene`; the user's camera wins. `prefers-reduced-motion: reduce` → instant jump, pulse is a single static 1.2 s outline with no scaling. Pulse draws on the overlay canvas: two expanding outline halos over ~1.2 s on the bounds of the element ids **re-read every frame** (so it follows an element that is moving, and ends quietly if the element is deleted). Neither is stored anywhere: `getSnapshot()` is unchanged by them.
- [ ] **Step 1: Write failing tests:** `flightCamera(a, b)(0)` equals `a` and `(1)` equals `b` exactly; every intermediate zoom is inside `[ZOOM_MIN, ZOOM_MAX]` and finite for targets 0, 1e3, 1e6 and 1e9 units away; no dip for an on-screen target and a dip (zoom lower than both ends) for a far one; `flightDuration` bounds; `cameraFor` of a zero-size rect and of a rect larger than the viewport; Editor: `flyTo` resolves `'done'` with the camera equal to the target; a wheel event mid-flight resolves `'cancelled'` and leaves the camera where it was; a second `flyTo` replaces the first; reduced motion jumps in the same frame; `pulse` of a deleted id does not throw; neither `flyTo` nor `pulse` marks the editor dirty for autosave or adds an undo entry.
- [ ] **Step 2: Run** and see them fail. **Step 3: Implement.** **Step 4: Run** PASS. **Step 5: Commit** `feat: camera flyTo and pulse`.

---

### Task 10: Parity and crispness checks (Playwright)

**Files:**
- Create: `e2e/math-parity.spec.ts`, `e2e/crisp.spec.ts`, `e2e/helpers/diff.ts` (`pixelmatch`, saves `*-diff.png` on failure)

**Interfaces:**
- Produces:
  - `math-parity.spec.ts`: renders the 20 fixtures in the real page (through the same `Editor` and web provider) and compares each screenshot crop to the committed Node golden: ≤ 1.5% differing pixels, per-channel threshold 24; failures write expected, actual and diff PNGs to `test-results/`.
  - `crisp.spec.ts`: a board with three equations (fraction, matrix, `\ce`) and one 2,000 px synthetic checker image, zoomed to 0.05, 1, 4 and 20; for math, the edge-sharpness metric (mean gradient magnitude along a vertical stem at 20×) is ≥ 90% of a reference rendered by drawing the SVG paths straight at that scale; for the image at zoom 1 and below, the downscaled copy has no more than 1 px of blur on checker edges (and at 20× equals the source's nearest-neighbour edge sharpness). Recorded numbers go in `apps/web/src/bench/RESULT.md`.
- [ ] **Step 1: Write the specs** (failing until Tasks 4 to 7 are done in the browser); **Step 2: Run** `pnpm e2e` and fix what they expose. **Step 3: Commit** `test: math parity and crispness e2e`.

---

### Task 11: Benchmark: 200 math and image scenes

**Files:**
- Modify: `apps/web/src/bench/page.tsx`, `scene.ts`; Update: `apps/web/src/bench/RESULT.md`

**Interfaces:**
- Produces: bench scenes `math200` (200 equations from the fixtures, all on screen, after first render), `text200` (200 text elements of similar size, the baseline), `images50` (50 images of 1,000 to 4,000 px), and the M1 5,000-element scene with a 10% math + image mix; same method as M1 Task 12 (1 s warm-up, 5 s Lissajous pan, 5 s zoom ±0.4, five runs, medians), DPR 2 and 1, plus cache MB against the device budget.
- Acceptance (Q10, user may override): `math200` pan and zoom medians ≥ 90% of `text200` at the same DPR; `math200` at DPR 1 holds 60 fps; cache bytes ≤ cap in every scene; first ink p95 and open-20k numbers not worse than M1's by > 10%.
- [ ] **Step 1: Extend the page and scenes.** **Step 2: Run** on this Mac with the M1 conditions (headed, AC power, tab focused). **Step 3: Record** numbers and PASS/FAIL. A miss gets a one-line `needs-user-decision:` in the status log, not a silent rewrite of the bar. **Step 4: Commit** `bench: math and image scenes`.

---

### Task 12: Gate script, docs and demo

**Files:**
- Create: `e2e/m2-gate.spec.ts`
- Modify: `docs/ROADMAP.md` (M2 status and status log), `docs/PLAN.md` (§19 decisions 23 to 28, §17 untouched), `docs/plans/math-renderer.md`, `docs/plans/whiteboard-engine.md` (math and image elements, `flyTo`, `pulse`, crop), `docs/plans/testing-spikes.md` (Engine note: M2 script and numbers), `docs/plans/tech-stack.md`, `README.md` (layout)

**Interfaces:**
- Produces the M2 gate as Playwright, deterministic, no network: open the page; choose the Math tool, type `\frac{a}{b} + \ce{H2O}`, see the preview, Cmd+Enter, the element exists; type invalid `\frac{`, see the red error, commit, see red source; drop a generated PNG (checker 1,200 × 800) with a real `DataTransfer`; double-click it, crop to a quarter, Enter; zoom to 0.05, 1, 4, 20 and assert no console error and the crispness metric; reload, both elements and their pixels are back (blob present); undo three times and redo once; a second tab is read-only and still renders both; `editor.flyTo` to a far element resolves `'done'` and the pulse draws without a console error; hostile LaTeX typed into the editor shows an error and adds no link or request (`page.on('request')` sees nothing outside the origin).
- [ ] **Step 1: Write the e2e;** **Step 2: Run** `pnpm e2e` red then green. **Step 3: Full gate:** `pnpm install --frozen-lockfile && pnpm lint && pnpm typecheck && pnpm test && pnpm e2e && pnpm build` all exit 0, and the Next build shows MathJax in its own lazy chunk, not the initial one.
- [ ] **Step 4: Manual demo with the user:** type a LaTeX equation and see it live, drop an image, crop it, zoom 0.05 to 20, reload. Record the result.
- [ ] **Step 5: Update docs** (below), set M2 to ◐ or ✔ per what passed. **Step 6: Commit** `docs: M2 gate results and status`.

**Docs changes (the decisions and the `math-renderer.md`/ROADMAP/PLAN/tech-stack/README text were written with this plan; this task adds the measured numbers and final status):**
- `PLAN.md` §19, decisions 23 to 28: 23 `packages/math` and async `renderMath`/`peekMath`; 24 device-sized `RenderCache`; 25 Arabic inside math is an error (F14 closed); 26 image import limits and SVG rejected, non-destructive crop; 27 `flyTo`/`pulse` are view state; 28 math package list drops `noundefined`.
- `math-renderer.md`: new location and API, async note, P1 package list, P2 guard, P3 invalid-commit behaviour, P6 vector rung, Arabic section rewritten as decided, tests section updated.

---

## Self-review

- **Spec coverage (ROADMAP M2):** `renderMath()` MathJax v4 TeX → SVG → cached bitmap (1, 2, 4) · live LaTeX box (7) · image element with upload and crops (3, 5, 6, 8) · zoom-bucket caches (4, 5) · camera `flyTo` + pulse (9) · gate "crisp at every zoom" (10, 12) · gate "math security tests pass" (1) · six hostile payloads and error tests (1) · ~20 goldens Node vs browser (2, 10) · 200 math elements perf (11) · seam 6 blob bytes in IndexedDB by content hash (6) · F14 closed (1).
- **Type consistency:** `MathResult`, `MathProvider`, `ImageProvider`, `BlobStore`, `Crop`, `lockedAspect`, `fitMath`, `cameraFor`, `flightCamera`, `Editor.flyTo`/`pulse` are defined once and used with the same names later.
- **Open for the user (before code starts):** (1) **P1**, dropping `noundefined` (changes a line of math-renderer.md that S1 pinned); (2) **P3**, invalid LaTeX allowed to commit as red source; (3) **P6**, the Path2D rung's SVG subset parser is the riskiest new code (the fallback is an upscaled bitmap, so a bad parse degrades softness, not correctness); (4) the originals-not-kept choice for downscaled images in Task 6; (5) whether MathJax's lazy chunk splits cleanly under Next 16 (verified in Task 1 step 5 and Task 12 step 3; if it does not, the fallback is a Web Worker import).
