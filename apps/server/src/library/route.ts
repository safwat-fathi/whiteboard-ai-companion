import type { OpenPdf } from './pdf'

/**
 * Under 50 characters a page is a scan; over 5% math symbols it is math-dense. Both go to R4. S2 used 4% on text that
 * kept every raw space; on the cleaned text of `pageText` 5% picks the same pages (Alg1 41 vs S2's 44, CK-12 13 vs 12).
 */
export const SCANNED_MAX_CHARS = 50
export const MATH_DENSE_RATIO = 0.05
const MATH_SYMBOLS = /[=+\-×÷≤≥<>^√π∑∫±≠≈]/g

export type PageStats = { chars: number; mathRatio: number }
export type PageRung = 'R1' | 'R4'

export function pageStats(text: string): PageStats {
  const t = text.trim()
  return {
    chars: t.length,
    mathRatio: (t.match(MATH_SYMBOLS)?.length ?? 0) / Math.max(t.length, 1),
  }
}

/** The default rung of a page: R1 (free, local) unless it is a scan or math-dense, then R4 (vision). */
export const routePage = (s: PageStats): PageRung =>
  s.chars < SCANNED_MAX_CHARS || s.mathRatio > MATH_DENSE_RATIO ? 'R4' : 'R1'

export async function analyzePdf(pdf: OpenPdf): Promise<PageStats[]> {
  const stats: PageStats[] = []
  for (let n = 1; n <= pdf.numPages; n++)
    stats.push(pageStats(await pdf.pageText(n)))
  return stats
}

const R4_TOKENS_PER_PAGE = 800 // a guess for pages we have not read yet (embedding cost only)
export const EMBED_USD_PER_MTOK = 0.01 // baai/bge-m3 via OpenRouter
export const R3_USD_PER_PAGE = 0.00205 // S2: $0.0205 per 10 pages of mistral-ocr
/** R4 (the vision model) has no published price on Meta, so this is an estimate: S2 measured gemini-3.8-flash at $0.07 to $0.09 per 10 pages. Override with R4_USD_PER_PAGE. */
export const R4_USD_PER_PAGE = 0.009

export type Estimate = {
  pages: number
  r1: number
  r4: number
  scanned: number
  mathDense: number
  /** What embedding the whole book will cost (OpenRouter). */
  embedUsd: number
  /** What the R4 pages would cost if run through the opt-in R3 instead. */
  r3Usd: number
  /** What the R4 pages cost at the estimated per-page price (see R4_USD_PER_PAGE). */
  r4Usd: number
}

export function estimate(
  stats: PageStats[],
  r4UsdPerPage = R4_USD_PER_PAGE,
): Estimate {
  let r4 = 0
  let scanned = 0
  let mathDense = 0
  let tokens = 0
  for (const s of stats) {
    if (routePage(s) === 'R4') {
      r4++
      tokens += R4_TOKENS_PER_PAGE
      if (s.chars < SCANNED_MAX_CHARS) scanned++
      else mathDense++
    } else tokens += Math.ceil(s.chars / 4)
  }
  return {
    pages: stats.length,
    r1: stats.length - r4,
    r4,
    scanned,
    mathDense,
    embedUsd: (tokens * EMBED_USD_PER_MTOK) / 1e6,
    r3Usd: r4 * R3_USD_PER_PAGE,
    r4Usd: r4 * r4UsdPerPage,
  }
}
