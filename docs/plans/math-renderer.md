# Math renderer

> Part of [PLAN.md](../PLAN.md) §7 · Related: [whiteboard-engine](./whiteboard-engine.md) · [chat-ui](./chat-ui.md) · [library-ingestion](./library-ingestion.md) · [auth-security](./auth-security.md)

**Decision (answer 2):** LaTeX is the interchange format for equations. **MathJax v4** (`@mathjax/src`), TeX input, **SVG output**. No TeX engine is written.

## Why this combination

- The canvas cannot draw HTML/CSS, which is what KaTeX emits, without `foreignObject` workarounds. MathJax SVG gives glyph paths, so the result is the same in the browser and on the server.
- LLMs emit LaTeX natively; a book converted to Markdown keeps equations as `$…$` / `$$…$$`, so the tutor can quote an equation from the book verbatim.
- One math engine for every surface, so the chat, the board and the server snapshot never disagree.

## Where math appears

| Surface | How |
|---|---|
| Board `math` element | LaTeX → SVG → raster bitmap (cached) → drawn on the canvas |
| Chat messages and source panel | `remark-math` parses `$…$`; the renderer component calls the same `renderMath()` and inlines the SVG |
| Server snapshots (`get_snapshot`, fallback paths) | Same module under Node, SVG rasterised by `@napi-rs/canvas` |
| Math tool preview | Live preview box (debounced ~150 ms) using `renderMath()` |

## API (`packages/math`, decided in the M2 grill; was `packages/core/math`)

```ts
renderMath(latex: string, opts: { display: boolean; color: string }): Promise<
  { ok: true; svg: string; width: number; height: number; depth: number }   // metrics in em, baseline depth
| { ok: false; error: string }>                                              // MathJax message; never rejects
peekMath(latex, opts): MathResult | undefined                                // sync, cache only
```

- Async, because MathJax loads font ranges dynamically (S1 used `convertPromise`). The frame loop only calls `peekMath`; on a miss it draws a placeholder and asks for the render, which invalidates the frame when done. The Node adapter awaits it before rasterising a snapshot.
- Memoised by `hash(latex, display, color)`; concurrent identical calls share one promise. Uses MathJax's `liteAdaptor` everywhere (no real DOM), so browser and server output is identical.
- MathJax loads lazily in the browser (dynamic import) so editor first paint is not blocked.
- `packages/core` never imports MathJax: `render()` reaches math through a `Platform.math` provider, and the 4,000-character limit and Arabic guard live here, not in the element schema.

## Board element pipeline

1. `renderMath` → SVG + metrics. Element `w`/`h` are **stored** (as for every element), computed by the creator from the metrics × `size`; the renderer fits the equation into `w`×`h` preserving the aspect, so math never stretches and a stale box never distorts it.
2. Rasterise the SVG into an `ImageBitmap` for the current **zoom bucket** (power-of-two steps) and cache by `(bucket, element id, v)`. The cache is the editor's single `RenderCache`, sized from the device (128 to 512 MB), shared with text and images.
3. Bitmaps are capped at 4096 px a side. When the on-screen size would exceed that (large equations at high zoom), the renderer draws the SVG glyph paths directly as `Path2D` (a small SVG-subset parser in `packages/math`); if the SVG holds anything the parser does not know, it falls back to the capped bitmap, upscaled.
4. Draw with baseline alignment. Rotation and flip use the normal element transform.

## Errors that teach

- The element renders the source in red monospace with the message as a tooltip. The editor lets an invalid commit through so the student keeps what they typed; `add_math` (M5) refuses invalid LaTeX and returns the message.
- `add_math` returns the MathJax message in the tool result, so the tutor fixes the LaTeX and retries.
- In chat, a failed `$…$` shows the source in red inline; the message still reads.

## Security configuration

Allowlist the TeX packages explicitly; do not rely on defaults:

- **Load:** `base`, `ams`, `boldsymbol`, `cancel`, `mathtools`, `mhchem` (chemistry equations are common in student books). The mhchem font extension is registered on the SVG jax (S1: without it the `\ce` arrows are missing-glyph boxes).
- **Do not load:** `html` (`\href`, `\class`, `\style`, `\cssId`), `require`/the dynamic loader (`\require`), `unicode`, `newcommand` (no user macros), anything that fetches resources, and **`noundefined`** (M2 decision: S1 found that with it the hostile payloads render as red text and do not throw; without it an undefined control sequence throws, `renderMath` returns `{ok: false, error: "Undefined control sequence \href"}`, and the tutor gets a message it can act on).
- Set `maxMacros` (1000) and `maxBuffer` (5120); limit input to 4,000 characters (as the doc's limits table).
- **Test (M2):** each of `\href{javascript:alert(1)}{x}`, `\url{…}`, `\require{html}`, `\class{a}{x}`, `\style{…}{x}`, `\unicode{…}`, plus `\def`, `\newcommand`, `\let`, `\input`, `\write` returns an error result, never a link, a request or a module load; a macro bomb and deep nesting return within 1 s.

## Arabic and RTL

- LaTeX stays left-to-right. In RTL text blocks, equations are separate `math` elements or inline `$…$` in chat (isolated with `<bdi>`).
- **F14 closed (S1 measured, M2 enforces): `latin-only`.** MathJax emits Arabic inside `\text{}` as SVG `<text>` per word, placed left to right in logical order with widths reserved at 0.6 em per character. Skia draws unjoined letters; Chrome joins each word but keeps the wrong word order and spacing. So `renderMath` returns an error for **any** Arabic letter in the input (U+0600–06FF, 0750–077F, 08A0–08FF, FB50–FDFF, FE70–FEFF; Arabic-Indic digits included, use 0–9): `Arabic inside math isn't supported; put the label in a separate text element`. Arabic labels go in separate `text` elements, which `fillText` shapes correctly.

## Accessibility

Each math element stores its LaTeX as `alt`; the accessibility outline panel (M7) lists it. Chat math carries `aria-label` with the LaTeX source. MathJax's assistive MathML/speech output is a v1.1 option.

## Tests

- **Golden images:** 20 equations (fractions, roots, matrices, `aligned`, sums/integrals, `\mathbb`, `\ce{…}` chemistry, Latin `\text{}`; S1's fixtures minus the two Arabic cases, which became error tests). The committed goldens are the Node output; Playwright renders the same fixtures in the real page and pixel-diffs them (≤ 1.5% differing pixels).
- **Security tests** above; **error tests** (unbalanced braces, unknown macro, Arabic input, over-length input).
- **Perf (M2 bar, relative):** with 200 math elements on screen after the first render, pan/zoom medians are ≥ 90% of the same scene with 200 text elements, and a 200-math view holds 60 fps at DPR 1. (M1 measured no variant at 60 fps on dense scenes, so an absolute 60 fps would be gating on text, not math.)
