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

## API (`packages/core/math`)

```ts
renderMath(latex: string, opts: { display: boolean; color: string }):
  { svg: string; width: number; height: number; depth: number }   // metrics in em, baseline depth
| { error: string }                                               // MathJax message
```

- Pure and memoised by `hash(latex, display, color)`. Uses MathJax's `liteAdaptor` everywhere (no real DOM), so browser and server output is identical.
- MathJax loads lazily in the browser (dynamic import) so editor first paint is not blocked.

## Board element pipeline

1. `renderMath` → SVG + metrics. Element `w`/`h` derive from the metrics × `size`; aspect ratio is locked (math never stretches).
2. Rasterise the SVG into an `ImageBitmap` for the current **zoom bucket** (power-of-two steps) and cache by `(hash, bucket)`; cap the cache (LRU, ~64 MB).
3. Draw with baseline alignment. Rotation and flip use the normal element transform.

## Errors that teach

- The element renders the source in red with the message as a tooltip.
- `add_math` returns the MathJax message in the tool result, so the tutor fixes the LaTeX and retries.
- In chat, a failed `$…$` shows the source in red inline; the message still reads.

## Security configuration

Allowlist the TeX packages explicitly; do not rely on defaults:

- **Load:** `base`, `ams`, `boldsymbol`, `cancel`, `mathtools`, `mhchem` (chemistry equations are common in student books), `noundefined`.
- **Do not load:** `html` (`\href`, `\class`, `\style`, `\cssId`), `require`/the dynamic loader (`\require`), `unicode`, `newcommand` (no user macros), anything that fetches resources.
- Set `maxMacros` and `maxBuffer` to their low defaults; limit input to 4,000 characters (as the doc's limits table).
- **Test (M2):** each of `\href{javascript:alert(1)}{x}`, `\url{…}`, `\require{html}`, `\class{a}{x}`, `\style{…}{x}`, `\unicode{…}` produces the error rendering, never a link or a load.

## Arabic and RTL

- LaTeX stays left-to-right. In RTL text blocks, equations are separate `math` elements or inline `$…$` in chat (isolated with `<bdi>`).
- Text-mode content outside MathJax's font data (e.g. Arabic inside `\text{}`) may be emitted as SVG `<text>`, which depends on installed fonts and shaping again (finding F14). Rules: keep Arabic labels in separate `text` elements; register the bundled fonts on the server canvas; test in **S1** and M2. If it fails, restrict `\text{}` to Latin and document it.

## Accessibility

Each math element stores its LaTeX as `alt`; the accessibility outline panel (M7) lists it. Chat math carries `aria-label` with the LaTeX source. MathJax's assistive MathML/speech output is a v1.1 option.

## Tests

- **Golden images:** ~20 equations (fractions, roots, matrices, `aligned`, sums/integrals, `\mathbb`, `\ce{…}` chemistry, a `\text{}` with Arabic) rendered by the browser path and the server path; pixel-diff within tolerance.
- **Security tests** above; **error tests** (unbalanced braces, unknown macro under `noundefined`).
- **Perf:** 200 math elements on screen stay within the 60 fps target after the first render (cache hits).
