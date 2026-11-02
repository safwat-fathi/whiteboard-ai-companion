# S2 ingestion: result (partial, run 2026-11-02)

Scripts: `r1.ts` (pdfjs, free), `ocr.ts` (R2/R3/R4 via OpenRouter), `slice.ts` (page copier). Outputs live in `out/` (gitignored, copyrighted text).
Sample: 10 evenly spaced pages per book from 12%..90% of the book. **Spend: $0.42** of the $1.00 ceiling (R3 ≈ $0.02 per 10 pages, R4 ≈ $0.07-0.09 per 10 pages). R4 model: `google/gemini-3.8-flash`; R2/R3 carrier model: `anthropic/claude-haiku-5.5`.

## Books

| Book | Pages | Type | R1 text layer |
|---|---|---|---|
| Algebra 1 Vol 1 (workbook) | 700 | text, 43 MB | yes, 5.5 ms/page |
| Algebra II (curriculum framework, not a textbook) | 45 | text | yes |
| CK-12 Algebra 1 | 652 | text, outline + roman/arabic page labels | yes, 1.9 ms/page |
| الجبر الخطي (Linear Algebra) | 383 | **scanned images** (Acrobat image conversion), no text layer | none |

## Findings

- **R1 (pdfjs / pdftotext)**: fast, but fractions flatten ("3/7" becomes "37"), fill-in blanks vanish, no LaTeX. Arabic book has nothing to extract: it is a scan, so it needs R3 or R4.
- **R2 (`cloudflare-ai`)**: for text PDFs it is only a text dump (`### Page N`, lines glued together, no LaTeX display blocks on any book). For the scanned Arabic book it returned **empty pages** (no OCR). Cost ≈ $0.0001-0.0007 per call. **Verdict: no better than R1; drop R2 or keep only as a fallback.**
- **R2 size limit**: a file between about 2.1 MB (worked) and 5.5 MB (failed) is rejected with "exceeds the maximum size". It is a **file-size** limit, not a page limit. `pdfseparate` keeps shared resources, so a single CK-12 page became 5.4 MB; **`pdf-lib` `copyPages` produced 183 KB for the same 10 pages**. The ingestion slicer must use a pruning copier (pdf-lib), not poppler. Mistral-OCR accepted the same bloated files (up to 7 MB), so the limit applies to the `cloudflare-ai` engine.
- **R3 (`mistral-ocr`)**: works on all four. Cost **$0.0205-0.0208 per 10 pages** (= $2 / 1,000 pages, as planned). 3.5-15 s per 10 pages. Output is one Markdown string for the whole slice with **no page markers**, so per-page routing needs one request per page range, or page-sized slices. It returns images as extra parts (2-8 per slice). LaTeX display blocks: 3-12 per slice on the math books, 56 on the Arabic book. Arabic text and equations came out as clean RTL Markdown with `$$` math.
- **R4 (`gemini-3.8-flash` on 130 dpi page PNGs)**: works on all four. $0.002-0.016 per page (the top of the range is a response that hit the 4,000-token cap); 4-39 s per page. More LaTeX than R3 (13 vs 3 display blocks on Algebra 1; 23 vs 12 on CK-12). Arabic page 45 matches R3 line for line; R4 dropped the hamza on some alefs (`اذا` vs `إذا`) that R3 kept. R4 wrote `[illegible]` zero times, so the "invented text" check is still open.
- **Cost projection** for the 383-page Arabic scan: R3 ≈ $0.77, R4 ≈ $2.6-3.4. R3 is about 4x cheaper than R4 and its output looks as good on the Arabic sample.

## Not done / needs a human

- **Quality ratings 1-5** for reading order, headings, math fidelity and Arabic correctness. Compare `out/<book>/r3.md` and `out/<book>/r4.md` against `out/<book>/p<N>.png`. I only counted characters and LaTeX blocks, which does not measure correctness.
- R4 hallucination check on pages with figures or blanks (Algebra 1 workbook).
- Per-page routing thresholds (text density, math density): not decided.
- Not tested: a stronger R4 vision model (Sonnet 5.5), reusing the `file` annotation to skip re-parsing, Arabic search normalisation (needs chunks).

## Decisions (your call, 2026-11-02)

- Text PDF, little math: **R1**.
- Scanned or math-dense pages (including Arabic): **R3** per page range.
- **R4** is the fallback for pages R3 gets wrong.
- R2 dropped from the ladder.
- Slice with pdf-lib, never poppler.
- Still open: per-page routing thresholds (text density, math density), and the quality ratings that would confirm R3 over R4 on the Arabic book.
