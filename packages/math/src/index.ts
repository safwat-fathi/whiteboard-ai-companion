import { ARABIC_ERROR, containsArabic } from './arabic'
import {
  convertToSvg,
  getAsyncLoadedModules,
  getConversionCount,
  isMathJaxLoaded,
  MAX_LATEX,
} from './config'
import {
  type AffineMatrix,
  drawMathPaths,
  fixViewBox,
  type MathPathItem,
  type MathPaths,
  svgToPaths,
} from './svg'

export {
  type AffineMatrix,
  ARABIC_ERROR,
  containsArabic,
  drawMathPaths,
  fixViewBox,
  getAsyncLoadedModules,
  getConversionCount,
  isMathJaxLoaded,
  MAX_LATEX,
  type MathPathItem,
  type MathPaths,
  svgToPaths,
}

export type MathOpts = { display: boolean; color: string }
export type MathResult =
  | { ok: true; svg: string; width: number; height: number; depth: number }
  | { ok: false; error: string }

const MAX_CACHE = 2000
const MAX_WIDTH_EM = 400
const MAX_HEIGHT_EM = 200
const SAFE_COLOR = /^(#[0-9a-f]{3,8}|[a-z]+|(rgb|hsl)a?\([\d\s.,%/-]+\))$/i
const cache = new Map<string, MathResult>()
const inflight = new Map<string, Promise<MathResult>>()

function cacheKey(latex: string, opts: MathOpts): string {
  return `${opts.display ? 1 : 0}|${opts.color}|${latex}`
}

function store(key: string, res: MathResult): MathResult {
  if (cache.has(key)) cache.delete(key)
  cache.set(key, res)
  if (cache.size > MAX_CACHE) {
    const oldest = cache.keys().next().value
    if (oldest !== undefined) cache.delete(oldest)
  }
  return res
}

export function peekMath(
  latex: string,
  opts: MathOpts,
): MathResult | undefined {
  const key = cacheKey(latex, opts)
  const hit = cache.get(key)
  if (hit) {
    cache.delete(key)
    cache.set(key, hit)
  }
  return hit
}

export function renderMath(latex: string, opts: MathOpts): Promise<MathResult> {
  const key = cacheKey(latex, opts)
  const hit = peekMath(latex, opts)
  if (hit) return Promise.resolve(hit)
  const pending = inflight.get(key)
  if (pending) return pending

  const p = (async (): Promise<MathResult> => {
    if (latex.length > MAX_LATEX) {
      return store(key, {
        ok: false,
        error: `LaTeX input exceeds the 4,000 character limit (${latex.length})`,
      })
    }
    if (latex.trim().length === 0) {
      return store(key, {
        ok: false,
        error: 'LaTeX input must not be empty',
      })
    }
    if (containsArabic(latex)) {
      return store(key, { ok: false, error: ARABIC_ERROR })
    }
    // The colour is spliced into SVG markup, so only plain CSS colours get through.
    if (!SAFE_COLOR.test(opts.color)) {
      return store(key, { ok: false, error: `Invalid colour: ${opts.color}` })
    }
    try {
      const { svg, width, height, depth } = await convertToSvg(
        latex,
        opts.display,
      )
      // MathJax falls back to SVG <text> for glyphs the font lacks (CJK, emoji); it cannot be drawn reliably.
      if (/<text[\s>]/.test(svg)) {
        return store(key, {
          ok: false,
          error:
            'Unsupported characters in formula (only Latin, Greek and math symbols are supported)',
        })
      }
      if (width > MAX_WIDTH_EM || height + depth > MAX_HEIGHT_EM) {
        return store(key, {
          ok: false,
          error: 'Formula is too large to render',
        })
      }
      const colored = svg.replaceAll('currentColor', opts.color)
      return store(key, { ok: true, svg: colored, width, height, depth })
    } catch (e) {
      const raw =
        typeof (e as { message?: unknown })?.message === 'string'
          ? (e as { message: string }).message
          : String(e)
      const msg = raw.split('\n')[0] || 'Invalid LaTeX'
      return store(key, { ok: false, error: msg })
    }
  })().finally(() => {
    inflight.delete(key)
  })

  inflight.set(key, p)
  return p
}
