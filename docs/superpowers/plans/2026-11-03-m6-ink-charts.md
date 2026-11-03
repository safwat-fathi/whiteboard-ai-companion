# M6 Ink, charts, polish: task plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Tasks are checkbox-tracked by their commit.

## Context

M0–M5 are merged to `main` (HEAD `134e299`; M5 verified at `0bf2509`). M6 makes the board handwritable and chartable: **the student can handwrite; the AI can chart** (PLAN §17 gate). Scope is the **full M6 in ROADMAP** (owner's choice, 2026-11-03) although the hackathon ends 2026-11-04.

**Because of the deadline, tasks are ordered so every stage leaves the app shippable and mergeable on its own.** After each stage's gate, fast-forward `main` to the verified commit (`git update-ref refs/heads/main <sha> <old>`, then `git push origin main`) so whatever exists at the deadline is already on `main`. Stage 1 + 2 is the handwriting demo; stage 3 + 4 is the chart demo; stage 5 is polish and can be cut.

**Owner decisions already taken:** full scope; auto-picture rule = *force a picture when the selection holds handwriting, keep today's `structure + picture` default* (R10); chart labels = *Latin and digits only, documented* (R7). Defaults below stand unless overridden.

**Work happens in the worktree `../whiteboard-ai-m6` on branch `m6-ink-charts`, never in the owner's checkout** (it serves their `:3000` dev server). Install with `pnpm install --frozen-lockfile` (plain: `--offline` fails in a fresh worktree). Gates run in a second scratch worktree. `HANDOFF.md` is gitignored and stale; leave it.

## Facts the plan rests on (verified 2026-11-03)

- **Elements** are `shape | text | math | image` (`core/src/schema.ts:152`). `parentId` is in `BaseShape` and read by nothing. Switch points a new type must touch: `ElementSchema` union, `SCHEMA` (`scene.ts:29`), `checkPatch` leaf chain (`ops.ts:43`), `bounds`/`hitTest`/`lockedAspect`/`resizeBox` (`geometry.ts`), `build`/`render` (`render.ts:601`, `:693`), `detailOf` (`tools/describe.ts`, exhaustive, the compiler flags it), digest `TYPES` (`digest.ts:13`), `get_elements` enum and `EDITABLE` regex (`tools/board.ts:122`, `:390`), the select tool's handles (`web select.ts`).
- **Linear shapes** keep `data.points` relative to `x,y`, never rotated; `bounds`, `hitTest` and `render` special-case them (`isLinear`). Text/math/image are boxed and rotate about the box centre; `RenderCache` (`render.ts:66`) gives them zoom-bucketed bitmaps: the model for a chart.
- **`render()` is pure and shared** by the browser, `pictures.ts` and the server export (`@napi-rs/canvas`). No `globalCompositeOperation` is used anywhere yet.
- **Server limits.** `checkLimits` (`limits.ts`) range-checks `data.points` on `add` and on `patch`, and caps 500 ops per batch (R10 of M3): a freehand that keeps its points in `data.points` is covered for free.
- **Tools.** `ToolDef`, `defineTool`, `ToolError`, `stackAbove`, `baseFields`, `resolvePlacement`, `agentMayEdit`, `rerouteOps` exist; `coreTools = [...boardTools, addDiagram]`; server `WRITES` (`board-tools.ts:58`) names the write tools; stub fixtures live in `apps/server/test/fixtures/tutor/*.json`.
- **Editor.** `Tool` contract and the `tools` map (`editor/tools/index.ts`); `ToolEvent` has no pressure/coalesced/predicted; no palm rejection or barrel button; tool keys come from `shortcutKey(e)`, which ignores Shift (so Shift+P collides with P); `Toolbar.tsx` `TOOL_ITEMS` with groups `nav | shapes | create`; multi-selection can move, nudge and delete only; no snapping except arrow binding.
- **Design doc (rev 11, read 2026-11-03):** `draw_stroke` "Freehand stroke from a list of points"; `add_chart` "Chart from categories and series"; **`arrange` "Align, distribute, stack, group, ungroup"** (human: Align menu, Ctrl+G). The input schemas are ours.
- **`perfect-freehand` 1.2.3** is installed only in `spikes/s1-canvas` (`getStroke` 0.12 to 0.71 ms at 1,000 to 5,000 points); `core` does not depend on it. `rbush` is in core. No chart library, by design ("in-house layout").
- **Goldens:** `packages/core/test/{golden,matchesGolden.ts}` (`UPDATE_GOLDEN=1`, `TIGHT = {0.05, 0.0005}`); browser-vs-server parity is `e2e-server/m3-gate.spec.ts` (≤ 1.5% at threshold 24). Bench: `apps/web/src/bench` (`BenchKind` has no ink or chart scene).

## Rulings **[my call]**, override any

| # | Ruling | Why | Cost if wrong |
|---|---|---|---|
| R1 | **`freehand` is a boxed element**: `x,y,w,h` = tight box of its points, `data = {points: [x,y][] relative to (x,y), pressure?: number[], smoothing, highlighter}` (the width is `style.strokeWidth`). It rotates like text (about the box centre), resize scales `data.points`. Points are rounded to 0.1 world units and pressure to 2 decimals; ≤ 10,000 points; `pressure.length === points.length`. No binary packing (`ponytail:`). | Reuses the box machinery (R-tree, handles, culling) and `limits.ts`; S1 shows `getStroke` is cheap. | A packed format later needs a schema migration. |
| R2 | **Outline** with `perfect-freehand@1.2.3` (exact pin, in `core`): `getStroke(points, {size: style.strokeWidth, thinning: highlighter ? 0 : 0.5, smoothing, streamline: 0.5, simulatePressure: !pressure})`, closed `Path2D` cached per element per platform. **Highlighter** draws that path filled with `globalCompositeOperation = 'multiply'` inside `save/restore`. Pen default `#1e1e1e`, width 3; highlighter `#ffd400`, width 18, opacity 0.45. | The doc's rendering rule; one helper serves render and the live overlay. | Multiply may differ on `@napi-rs/canvas`: T2 measures it and falls back to plain alpha on both sides if it does. |
| R3 | **Input.** `ToolEvent` gains optional `pressure`, `samples` (coalesced) and `predicted` (overlay only). Palm rejection: a touch `pointerdown` is ignored by drawing tools for 600 ms after any `pen` event. Pen barrel button (`buttons & 32`) routes that gesture to the eraser. On pointer-up the samples are simplified with Ramer–Douglas–Peucker at 0.5 screen px (`0.5 / zoom`) and committed as one `add`. No live-ink broadcast (PLAN F10). | ENG "Rendering/Input" and S1. | None. |
| R4 | **Eraser removes whole elements** (`E`): hit-test along each coalesced segment with tolerance `8 / zoom`, skip locked, highlight candidates on the overlay, commit on pointer-up through `deleteBatch` (arrows attached to a removed shape stay, unattached). A drag is one batch = one undo step; more than 400 hits are split into batches of 400 (the server caps a batch at 500 ops). | Matches the delete behaviour; no partial-stroke erasing. | Stroke-splitting erase is a v1.1 feature. |
| R5 | **Keys.** Pen `P`, Highlighter `Shift+P`, Eraser `E`, Chart `C`. `Tool` gets optional `shift?: true`; the Editor's key lookup prefers a tool whose `shift` equals `e.shiftKey`, else one without the flag. | Keeps Shift+R etc. working unchanged. | A clash on a non-Latin layout shows in the key tests. |
| R6 | **`chart` is a boxed element** `data = {kind: 'bar'\|'line'\|'area'\|'pie'\|'donut'\|'scatter', title?, categories: string[], series: {name, values: number[], xs?: number[]}[], stacked?, xLabel?, yLabel?, palette?: string[]}`. Limits: ≤ 50 categories, ≤ 8 series, ≤ 200 values, label ≤ 40 chars, title ≤ 120. Refinements: non-scatter `values.length === categories.length`; scatter needs `xs` of equal length; pie/donut exactly one series. Resize keeps the aspect ratio. Updates are last-write-wins on whole leaves (`data.categories`, `data.series`: PLAN F9). | ENG element table; array-index patch paths are fragile. | None. |
| R7 | **Chart labels are Latin and digits only** (Basic Latin to Latin Extended-B, general punctuation, currency, letterlike, arrows, math operators); any other script is a validation error: "chart labels support Latin letters and digits only". Documented in math-renderer's F14 spirit. | One font, one layout, identical in browser and server; Arabic text and math stay on the board around the chart. | Arabic charts become a later task. |
| R8 | **Chart rendering** = pure `layoutChart(data, w, h): ChartLayout` (list of `rect \| line \| path \| text` primitives, nice ticks, legend, title) in `core/src/chart.ts`, painted to a `RenderCache` bitmap keyed `(id, v, bucket)` like math. Default palette Okabe–Ito (8). | Same code in both canvases; cached like math. | Dense charts at DPR 2 stress the cache cap (M1's open call): `chart200` bench records it. |
| R9 | **`arrange` = align, distribute, stack, group, ungroup** (design doc). Pure batch builders in `core/src/arrange.ts` (`alignBatch`, `distributeBatch`, `stackBatch`) are shared by the tool and the Arrange menu; group/ungroup come from R11's `group.ts`. Every element goes through `agentMayEdit`. | One implementation, human and AI. | None. |
| R10 | **Auto-picture rule.** If the *selection* holds handwriting (directly or inside a group) and the chip is `structure`, the picture is forced and the chip reads `Selection (3) · structure + picture (auto)`; the default `both` and text-only selections behave as in M5. **A viewport that contains ink does not attach a picture by itself**: the Viewport chip stays an explicit opt-in (cost and surprise on a handwritten board); board-context.md is corrected in T18. | Owner's choice; resolves the docs/code contradiction. | One line to change if the viewport should auto-attach. |
| R11 | **`group` is an element** `data = {name?}` that draws nothing and is never hit; children carry `parentId`. `core/src/group.ts`: `groupMembers(scene, id)`, `topGroup(scene, el)`, `groupBatch(scene, ids, name?)`, `ungroupBatch(scene, id)`. Selecting a child selects its top group; move, delete and resize expand to members. **Group rotation is not built** (lines and arrows cannot turn their points; `ponytail:`), nor `reorder` of a group. | Smallest design that satisfies "moves, selects and resizes its children together". | Rotation is a follow-up. |
| R12 | **Group resize** = scale about the opposite handle in one batch: shapes scale `x,y,w,h`; lines scale `x,y` and `data.points`; freehand scales `x,y,w,h` and `data.points`; text scales `x,y`, `maxWidth` by `sx` and `size` by `min(sx,sy)`; math scales `size` by `min(sx,sy)`; image and chart scale uniformly by `min(sx,sy)`; bound arrows re-route; a locked member refuses the whole gesture. Rotated members scale about their centre (approximation, noted). | ENG "Open items" list. | None. |
| R13 | **Snap** (move gesture only): `snapBox(box, others, zoom)` aligns edges and centres within `6 / zoom` world units, nearest per axis; guides on the overlay; **Alt bypasses**. Spacing snap and resize snap are not built (`ponytail:`). | ENG: "within 6 screen px via the R-tree". | None. |
| R14 | **`add_chart`**: `{kind, title?, categories?, series, stacked?, xLabel?, yLabel?, w?, h?, placement?}`, default 480×320, `ToolError` names the failing field (schema message verbatim). **`draw_stroke`**: `{points: [x,y][] (2 to 500, any local frame), color?, width? (1 to 40), highlighter?, placement?}`; the tool normalises to the box and places it. Both are in `WRITES`, count 1 element each against `ELEMENT_BUDGET`. The charter says: data only from the student or the book, never invented; strokes are rare. | Design doc lines; placement reuse. | None. |
| R15 | **Compatibility.** An older client opening a board with new element types drops them with a notice and a backup (`persist.ts:161`, existing behaviour); single user, same build: no migration (`ponytail:`). | Not worth code today. | A shared deployment later needs a version gate. |

## Global constraints

pnpm only, exact version pins, `pnpm install --frozen-lockfile` clean; Biome (single quotes, no semicolons); strict TS; Vitest beside sources; **one commit per task**, stage files explicitly, end commits with the session trailer; no time estimates in docs; errors use the api.md envelope; logs never carry keys or board text. New element fields are validated by zod in `core`, never trusted from the model. **Re-run `git status` and `pnpm lint` before editing** (an IDE reformats files with Prettier defaults). Never touch the owner's `:3000`/`:4000`; stop your own servers by port. Next 16.4: read `node_modules/next/dist/docs/` before any route code (this plan adds none). Stage gate = `pnpm lint && pnpm typecheck && pnpm test` (the core `text.test.ts` and server `contention.test.ts` timing tests are known load-sensitive: re-run alone, report) plus the stage's e2e in a scratch worktree.

## Review focus (each pinned by a test in the task named)

1. A stroke of one point (a tap), of 10,000 points, with NaN or mismatched pressure: dot, accepted at the cap, rejected with the field named → T1, T3.
2. Eraser: a locked element is never erased, an arrow whose target is erased stays unattached, 450 hits become two batches, one undo restores a drag → T4.
3. Chart data: one category, all-zero or negative values, 1e12, empty series, an Arabic label, a label over 40 chars, pie with two series → T7, T8.
4. The AI arranging or ungrouping what the student did not select, or a group with a locked member → T12, T17.
5. Pointer input: touch while a pen is in range, `pointercancel` and Escape mid-stroke, a read-only second tab, pen barrel eraser → T3, T4.
6. Highlighter multiply and chart text identical in the browser and the server picture (≤ 1.5%) → T2, T8, T13.
7. Handwriting in a selection forces exactly one picture; a text-only selection does not → T6.

## File map

```
packages/core/src/
  schema.ts            + FreehandData/Element, ChartData/Element, GroupData/Element in the union
  scene.ts ops.ts      SCHEMA map and checkPatch leaf chain
  geometry.ts          bounds / hitTest / resizeBox / lockedAspect for the new types
  ink.ts               strokeOutline(points, pressure, opts, platform): Path2D; rdp(points, eps); quantise
  chart.ts             layoutChart, niceTicks, CHART_PALETTE, label policy
  arrange.ts group.ts  alignBatch distributeBatch stackBatch; groupMembers topGroup groupBatch ungroupBatch
  render.ts            freehand + chart branches, group skipped
  digest.ts tools/describe.ts tools/board.ts   TYPES, detailOf, get_elements, EDITABLE
  tools/{chart,stroke,arrange}.ts              add_chart, draw_stroke, arrange
apps/server/src/
  tutor/tools/board-tools.ts (WRITES) · tutor/prompts.ts (charter) · limits.ts (tests only)
  test/fixtures/tutor/m6.json                  stub script for the three tools
apps/web/
  src/editor/{editor,keys}.ts, tools/{index,ink,eraser,chart,select,transform}.ts, snap.ts
  src/ui/icons.tsx · app/Toolbar.tsx           Pen, Highlighter, Eraser, Chart icons and items
  src/tutor/{chips,board-context,SelectionToolbar}.ts(x) · src/workspace/ChartGrid.tsx
  src/bench/{scene,run}.ts                     ink and chart200 scenes
e2e/m6-ink.spec.ts · e2e-server/{m6-gate,m5-context}.spec.ts
```

## Tasks

### Stage 1: ink (handwriting demo, part 1)

**T1 `freehand` element.** `schema.ts`: `FreehandDataSchema` (R1) and `FreehandElementSchema` in the union; `SCHEMA`, `checkPatch`; `geometry.ts`: `bounds` (rotated box plus `strokeWidth/2`), `hitTest` (polyline distance in the local frame ≤ `tol + width/2`), `resizeBox` returns a patch that scales `data.points` and `x,y,w,h`; `detailOf` → `stroke, N pts` (plus `highlighter`); `get_elements` enum, `EDITABLE` (`style.*`, `x`, `y`), digest `TYPES`. *Tests:* schema rejects NaN, mismatched pressure, > 10,000 points; `bounds` of a rotated stroke; `hitTest` hits within tolerance and misses 20 px off; resize scales points and `apply` then inverse is identity (undo.test pattern); `describeElement` line; `checkLimits` rejects out-of-range freehand points on `add` and on a `data.points` patch (review 1).

**T2 Render.** Add `perfect-freehand@1.2.3` to `packages/core` (exact); `ink.ts` `strokeOutline` (R2) cached in a per-platform `WeakMap` like `pathOf`; `render.ts` freehand branch (boxed, rotation about the centre, `multiply` for highlighter) and cull through `bounds`. *Tests:* goldens `ink.png` (pressure pen, simulated-pressure pen, highlighter over text and a filled shape) at zoom 1 and 2 with `UPDATE_GOLDEN=1` first, `TIGHT` tolerance; a pixel sample proves multiply darkens the overlap; the outline is built once across two renders (spy); the `@napi-rs/canvas` multiply check (R2): if the Node result differs from the browser's by more than the tolerance, switch both sides to plain alpha and record why (review 6).

**T3 Pen and highlighter.** `ToolEvent` extension, Editor fills `pressure`, `samples` (`getCoalescedEvents?.()`), `predicted` (`getPredictedEvents?.()`), palm rejection (`lastPenAt`), `shift` lookup (R3, R5); `tools/ink.ts` `inkTool(highlighter: boolean)`; overlay previews the live outline with `strokeOutline`; commit on pointer-up (RDP, quantise, one `add` labelled `Draw` / `Highlight`, tool stays active); tap = dot (two identical points); `Escape` and `pointercancel` drop the gesture; Toolbar group `ink` with `PenIcon`, `HighlighterIcon`. *Tests (jsdom):* one pointer sequence = exactly one `add` batch with relative points and `Draw` label; RDP removes collinear points and keeps corners; a tap makes a dot; touch is ignored within 600 ms of a pen event and accepted after; coalesced samples are used; `p` and `Shift+P` pick the right tool and `Shift+R` still picks the rectangle; Escape and `pointercancel` leave no batch; a read-only editor ignores the tool (review 1, 5).

**T4 Eraser.** `tools/eraser.ts` (R4), barrel-button routing in `Editor.onPointer`, `EraserIcon`. *Tests:* a drag across 3 of 5 elements erases exactly those in one batch and one undo restores all; a locked element survives; an arrow attached to an erased shape stays, unattached; 450 hits produce two batches; a pen `pointerdown` with `buttons: 32` erases while the pen tool is active; read-only is a no-op (review 2, 5).

**T5 Ink bench, e2e and parity.** `BenchKind` gains `ink` (500 strokes of 100 points plus 1,000 shapes) and a real first-ink measure (Playwright mouse down to the first overlay frame) in `bench/run.ts`; `pnpm bench` numbers go to `RESULT.md` whatever they are. `e2e/m6-ink.spec.ts`: draw with real mouse input, undo, redo, reload persists, highlight over text, erase it, reload, second tab read-only, no console errors. `e2e-server` parity: a stroke and a highlight in the browser vs `export.png` ≤ 1.5% (extend the M3 gate's drawing step). **Stage 1 gate; merge to `main`.**

### Stage 2: handwriting reaches the tutor (demo, part 2)

**T6 Handwriting context (R10).** `BoardBridge.selectionHasInk(): boolean` (any selected element is `freehand`, or a group holding one: T14 adds the group case); `chips.ts` `attachOf(c, selected, ink)` forces `'both'` when `ink` and `c.selection === 'structure'`; `selectionChip(c, selected, ink)` appends ` (auto)` when forced; `prepareContext` passes `ink`; the selection detail lists `stroke, N pts` without coordinates (BC). *Tests:* `chips.test`: ink forces the picture on `structure`, a text-only selection stays `structure`, default `both` is unchanged, chip text; `prepareContext` with a stub bridge uploads exactly one picture; digest counts `freehand`. Extend `e2e-server/m5-context.spec.ts` with the handwriting step: draw three strokes with the mouse, select them plus a shape, switch the chip to structure, the chip reads `… structure + picture (auto)`, *What the AI sees* lists the ids and one thumbnail, the recorded request holds the digest ids and exactly one image, "make these red" changes only the selection, an unselected human element is refused (review 7). **Stage 2 gate; merge to `main`.**

### Stage 3: charts (demo, part 3)

**T7 `chart` element.** `schema.ts` `ChartDataSchema` and `ChartElementSchema` (R6, R7) with the refinements and the label regex; `SCHEMA`, `checkPatch` (patchable: `data.kind`, `title`, `categories`, `series`, `stacked`, `xLabel`, `yLabel`, `palette`); `lockedAspect` for charts; `bounds`/`hitTest` as a box; `detailOf` → `bar chart "Title"`; digest `TYPES`; `get_elements` enum. *Tests:* all six kinds parse; reject series length ≠ categories, pie with two series, scatter without `xs`, 51 categories, 9 series, a label of 41 chars, an Arabic label with the R7 message, NaN; patching `data.series` replaces the whole array and is validated; resize keeps the aspect (review 3).

**T8 Chart renderer.** `chart.ts`: `niceTicks(min, max, count)`, `layoutChart(data, w, h)` for the six kinds (axes, gridlines, legend, title, labels truncated with an ellipsis), `CHART_PALETTE` (Okabe–Ito); `render.ts` `drawChart` through `RenderCache` like `drawMath`; text uses the platform's loaded sans font. *Tests:* ticks for `[0, 97]` are `0,20,…,100`; bar heights are proportional, stacked bars sum, negative values hang below the baseline, all-zero data draws axes without NaN, 1e12 gets compact tick labels; pie angles sum to 2π, donut has a hole; scatter uses `xs`; one category and empty series draw; goldens `chart-bar`, `chart-line-area`, `chart-pie-donut`, `chart-scatter` at zoom 1 and 2; bench `chart200` holds ≥ 90% of `text200` fps (the M2 math rule) and records the `RenderCache` pressure (review 3, 6).

**T9 Chart tool and data grid.** `tools/chart.ts` (`C`): a click adds a default 480×320 bar chart (`A B C`, one series `3 5 2`) centred at the click, selects it and opens the grid; double-click on a chart with the select tool opens the grid; `ChartGrid.tsx` (native `<dialog>`, a table of inputs: kind, title, category rows, series columns with add/remove within the limits) applies one batch `Edit chart` that replaces whole `data.*` leaves; Toolbar `ChartIcon`. *Tests (jsdom):* the tool commits one `add` and selects; editing a cell yields a batch with the whole `data.series`; a non-number blocks Apply with a message; adding a category extends every series; an Arabic label shows the schema message; undo restores the previous data. **Stage 3 gate** (charts and goldens only, no tutor yet; merge to `main` after T13 if time is short).

### Stage 4: the tutor draws and charts (gate)

**T10 `add_chart`** (R14) in `tools/chart.ts`, registered in `coreTools`, added to `WRITES`, charter line in `prompts.ts`. *Tests:* a valid call yields a batch that passes `validateBatch` with the default size and an overlap-free `auto` placement; each invalid input is a `ToolError` naming the field (series mismatch, Arabic label, 9 series); counts 1 against `ELEMENT_BUDGET`; the digest shows `bar chart "Title"`.

**T11 `draw_stroke`** in `tools/stroke.ts`. *Tests:* points are normalised to the box and stored relative; 1 point and 501 points are `ToolError`s; `highlighter` sets the highlighter style; `auto` placement; the server snapshot (`renderBoardPng`) of a board with the stroke has non-white pixels there.

**T12 `arrange`** (R9): `core/src/arrange.ts` builders and the tool with `action: 'align' \| 'distribute' \| 'stack'` (`group`/`ungroup` arrive in T17): `{action:'align', ids, to:'left'\|'centre'\|'right'\|'top'\|'middle'\|'bottom'}`, `{action:'distribute', ids (≥ 3), axis:'horizontal'\|'vertical'}`, `{action:'stack', ids, direction:'row'\|'column', gap? (default 24), align?:'start'\|'centre'\|'end'}`. Patches only `x`/`y`; bound arrows re-route through `rerouteOps`; one batch. *Tests (exact numbers):* align left sets every `x` to the minimum; distribute makes three equal gaps; stack column at gap 24 orders by `y`; arrows stay attached (reroute ops present); a student element that was not selected is rejected and a locked one too (review 4); fewer than two ids is a `ToolError`.

**T13 Stub script and the M6 gate.** `fixtures/tutor/m6.json` (a `draw_stroke`, an `add_chart`, an `arrange`); the registry count tests become 18 (the existing "tool list includes …" test); `e2e-server/m6-gate.spec.ts`, the gate: handwrite with real pointer input, select it, **Ask AI** (the request carries one image), ask for a chart (the stub calls `add_chart` with data), a chart appears, the server export PNG of a board with ink and a chart matches the browser ≤ 1.5%, *Undo this response* removes the chart, no console errors. Add it to `pnpm e2e:server`. **Stage 4 gate (the M6 gate); merge to `main`.**

### Stage 5: group, snap, arrange menu (cut here if time is short)

**T14 `group` element and helpers** (R11): `schema.ts` `GroupElementSchema`, `core/src/group.ts`, `render.ts` skips groups, `hitTest` never hits one, `moveBatch` and `deleteBatch` expand to members, the select tool selects the top group of a picked child, a marquee selects each group once, `selectionHasInk` sees through groups. *Tests:* group then ungroup is identity; nested groups; moving a group moves members and box in one batch; deleting a group deletes members; selecting a child selects the group; a locked member blocks grouping; `parentId` unset on ungroup.

**T15 Multi-select and group resize** (R12): `select.ts` shows handles for the selection box (several elements or a group), `transform.ts` `resizeGroupBatch(scene, members, handle, box)`. *Tests:* each type scales as R12 states on fixtures; `apply` then inverse is identity over seeded random scenes; arrows re-route; a locked member refuses; a minimum size of 1; one undo step.

**T16 Snap** (R13): `snap.ts` `snapBox(box, others, zoom): {dx, dy, guides}`; the select tool's move gesture uses it with the dragged ids excluded; guides on the overlay; Alt bypasses. *Tests:* a left edge snaps to another's right edge at 5.9 px and not at 6.1 px; centres align; the nearest candidate wins; the threshold is `6 / zoom` at zoom 2; guides are returned; Alt returns no snap.

**T17 Group UI and `arrange` group/ungroup**: `Ctrl+G` and `Ctrl+Shift+G` in the select tool; an **Arrange** menu in `SelectionToolbar` (align, distribute, group, ungroup) calling the T12/T14 builders; the tool gains `group` and `ungroup` variants. *Tests:* shortcuts and menu buttons yield the same batches as the builders; the tool's group is authored by the agent; ungrouping a student's group the student did not select is rejected, and so is one with a locked member (review 4). **Stage 5 gate; merge to `main`.**

### Stage 6: close

**T18 Docs.** `whiteboard-engine.md` (freehand/chart/group as built, "16 tools" → 18, group rotation and resize snap not built), `ai-integration.md` (the three tools' schemas), `board-context.md` (the auto-picture rule as decided: selection only; chip wording; viewport opt-in), `chat-ui.md` (chip wording), `testing-spikes.md` (M6 results, bench numbers), PLAN §19 from #54 (R1 to R15) and the duplicate #43 number, ROADMAP M6 status and log row, README, the "worker-canvas path ready" claim corrected.

**T19 Verification.** In a scratch worktree at the final commit: `pnpm install --frozen-lockfile && pnpm lint && pnpm typecheck && pnpm test && pnpm build && pnpm e2e:server && pnpm e2e` (own config on `next dev -p 3301`, deleted after); grep the build for key names; `pnpm bench` ink and chart200 numbers recorded. **Owner-run:** the live Meta run (ask for a chart on a real book) and the manual demo (handwrite, select, **Ask AI**, chart).

## Verification

- Per task: the package's tests, `pnpm typecheck`, `pnpm lint`. End of each stage: `pnpm lint && pnpm typecheck && pnpm test`, then that stage's e2e in a scratch worktree, then fast-forward `main`.
- Gate (PLAN §17): **student can handwrite; AI can chart**: T13's spec plus T6's handwriting step in the Board context script, golden images for strokes and charts, first ink within one frame measured in T5.

## Not built (noted, add when needed)

Group rotation and group `reorder`; spacing snap and resize snap; partial-stroke (splitting) eraser; Arabic or RTL chart labels; binary-packed stroke points; live-ink broadcast; per-cluster picture crops; right-click Ask AI; the worker-canvas path.
