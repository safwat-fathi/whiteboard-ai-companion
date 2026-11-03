import { bounds } from './geometry'
import type { Element } from './schema'
import { byOf, detailOf } from './tools/describe'

// The board as text for the tutor (board-context.md "Digest format"): enough to know what exists and where, never all of it.

const TOKEN_CHARS = 3 // three characters to a token, Latin and Arabic alike
const ROW_CAP = 200
const DIGEST_TOKENS = 3000
const DETAIL_TOKENS = 4000
const DETAIL_TEXT = 500
const FOOTER_RESERVE = 80
const TYPES = ['text', 'shape', 'math', 'image'] as const

type View = { x: number; y: number; w: number; h: number; zoom?: number }
const r = Math.round

/**
 * `BOARD ... / CONTENT ... / table`: selection first, then what is in the viewport, then the rest, newest first (a
 * higher z was drawn later). At most 200 rows or about 3,000 tokens, with a footer saying how many are not shown.
 */
export function buildDigest(o: {
  title: string
  seq: number
  elements: Element[]
  viewport?: View
  selection: readonly string[]
  maxRows?: number
  maxTokens?: number
}): string {
  const byId = new Map(o.elements.map((e) => [e.id, e]))
  const selection = o.selection.filter((id) => byId.has(id))
  const counts = TYPES.flatMap((t) => {
    const n = o.elements.filter((e) => e.type === t).length
    return n ? [`${t} ${n}`] : []
  })
  const rects = o.elements.map(bounds)
  const content = rects.length
    ? (() => {
        const [x0, y0] = [
          Math.min(...rects.map((b) => b.minX)),
          Math.min(...rects.map((b) => b.minY)),
        ]
        const [x1, y1] = [
          Math.max(...rects.map((b) => b.maxX)),
          Math.max(...rects.map((b) => b.maxY)),
        ]
        return `[${r(x0)} ${r(y0)} ${r(x1 - x0)} ${r(y1 - y0)}]`
      })()
    : 'none'
  const v = o.viewport
  const head = [
    `BOARD ${JSON.stringify(o.title)} · seq ${o.seq} · ${o.elements.length} element${o.elements.length === 1 ? '' : 's'}${counts.length ? ` (${counts.join(', ')})` : ''}`,
    `CONTENT ${content}${v ? `   VIEWPORT [${r(v.x)} ${r(v.y)} ${r(v.w)} ${r(v.h)}]${v.zoom ? ` zoom ${+v.zoom.toFixed(2)}` : ''}` : ''}   SELECTION ${selection.length ? selection.join(' ') : 'none'}`,
    'id | type | x,y,w,h | by | detail',
  ]

  const chosen = new Set(selection)
  const inView = (e: Element) => {
    if (!v) return false
    const b = bounds(e)
    return (
      b.minX < v.x + v.w && b.maxX > v.x && b.minY < v.y + v.h && b.maxY > v.y
    )
  }
  const newestFirst = (a: Element, b: Element) =>
    a.z < b.z ? 1 : a.z > b.z ? -1 : 0
  const rest = o.elements.filter((e) => !chosen.has(e.id))
  const ordered = [
    ...selection.map((id) => byId.get(id) as Element),
    ...rest.filter(inView).sort(newestFirst),
    ...rest.filter((e) => !inView(e)).sort(newestFirst),
  ]

  const maxRows = o.maxRows ?? ROW_CAP
  // room for the header and for the footer line that says how many rows are left out
  let budget =
    (o.maxTokens ?? DIGEST_TOKENS) * TOKEN_CHARS -
    head.join('\n').length -
    FOOTER_RESERVE
  const rows: string[] = []
  for (const e of ordered) {
    const row = `${e.id} | ${e.type} | ${r(e.x)},${r(e.y)},${r(e.w)},${r(e.h)} | ${byOf(e)} | ${detailOf(e)}`
    if (rows.length >= maxRows || row.length + 1 > budget) break
    rows.push(row)
    budget -= row.length + 1
  }
  const hidden = ordered.length - rows.length
  return [
    ...head,
    ...rows,
    ...(hidden > 0
      ? [`(+${hidden} more not shown. Use get_elements with a region or type.)`]
      : []),
  ].join('\n')
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s)

/** The full data of the selected elements, one JSON object per line, long texts cut; about 4,000 tokens at most. */
export function buildSelectionDetail(
  elements: Element[],
  selection: readonly string[],
  maxTokens = DETAIL_TOKENS,
): string {
  const byId = new Map(elements.map((e) => [e.id, e]))
  const picked = selection.flatMap((id) => byId.get(id) ?? [])
  let budget = maxTokens * TOKEN_CHARS
  const lines: string[] = []
  for (const e of picked) {
    const data: Record<string, unknown> = { ...e.data }
    for (const k of ['text', 'label', 'latex', 'alt'])
      if (typeof data[k] === 'string')
        data[k] = clip(data[k] as string, DETAIL_TEXT)
    if (Array.isArray(data.points)) data.points = `${data.points.length} points`
    const { id, type, x, y, w, h, rotation, style, locked } = e
    const line = JSON.stringify({
      id,
      type,
      x: r(x),
      y: r(y),
      w: r(w),
      h: r(h),
      rotation,
      style,
      locked,
      by: byOf(e),
      data,
    })
    if (line.length + 1 > budget) break
    lines.push(line)
    budget -= line.length + 1
  }
  const hidden = picked.length - lines.length
  return [
    ...lines,
    ...(hidden > 0 ? [`(+${hidden} more selected elements not shown)`] : []),
  ].join('\n')
}
