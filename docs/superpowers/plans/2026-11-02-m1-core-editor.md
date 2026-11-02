# M1 Core Editor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A person can draw shapes with bound arrows and write Arabic and Latin text on a fast infinite canvas, undo, and reload without losing anything (M1 gate: shapes, Arabic + Latin text, undo, local save).

**Architecture:** `packages/core` holds everything that must run in the browser and in Node: zod schemas, scene store, ops and inverses, undo, geometry, R-tree, and a pure `render(ctx, scene, camera, viewport, platform)`. `apps/web` (Next.js, client-only) holds the editor shell: two canvases, frame loop, tools, the `<textarea>` overlay and IndexedDB save. Nobody writes scene state directly; every change is a batch of ops, so M3's server and M5's tutor reuse the same path.

**Tech Stack:** Node 22.21.1, pnpm 12.8.1, TypeScript 7 strict, zod 4.6, Vitest 5, Biome 2.6, Playwright 1.64, Next.js 16.4 + React, `rbush` 4.0.1, `fractional-indexing` 4.0, `nanoid` 6.0, `@napi-rs/canvas` 1.1.0 (tests only), `fake-indexeddb` (tests only), `@fontsource/ibm-plex-sans-arabic` 5.3.0. Pin exact versions at install; use whatever the generators emit for Next, then pin.

**Spec:** [ROADMAP.md](../../ROADMAP.md) M1 · [whiteboard-engine](../../plans/whiteboard-engine.md) · [tech-stack](../../plans/tech-stack.md) · [testing-spikes](../../plans/testing-spikes.md) (Engine, Test strategy) · S1 decisions in [spikes/s1-canvas/RESULT.md](../../../spikes/s1-canvas/RESULT.md).

## Global Constraints

- pnpm only; never npm, yarn, bun or `npx` (use `pnpm exec` / `pnpm dlx`). Root `package.json` keeps `"packageManager": "pnpm@12.8.1"`; commit `pnpm-lock.yaml`; never create `package-lock.json`. New native builds go through `pnpm approve-builds`.
- Workspace is `packages/*`, `apps/*`; the M0 `spikes/*` stay as reference and are not imported. Package names `@whiteboard/core`, `@whiteboard/web`.
- S1 decisions, copied verbatim: `textStrategy: cached` (bitmaps keyed by zoom bucket `2^ceil(log2 zoom)`, element id and `v`; bitmaps over 4096 px a side are drawn directly), `renderThread: main`, `spatialIndex: rbush`, `freehand: perfect-freehand` (used in M6, not M1), `font: plex` (IBM Plex Sans Arabic; `arabic` and `latin` subset files are separate families, so the canvas font is the stack `Plex-Arabic, Plex-Latin`), `snapshotPath: server-canvas`, `mathTextArabic: latin-only`.
- A canvas never triggers a web-font load: `await document.fonts.load()` for both families before the first draw (S1 lesson).
- Targets: first ink ≤ 16 ms; a 20,000-element board opens in < 2 s; zoom 0.05 to 20; world units are CSS px at zoom 1.
- Element model, ops and conflict rules are exactly those in whiteboard-engine.md: four ops (`add`, `patch` with dotted paths, `remove`, `reorder`), a batch `{batchId, label, ops}` is atomic and is the unit of undo, undo is a new inverse batch, `v` bumps on every accepted change, `z` is a fractional index.
- M1 element types are `shape` (rect, ellipse, diamond, triangle, line, arrow) and `text`. Not in M1: math, image, chart, freehand, group, polygon, sync, `seq`, the server. The schema is a discriminated union on `type`, so M2 and M6 add members without touching these.
- Spike code is throwaway; M1 code is kept. Biome, strict TypeScript and Vitest gate every task. Work on branch `m1-core`, one commit per task, stage only the task's own files, message ends with the `Claude-Session:` trailer the controller gives.
- Every test file lives next to its source as `*.test.ts`. Golden images are PNGs under `packages/core/test/golden/` compared by `matchesGolden(canvas, name)` (Task 6), never by exact bytes.

## Review Focus

Each line is pinned by a test in the task named. Most likely first.

