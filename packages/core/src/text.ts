import { FONT_STACK, type Platform } from './platform'
import type { Element, TextData } from './schema'

export type TextLine = {
  text: string
  x: number
  y: number
  width: number
  dir: 'ltr' | 'rtl'
}

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
 * - Line height is 1.4 × size. Empty text still yields one line.
 */
export function layoutText(
  el: Element & { type: 'text' },
  platform: Platform,
): { lines: TextLine[]; width: number; height: number } {
  const { text, size, align, dir, maxWidth } = el.data
  const font = `${size}px ${FONT_STACK}`
  const measure = (s: string) => platform.measureText(font, s.trimEnd())
  const rows: { text: string; width: number; dir: 'ltr' | 'rtl' }[] = []

  for (const para of text.split('\n')) {
    const d = resolveDir(para, dir)
    const push = (line: string) =>
      rows.push({ text: line.trimEnd(), width: measure(line), dir: d })
    const fits = (s: string) => maxWidth === undefined || measure(s) <= maxWidth
    let line = ''
    for (const piece of pieces(words, para)) {
      if (fits(line + piece) || !piece.trim()) {
        line += piece
        continue
      }
      if (line.trim()) push(line)
      line = ''
      if (fits(piece)) line = piece
      else
        for (const g of pieces(graphemes, piece)) {
          if (!line || fits(line + g)) line += g
          else {
            push(line)
            line = g
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
