import { FONT_STACK, type Platform } from './platform'
import type { Element, TextData } from './schema'

export type TextLine = {
  text: string
  x: number
  y: number
  width: number
  dir: 'ltr' | 'rtl'
}

export type TextLayout = { lines: TextLine[]; width: number; height: number }

// Elements are replaced, never mutated, so a layout is valid for the life of the element object. Treat results as read-only.
const memo = new WeakMap<Platform, WeakMap<Element, TextLayout>>()
// Only space and tab break/trim: NBSP is deliberately not breakable whitespace.
const trimBreak = (s: string) => s.replace(/[ \t]+$/, '')

const LINE_HEIGHT = 1.4
const RTL = /[֐-ࣿיִ-﷿ﹰ-﻿]/u

/**
 * `auto` = direction of the first strong character (a letter; digits, punctuation and marks are skipped),
 * `ltr` when there is none.
 */
export function resolveDir(text: string, dir: TextData['dir']): 'ltr' | 'rtl' {
  if (dir !== 'auto') return dir
  for (const ch of text) {
    if (RTL.test(ch)) return 'rtl'
    if (/\p{L}/u.test(ch)) return 'ltr'
  }
  return 'ltr'
}

const words = new Intl.Segmenter(undefined, { granularity: 'word' })
const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
const pieces = (seg: Intl.Segmenter, s: string) =>
  Array.from(seg.segment(s), (x) => x.segment)

/**
 * Lays the element's text out in element-local coordinates (origin = element x, y).
 *
 * - Paragraphs are '\n'-separated. With `dir: 'auto'` each paragraph resolves its own direction from its first strong
 *   character, and every wrapped line of that paragraph shares it.
 * - Wrapping is greedy at `maxWidth`, breaking at word boundaries; a word wider than the line is broken between
 *   grapheme clusters, never inside one (emoji ZWJ sequences, letter + shadda + fatha stay whole).
 * - Whitespace at a break is dropped from the end of the line (`line.text` is trimmed), so lines rejoin with a space.
 * - `align` is the VISUAL side the text hugs. For an RTL line the natural placement is `align: 'right'`; layout never
 *   flips `align` itself, so the caller (UI) picks it. Lines are placed within `maxWidth`, or the widest line without.
 * - Invariant for callers: layout width = maxWidth ?? widest line. The text tool must keep element w equal to the layout
 *   width and h to the layout height, so rotation pivot, culling and hit-testing agree with what is drawn.
 * - Line height is 1.4 × size. Empty text still yields one line.
 */
export function layoutText(
  el: Element & { type: 'text' },
  platform: Platform,
): TextLayout {
  let m = memo.get(platform)
  if (!m) {
    m = new WeakMap()
    memo.set(platform, m)
  }
  const hit = m.get(el)
  if (hit) return hit
  const l = compute(el, platform)
  m.set(el, l)
  return l
}

function compute(
  el: Element & { type: 'text' },
  platform: Platform,
): TextLayout {
  const { text, size, align, dir, maxWidth } = el.data
  const font = `${size}px ${FONT_STACK}`
  const measure = (s: string) => platform.measureText(font, trimBreak(s))
  const rows: { text: string; width: number; dir: 'ltr' | 'rtl' }[] = []

  for (const para of text.split('\n')) {
    const d = resolveDir(para, dir)
    const push = (line: string) =>
      rows.push({ text: trimBreak(line), width: measure(line), dir: d })
    const fits = (s: string) => maxWidth === undefined || measure(s) <= maxWidth
    let line = ''
    for (const piece of pieces(words, para)) {
      if (fits(line + piece) || !/[^ \t]/.test(piece)) {
        line += piece
        continue
      }
      if (/[^ \t]/.test(line)) push(line)
      line = ''
      if (fits(piece)) line = piece
      else {
        // binary-search the longest run of graphemes that fits, so a huge unbroken word is O(n log n), not O(n^2)
        const gs = pieces(graphemes, piece)
        let i = 0
        while (i < gs.length) {
          let lo = 1
          let hi = gs.length - i
          while (lo < hi) {
            const mid = (lo + hi + 1) >> 1
            if (fits(gs.slice(i, i + mid).join(''))) lo = mid
            else hi = mid - 1
          }
          const chunk = gs.slice(i, i + lo).join('')
          i += lo
          if (i < gs.length) push(chunk)
          else line = chunk
        }
      }
    }
    push(line)
  }

  const width = maxWidth ?? Math.max(...rows.map((r) => r.width))
  const lh = size * LINE_HEIGHT
  const lines = rows.map((r, i) => ({
    ...r,
    x:
      align === 'left'
        ? 0
        : align === 'right'
          ? width - r.width
          : (width - r.width) / 2,
    y: i * lh,
  }))
  return { lines, width, height: lines.length * lh }
}
