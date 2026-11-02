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
    try {
      const { svg, width, height, depth } = await convertToSvg(
        latex,
        opts.display,
      )
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
