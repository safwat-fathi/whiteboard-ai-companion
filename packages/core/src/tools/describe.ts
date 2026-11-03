import type { Element } from '../schema'

const clip = (s: string, n: number) =>
  s.length > n ? `${s.slice(0, n - 1)}…` : s

/** Who made it, in the digest's words: `you`, or `AI <turn>`. */
export const byOf = (el: Element): string =>
  el.author.kind === 'human'
    ? 'you'
    : `AI ${el.author.id.replace(/^tutor:/, '')}`

/** One line of detail per type (board-context.md "Digest format"): enough to recognise an element, never its full payload. */
export function detailOf(el: Element): string {
  switch (el.type) {
    case 'text':
      return JSON.stringify(clip(el.data.text.replace(/\s+/g, ' '), 80))
    case 'math':
      return clip(el.data.latex.replace(/\s+/g, ' '), 80)
    case 'shape':
      return el.data.label
        ? `${el.data.kind} ${JSON.stringify(clip(el.data.label, 40))}`
        : el.data.kind
    case 'freehand':
      return `stroke, ${el.data.points.length} pts${el.data.highlighter ? ', highlighter' : ''}`
    case 'image': {
      const src = el.data.source?.bookPage
      return src
        ? `book p.${src.page}${el.data.alt ? ` ${JSON.stringify(clip(el.data.alt, 40))}` : ''}`
        : el.data.alt
          ? JSON.stringify(clip(el.data.alt, 60))
          : 'image'
    }
  }
}

const r = (n: number) => Math.round(n)
export const describeElement = (el: Element) => ({
  id: el.id,
  type: el.type,
  x: r(el.x),
  y: r(el.y),
  w: r(el.w),
  h: r(el.h),
  by: byOf(el),
  detail: detailOf(el),
})