1. Text edge inputs: empty and whitespace-only text, a 10,000-character paste, emoji with ZWJ, combining marks and harakat, mixed Arabic/Latin lines, a line break inside RTL text. Expected: no crash, no zero-size element left behind, cursor and layout stay in logical order → Task 7 and Task 10.
2. A bound arrow whose target is moved, rotated, resized, deleted, or whose deletion is undone. Expected: the arrow follows, a deleted target leaves the arrow with a free end at its last position, undo restores the binding → Task 5 and Task 9.
3. Hit-testing and selection at zoom 0.05 and 20, DPR 1 and 2, on a rotated shape and on rotated text. Expected: the click that lands visually on the element selects it, the click 7 screen px outside does not → Task 5.
4. Reload with IndexedDB unavailable, over quota, corrupt, or holding a newer schema version; and the same board open in two tabs. Expected: the app still opens (empty board, visible notice), never overwrites what it could not read, the second tab opens read-only with a banner → Task 11.
5. Undo when a field changed since (skip and report), undo of a batch whose element was removed, and undo/redo across a reload. Expected: the skipped count is returned, nothing throws, the scene stays valid → Task 4.

---

## File map

```
packages/core/src/
  schema.ts        zod: Element (shape|text), Op, Batch, Camera, Viewport; ids; style defaults
  ops.ts           validateBatch, OpError
  scene.ts         Scene, createScene, applyBatch (+ inverse), zOrder helpers
  undo.ts          UndoManager
  geometry.ts      bounds, rotate helpers, hitTest, arrow routing (anchors)
  index.ts         SpatialIndex over rbush
  main.ts          public barrel (package entry)
  platform.ts      Platform interface + FONT_STACK
  text.ts          layoutText (Intl.Segmenter, bidi direction)
  render.ts        render(), caches, camera matrix helpers
  node.ts          Node platform (@napi-rs/canvas) + bundled font registration; separate entry "@whiteboard/core/node"
packages/core/test/  golden/*.png, matchesGolden.ts, fixtures
apps/web/src/
  app/page.tsx     client-only editor page
  editor/editor.ts Editor: scene, camera, undo, tools, commit(), frame loop, canvases
  editor/tools/    select.ts shape.ts hand.ts text.ts (one file per tool + registry in tools/index.ts)
  editor/persist.ts IndexedDB save/load + navigator.locks
  editor/fonts.ts  loadFonts()
  bench/           real-renderer benchmark page (Task 12)
e2e/               Playwright specs
```

---

### Task 1: Workspace scaffold and quality gates

**Files:**
- Modify: `pnpm-workspace.yaml` (add `packages/*`, `apps/*`, keep `spikes/*` and the `allowBuilds` block), root `package.json` (scripts), `.gitignore`
- Create: `biome.json`, `tsconfig.base.json`, `packages/core/{package.json,tsconfig.json,vitest.config.ts,src/main.ts}`, `apps/web` (Next scaffold, client-only), `.github/workflows/ci.yml`

**Interfaces:**
- Produces: root scripts `pnpm dev` (web on :3000), `pnpm build`, `pnpm test` (Vitest, all packages), `pnpm lint` (Biome check), `pnpm e2e` (Playwright); `@whiteboard/core` exports an empty barrel; `@whiteboard/web` imports it.

- [ ] **Step 1: Write a smoke test** `packages/core/src/smoke.test.ts` asserting `import('./main')` resolves; run `pnpm test` and see it fail (no package yet).
- [ ] **Step 2: Scaffold** the packages with exact pins, strict TS (`strict`, `noUncheckedIndexedAccess`), Biome config, Vitest, and a Next page that renders "ok". `CI`: `pnpm/action-setup`, `pnpm install --frozen-lockfile`, `pnpm lint`, `pnpm test`.
- [ ] **Step 3: Verify** `pnpm install --frozen-lockfile && pnpm lint && pnpm test && pnpm build` all exit 0, and `pnpm dev` serves :3000. No `package-lock.json` exists.
- [ ] **Step 4: Commit** `chore: workspace scaffold, Biome, Vitest, CI`.

---

### Task 2: Schemas and op validation

**Files:**
- Create: `packages/core/src/schema.ts`, `ops.ts`, `schema.test.ts`, `ops.test.ts`

