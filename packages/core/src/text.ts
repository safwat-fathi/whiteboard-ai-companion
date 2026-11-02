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
// RTL blocks: Hebrew..Arabic Extended-A, Hebrew/Arabic presentation forms A, Arabic presentation forms B (without U+FEFF, a format char).
const RTL = /[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFE]/u
// Non-letters that are strong right-to-left: Hebrew maqaf/paseq/sof pasuq/nun hafukha, Arabic semicolon/letter mark/
// question mark/full stop, RLM. LRM is the strong left-to-right one.
const STRONG_RTL = /[\u05BE\u05C0\u05C3\u05C6\u061B\u061C\u061F\u06D4\u200F]/u
const LRM = '\u200E'

/**
 * `auto` = direction of the first strong character, `ltr` when there is none. Strong = a letter, or one of the few
 * non-letters the textarea (`unicode-bidi: plaintext`) also treats as strong; digits, other punctuation and marks are skipped.
 * ponytail: an explicit list (no bidi-class lookup in JS regexes); other R/AL non-letters are still skipped: Hebrew
 * geresh/gershayim (U+05F3/4) and others, e.g. U+060B Afghani sign, U+066D, U+FDFC Rial sign, Syriac/NKo punctuation.
 */
export function resolveDir(text: string, dir: TextData['dir']): 'ltr' | 'rtl' {
  if (dir !== 'auto') return dir
  for (const ch of text) {
    if (STRONG_RTL.test(ch)) return 'rtl'
    if (ch === LRM) return 'ltr'
    if (/\p{L}/u.test(ch)) return RTL.test(ch) ? 'rtl' : 'ltr'
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