**Interfaces:**
- Produces (exact names later tasks use):
  - `type Id = string`; `newId(): Id` (nanoid).
  - `Style = {stroke: string; fill: string | null; strokeWidth: number; opacity: number; dash: 'solid'|'dashed'|'dotted'}`; `DEFAULT_STYLE`.
  - `Binding = {id: Id; fx: number; fy: number}` (point as a fraction of the target's unrotated box, 0..1).
  - `ShapeData = {kind: 'rect'|'ellipse'|'diamond'|'triangle'|'line'|'arrow'; radius?: number; label?: string; arrowheads?: {start: boolean; end: boolean}; points?: [number, number][]; start?: Binding; end?: Binding}` (`points` are for line/arrow, relative to `x,y`).
  - `TextData = {text: string; size: number; align: 'left'|'center'|'right'; dir: 'auto'|'ltr'|'rtl'; maxWidth?: number}`.
  - `Element = Base & ({type:'shape'; data: ShapeData} | {type:'text'; data: TextData})` with Base = `id, x, y, w, h, rotation, z, style, parentId?, locked, author {kind:'human'|'agent'; id}, v`. Schema exports `ElementSchema`.
  - `Op = {op:'add'; el: Element} | {op:'patch'; id: Id; set: Record<string, unknown>} | {op:'remove'; id: Id} | {op:'reorder'; id: Id; z: string}`; `Batch = {batchId: Id; label: string; ops: Op[]}`; `OpSchema`, `BatchSchema`.
  - `Camera = {x: number; y: number; zoom: number}`; `ZOOM_MIN = 0.05`, `ZOOM_MAX = 20`; `Viewport = {width: number; height: number; dpr: number}`.
  - `class OpError extends Error {field: string}`; `validateBatch(batch: unknown): Batch` throws `OpError` naming the field and allowed range (e.g. `style.opacity must be 0..1`).
- [ ] **Step 1: Write failing tests** with these assertions: a valid rect and a valid Arabic text element parse; `w: -1`, `rotation: NaN`, `style.opacity: 2`, `data.size: 0`, an unknown `type`, and a `patch` whose `set` key is not a dotted path of a known field each throw `OpError` with `field` equal to the offending path; a text element with `text` over 100,000 chars is rejected; `validateBatch` of an empty `ops` array is rejected; extra unknown fields are stripped, not kept.
- [ ] **Step 2: Run** `pnpm --filter @whiteboard/core test` and see them fail.
- [ ] **Step 3: Implement** the zod schemas in `schema.ts` and `validateBatch` in `ops.ts` (wrap `ZodError` into `OpError`; patch-path check walks the schema shape).
- [ ] **Step 4: Run** tests, expect PASS. **Step 5: Commit** `feat(core): element, op and batch schemas`.

---

### Task 3: Scene store, applyBatch and inverses

**Files:**
- Create: `packages/core/src/scene.ts`, `scene.test.ts`

**Interfaces:**
- Consumes: Task 2 types.
- Produces:
  - `type Scene = {els: Map<Id, Element>}`; `createScene(els?: Element[]): Scene`; `ordered(scene): Element[]` (ascending `z`, ties by id).
  - `applyBatch(scene: Scene, batch: Batch): {inverse: Batch; touched: Id[]}` mutates the scene atomically (all ops apply or none do) and bumps `v` on each changed element. `inverse.label` is `Undo ${batch.label}`.
  - `zBetween(a: string | null, b: string | null): string` (wrapper over `fractional-indexing`).
  - Conflict rules for a single user: a `patch` to a removed or unknown id is dropped (not an error, reported in `touched` as absent); `reorder` sets `z`; `add` of an existing id throws `OpError`.
- [ ] **Step 1: Write failing tests:** (a) fast-check-free property test: 200 seeded random batches over a random scene, `applyBatch` then `applyBatch(inverse)` returns a scene deep-equal to the original, including `v` restored; (b) a batch whose third op is invalid leaves the scene untouched (atomic); (c) `patch` with `{'style.fill': '#f00', 'data.kind': 'ellipse'}` changes only those paths; (d) `patch` of a removed id is dropped and does not throw; (e) `ordered` is stable after 1,000 `zBetween` inserts at the same position (no equal or unsorted `z`).
- [ ] **Step 2: Run** and see them fail. **Step 3: Implement** `applyBatch` by recording each touched element's previous value (full element for add/remove, previous values per dotted path for patch, previous `z` for reorder) and building the inverse from that record. **Step 4: Run** tests, PASS. **Step 5: Commit** `feat(core): scene store with atomic batches and inverses`.

---

### Task 4: UndoManager

**Files:**
- Create: `packages/core/src/undo.ts`, `undo.test.ts`

**Interfaces:**
- Consumes: `applyBatch`, `Batch`.
- Produces: `class UndoManager { constructor(scene: Scene, maxDepth = 200); record(applied: {inverse: Batch; touched: Id[]}, original: Batch): void; undo(): {batch: Batch; skipped: number} | null; redo(): {batch: Batch; skipped: number} | null; canUndo: boolean; canRedo: boolean; clear(): void }`. `undo()` returns the batch to submit (the caller runs it through `editor.commit`, which records it as a redo entry via `record`), so undo is a new append-only batch.
- Skip rule: an inverse op whose field changed since the original batch (compare the field's current value with the value the original batch wrote) is dropped from the returned batch and counted in `skipped`; inverse ops on removed elements are dropped and counted.
- [ ] **Step 1: Write failing tests:** undo/redo round trip over add, patch, remove, reorder; recording a new batch clears redo; field changed since → that op skipped, `skipped === 1`, others still applied; undo of a batch whose element was later removed → `skipped` counts it, no throw; depth cap drops the oldest; undo after `clear()` returns null; serialise/restore round trip `toJSON()/UndoManager.fromJSON(scene, json)` for Task 11.
- [ ] **Step 2: Run, see them fail. Step 3: Implement** (two stacks of `{original, inverse}`; add `toJSON/fromJSON`). **Step 4: PASS. Step 5: Commit** `feat(core): undo/redo with skip rule`.

---

### Task 5: Geometry, spatial index, hit-testing, arrow routing

**Files:**
- Create: `packages/core/src/geometry.ts`, `index.ts` (the R-tree), `geometry.test.ts`, `index.test.ts`; Modify: `main.ts` (re-export everything so far)

**Interfaces:**
- Produces:
  - `type Point = {x: number; y: number}`; `type Rect = {minX; minY; maxX; maxY}`.
  - `bounds(el: Element): Rect` (axis-aligned box of the rotated box; for arrows/lines, of the points plus half stroke width).
  - `toLocal(el: Element, p: Point): Point` (inverse-rotate about the centre, F13).
  - `hitTest(el: Element, p: Point, tolWorld: number): boolean` narrow phase per type: rect/diamond/triangle/ellipse by fill-or-stroke (unfilled shapes hit only near their outline unless `fill` is set), lines/arrows by distance to the polyline, text by its layout box.
  - `class SpatialIndex { constructor(); load(els: Element[]): void; upsert(el: Element): void; remove(id: Id): void; search(r: Rect): Element[]; pick(p: Point, zoom: number, scene: Scene): Element | null }` (rbush; `pick` pads the box by `6 / zoom` world units, runs `hitTest`, returns the topmost by `z`).
  - `resolveEnd(binding: Binding, target: Element): Point` and `routeArrow(arrow: Element, scene: Scene): [number, number][]` (recomputes endpoints from bindings; a missing target keeps the last stored point).
  - `resizeBox(el: Element, handle: Handle, to: Point, keepAspect: boolean): Patch` and `rotateTo(el, angle, snap15: boolean): Patch` for the select tool, with `type Handle = 'nw'|'n'|'ne'|'e'|'se'|'s'|'sw'|'w'` (handles act in the element's rotated frame).
- [ ] **Step 1: Write failing tests:** rotated 100×20 rect at 45°: `hitTest` true at its visual centre-right tip and false 7 px outside, at zoom 0.05, 1 and 20 (tolerance passed as `6 / zoom`); `bounds` of a 90°-rotated rect swaps w/h about the centre; index `search` equals a brute-force filter on 2,000 random elements for 100 random rects; `upsert` after a move removes the old entry; `pick` returns the higher `z` of two overlapping elements; `routeArrow` follows a moved, rotated and resized target; a removed target leaves the last endpoint; `resizeBox` on a rotated element keeps the opposite corner fixed in world space (assert to 1e-6); `rotateTo` with `snap15` returns multiples of π/12.
- [ ] **Step 2: Run, fail. Step 3: Implement.** Write the **group-resize semantics** decision (F13) into whiteboard-engine.md Open items in Task 13, not here. **Step 4: PASS. Step 5: Commit** `feat(core): geometry, R-tree and hit-testing`.

---

### Task 6: Renderer, camera, caches and the golden-image harness

**Files:**
- Create: `packages/core/src/platform.ts`, `render.ts`, `node.ts`, `render.test.ts`, `packages/core/test/matchesGolden.ts`, `packages/core/test/golden/` (generated)
- Modify: `packages/core/package.json` (`exports`: `.` and `./node`)

**Interfaces:**
- Produces:
  - `interface Platform { createCanvas(w: number, h: number): CanvasLike; measureText(font: string, text: string): number; registerFont(family: string, path: string): void }` (M2 adds `rasterizeSvg`); `FONT_STACK = '"Plex-Arabic", "Plex-Latin"'`.
  - `render(ctx: CanvasRenderingContext2D, scene: Scene, camera: Camera, viewport: Viewport, platform: Platform, opts?: {index?: SpatialIndex; cache?: RenderCache}): RenderStats` (`RenderStats = {drawn: number; culled: number}`); pure given its inputs; uses the camera matrix `setTransform(zoom*dpr, 0, 0, zoom*dpr, ...)`; culls with the index; draws shapes from cached `Path2D`; text through the bitmap cache (`RenderCache` keyed `(zoomBucket, id, v)`, `dispose()` closes bitmaps).
  - `screenToWorld(p, camera, viewport)`, `worldToScreen(p, camera, viewport)`, `zoomAt(camera, screenPoint, factor): Camera` (clamped to `ZOOM_MIN..ZOOM_MAX`).
  - `@whiteboard/core/node`: `nodePlatform(): Platform` and `registerBundledFonts(): void` (registers the Plex `arabic` and `latin` subset woff2 files as `Plex-Arabic` and `Plex-Latin`, asserts both are in `GlobalFonts.families`).
  - Test helper `matchesGolden(canvas, name, {maxMeanDiff = 2.5, maxBigDiffRatio = 0.02})`: writes the PNG on first run when `UPDATE_GOLDEN=1`, otherwise fails if mean absolute RGBA difference or the ratio of pixels differing by > 64/255 exceeds the tolerance (S1 measured 2.2 and 1.48% browser vs server).
- [ ] **Step 1: Write failing tests:** golden `shapes.png` (every shape kind, rotated, filled/unfilled, dashed, arrowheads, a bound arrow); culling: with 5,000 elements and a small viewport `stats.drawn` equals the brute-force visible count at zoom 0.05 and 20; `zoomAt` keeps the world point under the cursor fixed and clamps at both limits; `screenToWorld(worldToScreen(p)) ≈ p`; rendering twice from the same inputs gives identical pixels; `RenderCache.dispose()` leaves zero open bitmaps.
- [ ] **Step 2: Run, fail. Step 3: Implement** the renderer by porting the structure of `spikes/s1-canvas/web/render.ts` (cached strategy only; drop the `direct`/`worker` variants and freehand); generate goldens once with `UPDATE_GOLDEN=1` and eyeball them. **Step 4: PASS. Step 5: Commit** `feat(core): pure render(), camera math and golden harness`.

---

### Task 7: Text layout with Arabic and Latin

**Files:**
- Create: `packages/core/src/text.ts`, `text.test.ts`
- Modify: `render.ts` (text drawing uses `layoutText`)

**Interfaces:**
- Produces:
  - `resolveDir(text: string, dir: TextData['dir']): 'ltr'|'rtl'` (`auto` = first strong character; no strong character → `ltr`).
  - `layoutText(el: Element & {type: 'text'}, platform: Platform): {lines: {text: string; x: number; y: number; width: number; dir: 'ltr'|'rtl'}[]; width: number; height: number}`; wraps at `data.maxWidth` using `Intl.Segmenter` (word granularity, never splitting a grapheme cluster), `measureText` for widths, line height 1.4 × size, honours `align` (for RTL, `left`/`right` mean start/end flipped as in CSS `text-align: start`: store `align` as visual side and document it).
  - Drawing sets `ctx.direction` per line and `ctx.font = \`${size}px ${FONT_STACK}\``.
- [ ] **Step 1: Write failing tests** (node platform with bundled fonts): `resolveDir('مرحبا hello','auto') === 'rtl'`, `('hello مرحبا','auto') === 'ltr'`, `('123','auto') === 'ltr'`, `('','auto') === 'ltr'`; a 40-char Arabic paragraph at `maxWidth` 200 wraps into ≥ 2 lines, none wider than 200, and rejoined lines equal the original text; an emoji ZWJ family sequence and an Arabic letter with shadda+fatha are never split across lines; empty and whitespace-only text yields one line, `height > 0`; 10,000 characters lays out in < 200 ms; golden `text-mixed.png` (Latin line, Arabic line with harakat, mixed line, Arabic-Indic digits, wrapped paragraph, RTL right-aligned) at 24 px.
- [ ] **Step 2: Run, fail. Step 3: Implement.** **Step 4: PASS. Step 5: Commit** `feat(core): Arabic and Latin text layout`.

---

### Task 8: Editor shell, camera input and tool contract

**Files:**
- Create: `apps/web/src/editor/editor.ts`, `fonts.ts`, `tools/index.ts`, `tools/hand.ts`, `apps/web/src/app/page.tsx` (client), `editor.test.ts`
- Modify: `apps/web/package.json` (Vitest + jsdom for the non-canvas logic)

**Interfaces:**
- Consumes: core `render`, `Scene`, `UndoManager`, `SpatialIndex`, `Camera` helpers.
- Produces:
  - `loadFonts(): Promise<void>` awaits `document.fonts.load('16px "Plex-Arabic"', 'م')` and `('16px "Plex-Latin"', 'A')` after importing the fontsource CSS for weight 400.
  - `interface Tool { id: string; key: string; onPointerDown(e: ToolEvent): void; onPointerMove(e: ToolEvent): void; onPointerUp(e: ToolEvent): void; onKey?(e: KeyboardEvent): boolean; onCancel?(): void; drawOverlay?(ctx: CanvasRenderingContext2D): void }` with `ToolEvent = {world: Point; screen: Point; shift: boolean; alt: boolean; button: number; pointerType: string}`; registry `tools: Record<string, Tool>` in `tools/index.ts` (a new tool is one file plus one entry).
  - `class Editor { constructor(host: HTMLElement, opts?: {board?: Scene}); scene: Scene; camera: Camera; undo: UndoManager; selection: Set<Id>; tool: Tool; commit(batch: Batch): void; undoOnce(): void; redoOnce(): void; setTool(id: string): void; invalidate(): void; onChange(fn: () => void): () => void; dispose(): void }`. `commit` runs `validateBatch`, `applyBatch`, updates the index, records undo, marks dirty and emits change. Tools never mutate the scene directly.
  - Two canvases (scene, overlay) scaled by `devicePixelRatio`, resized by `ResizeObserver`; dirty-flag `requestAnimationFrame` loop that renders only when invalidated; wheel zooms at the cursor (ctrl/pinch) and pans otherwise; `Space`-drag and the Hand tool (`H`) pan; zoom clamped 0.05–20; `touch-action: none` on the host.
- [ ] **Step 1: Write failing tests** (jsdom, canvas mocked): `commit` of an invalid batch throws `OpError` and leaves the scene unchanged; `commit` then `undoOnce` then `redoOnce` restores the scene; `invalidate()` called 10 times in one tick schedules one frame; `setTool('nope')` throws; switching tools calls the old tool's `onCancel`.
- [ ] **Step 2: Run, fail. Step 3: Implement**; the page mounts the editor after `await loadFonts()` and shows the toolbar skeleton. **Step 4: PASS**; open `pnpm dev` and confirm pan, zoom and a resize keep the canvas sharp at DPR 2. **Step 5: Commit** `feat(web): editor shell, frame loop, camera and tool contract`.

---

### Task 9: Select/transform and shape tools with bound arrows

**Files:**
- Create: `apps/web/src/editor/tools/select.ts`, `shape.ts`, `select.test.ts`, `shape.test.ts`
- Modify: `tools/index.ts`, `editor.ts` (selection overlay: box, 8 handles, rotation handle)

**Interfaces:**
- Consumes: `SpatialIndex.pick`, `resizeBox`, `rotateTo`, `routeArrow`.
- Produces:
  - `select` (`V`): click, shift-click toggle, marquee (`SpatialIndex.search` then exact containment), move (alt = no snap), resize by handle (shift = keep aspect), rotate (shift = 15° steps), arrows nudge 1 px (shift 10 px), `Delete` removes, `Esc` clears. Every gesture ends in exactly one `editor.commit` batch labelled `Move`, `Resize`, `Rotate`, `Delete`. During the drag the overlay previews and the scene is untouched.
  - `shape` tools `R O D L A` (rect, ellipse, diamond, line, arrow; triangle is in the picker only) create one `add` batch per drag; click without drag creates a default 120×80 shape. Arrow/line ends snap to a shape under the pointer (within 6 screen px) and store a `Binding`; moving, resizing or rotating a bound shape commits one batch that also patches the arrows' `points`. Deleting a shape patches bound arrows to drop the binding but keep their last point.
  - Group-resize semantics are not built (no group type until M6).
- [ ] **Step 1: Write failing tests** driving the tool with synthetic `ToolEvent`s against a real `Editor` and a stub canvas: drag-create a rect yields one batch and `undoOnce` removes it; marquee selects exactly the fully-contained elements; resize of a rotated rect via the `se` handle keeps the `nw` corner fixed; one drag = one undo step; arrow dropped on two shapes stores two bindings; moving the target moves the arrow end in the same batch, and `undoOnce` restores both; deleting the target keeps the arrow with a free end and undo restores the binding; `Delete` on a locked element does nothing.
- [ ] **Step 2: Run, fail. Step 3: Implement. Step 4: PASS**, then draw a flowchart by hand in `pnpm dev`. **Step 5: Commit** `feat(web): select, transform and shape tools with bound arrows`.

---

### Task 10: Text tool with a textarea overlay and RTL

**Files:**
- Create: `apps/web/src/editor/tools/text.ts`, `text.test.ts`, `e2e/text.spec.ts`
- Modify: `tools/index.ts`

**Interfaces:**
- Consumes: `layoutText`, `resolveDir`, `FONT_STACK`.
- Produces: `text` tool (`T`): click creates an empty text element in edit mode (not yet committed) and double-clicking text with the select tool re-enters edit mode. A transparent `<textarea>` is positioned and scaled to the element (matching font stack, size, line height, `dir` from `resolveDir` and re-evaluated on input when `data.dir === 'auto'`), giving IME, selection, spellcheck and screen-reader support. Commit on blur or `Esc`: `add` (new) or `patch` of `data.text` (existing), one batch; empty text on commit discards the element without a batch. The element's `w,h` follow `layoutText`. `Ctrl+Enter` commits; `Enter` inserts a line break.
- [ ] **Step 1: Write failing tests:** (unit, jsdom) typing then blur commits one batch; empty commit creates nothing; editing existing text commits a `patch` and `undoOnce` restores the old text; textarea `dir` flips to `rtl` after typing an Arabic first letter in `auto`; a 10,000-character paste commits and the element has finite `w,h`. (Playwright, Chromium) `e2e/text.spec.ts`: type "مرحبا" then " hello" and assert the committed `text` equals the input in logical order; dispatch IME composition through CDP (`Input.imeSetComposition` then `insertText`) and assert the composition text is not committed until it ends and the final text is.
- [ ] **Step 2: Run, fail. Step 3: Implement. Step 4: PASS.** Record in the commit body that real IME input (Arabic and a CJK or Egyptian-Arabic keyboard) was also tried by hand on this Mac; the user does the final manual check in Task 13. **Step 5: Commit** `feat(web): text tool with textarea overlay and RTL`.

---

### Task 11: Local save in IndexedDB

**Files:**
- Create: `apps/web/src/editor/persist.ts`, `persist.test.ts`
- Modify: `editor.ts` (autosave hook), `page.tsx` (load on start, notices)

**Interfaces:**
- Produces:
  - `const SCHEMA_VERSION = 1`; stored record `{version: number; boardId: string; savedAt: number; elements: Element[]; camera: Camera; undo: unknown}` in one IndexedDB object store `boards`, key `boardId` (single board `"local"` in M1).
  - `loadBoard(boardId): Promise<{status: 'ok'; record} | {status: 'empty'} | {status: 'unreadable'; reason: 'corrupt'|'newer-version'|'unavailable'}>`; every element is re-validated with `ElementSchema`, invalid ones are dropped and counted in `dropped`.
  - `saveBoard(boardId, record): Promise<void>`: debounced 500 ms by the editor, flushed on `visibilitychange` hidden and `pagehide`; never writes when the last load was `unreadable` (the original record is kept; the page shows a banner with a "Start empty and keep a backup copy" action that copies the raw record under `boardId + ":backup:" + savedAt` first).
  - `acquireBoardLock(boardId): Promise<boolean>` via `navigator.locks.request(name, {ifAvailable: true}, …)` held for the page lifetime; false → the editor opens read-only with a banner "Open in another tab".
- [ ] **Step 1: Write failing tests** with `fake-indexeddb`: save → load round trip restores elements, camera and undo stack (undo still works after reload); a corrupt record → `unreadable/corrupt` and a following autosave does not overwrite it; `version: 2` record → `unreadable/newer-version`; one invalid element in a valid record is dropped and `dropped === 1`; IndexedDB missing (`indexedDB` undefined) → `unreadable/unavailable` and the editor still works in memory; second `acquireBoardLock` in the same lock scope returns false; quota error on save surfaces a visible notice and keeps the in-memory board.
- [ ] **Step 2: Run, fail. Step 3: Implement** with raw IndexedDB (about 40 lines, no dependency). **Step 4: PASS**; in `pnpm dev` draw, reload, and see everything back; open a second tab and see the read-only banner. **Step 5: Commit** `feat(web): IndexedDB autosave with locks and safe failure`.

---

### Task 12: Benchmark the real renderer against S1

**Files:**
- Create: `apps/web/src/bench/page.tsx`, `apps/web/src/bench/scene.ts` (seeded 5,000 and 20,000 element scenes ported from `spikes/s1-canvas/web/scene.ts`, restricted to M1 element types: shapes, lines/arrows, text 60% Latin / 40% Arabic), `docs`: results in `apps/web/src/bench/RESULT.md`

**Interfaces:**
- Produces: `/bench` page that runs the S1 method (1 s warm-up per zoom bucket; 5 s Lissajous pan; 5 s zoom 1 ± 0.4; 20 pointerdowns for first ink after 500 ms idle; 20k open time) against `Editor` + `render()`, printing `meanFps`, `p95FrameMs`, `firstInkP95Ms`, `open20kMs`, cache MB; the same environment block as S1's RESULT.md.
- Acceptance (decided here, user may override): first ink p95 ≤ 16 ms; open 20k < 2,000 ms; pan and zoom **not worse than S1's cached variant** (S1 cached dpr2: pan 46.5, zoom 40.7 fps; S1 missed 60 fps on this machine because of text, with the next rung WebGL not built).
- [ ] **Step 1: Port the scene generator and write the page.** **Step 2: Run** on this Mac with the S1 conditions (Chrome headed, AC power, tab focused) at DPR 2 and 1, five runs each.
- [ ] **Step 3: Record** numbers and the PASS/FAIL against the acceptance in `RESULT.md`. If worse than S1 cached by > 10%, profile and fix before continuing; if pan/zoom stay below 60 fps, write the decision (accept for M1, or schedule the worker-canvas/WebGL rung) as a one-line `needs-user-decision:` and surface it in Task 13.
- [ ] **Step 4: Commit** `bench: real renderer vs S1 numbers`.

---

### Task 13: End-to-end gate, docs and demo

**Files:**
- Create: `e2e/gate.spec.ts`
- Modify: `docs/ROADMAP.md` (M1 status, status log), `docs/plans/whiteboard-engine.md` (Open items: record group-resize semantics for M6 and the rotated hit-test rule), `docs/plans/testing-spikes.md` (Engine acceptance script note), `docs/PLAN.md` §19 if a decision was made

**Interfaces:**
- Produces: the M1 gate script as Playwright, deterministic, no network.
- [ ] **Step 1: Write the failing e2e** `e2e/gate.spec.ts`: draw two shapes and a bound arrow; type Arabic and Latin text; move a shape (arrow follows); undo twice and redo once; reload the page; assert the scene equals the pre-reload scene (element count, text content, binding ids) and undo still works; a second page in the same context shows the read-only banner; console has no errors.
- [ ] **Step 2: Run** `pnpm e2e` and see it fail; fix whatever it exposes. **Step 3: Run the full gate:** `pnpm install --frozen-lockfile && pnpm lint && pnpm test && pnpm e2e && pnpm build` all exit 0.
- [ ] **Step 4: Manual demo with the user:** draw a diagram with bound arrows, type Arabic and Latin text with a real Arabic keyboard (IME), undo, reload. Record the result.
- [ ] **Step 5: Update docs** (M1 ◐/✔ per what passed, numbers from Task 12, decisions), merge `m1-core` into `main` after the user's OK, **Step 6: Commit** `docs: M1 gate results and status`.

---

## Self-review

- **Spec coverage:** core schemas/ops/undo/bounds/R-tree (2–5), renderer + camera + two canvases + dirty-flag loop + zoom 0.05–20 (6, 8), select/transform (9), shapes + bound arrows (5, 9), text with RTL and textarea overlay (7, 10), local save (11), repo scaffold/Biome/Vitest/CI (1), F13 group-resize and rotated hit-testing (5, 13), core property test and golden images (3, 6, 7), Arabic/Latin IME test (10, 13), demo (13). Perf targets (12). Nothing is built for math, images, freehand, sync.
- **Type consistency:** `Batch`, `applyBatch → {inverse, touched}`, `UndoManager.record(applied, original)`, `SpatialIndex.pick(p, zoom, scene)`, `Platform`, `FONT_STACK`, `layoutText`, `resolveDir`, `Editor.commit` are defined once and used with the same names later.
- **Open for the user:** (1) Task 12's acceptance bar, because S1 missed 60 fps at DPR 2 on dense, text-heavy scenes; (2) Next.js stays for `apps/web` per tech-stack ([my call]); a Vite SPA would be lighter, and it only matters for M3's deploy.
