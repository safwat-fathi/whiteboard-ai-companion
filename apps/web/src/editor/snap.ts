import type { Rect } from '@whiteboard/core'

/** A line the select tool draws while a move is snapped: `axis` is the one the position is on ('x' = a vertical line). */
export type Guide = { axis: 'x' | 'y'; at: number; from: number; to: number }

const SNAP_PX = 6

/**
 * How far to nudge `box` so an edge or the centre lines up with one of `others` (R13), nearest candidate per axis within
 * 6 screen px, plus the guide lines to draw. ponytail: every other element is a candidate (a scan, no index); spacing
 * snap and resize snap are not built.
 */
export function snapBox(
  box: Rect,
  others: Rect[],
  zoom: number,
): { dx: number; dy: number; guides: Guide[] } {
  const tol = SNAP_PX / zoom
  const xs = (r: Rect) => [r.minX, (r.minX + r.maxX) / 2, r.maxX]
  const ys = (r: Rect) => [r.minY, (r.minY + r.maxY) / 2, r.maxY]
  let dx = 0
  let dy = 0
  let bx: { d: number; at: number; other: Rect } | null = null
  let by: { d: number; at: number; other: Rect } | null = null
  for (const o of others) {
    for (const mine of xs(box))
      for (const theirs of xs(o)) {
        const d = theirs - mine
        if (Math.abs(d) <= tol && (!bx || Math.abs(d) < Math.abs(bx.d)))
          bx = { d, at: theirs, other: o }
      }
    for (const mine of ys(box))
      for (const theirs of ys(o)) {
        const d = theirs - mine
        if (Math.abs(d) <= tol && (!by || Math.abs(d) < Math.abs(by.d)))
          by = { d, at: theirs, other: o }
      }
  }
  if (bx) dx = bx.d
  if (by) dy = by.d
  const moved = {
    minX: box.minX + dx,
    maxX: box.maxX + dx,
    minY: box.minY + dy,
    maxY: box.maxY + dy,
  }
  const guides: Guide[] = []
  if (bx)
    guides.push({
      axis: 'x',
      at: bx.at,
      from: Math.min(moved.minY, bx.other.minY),
      to: Math.max(moved.maxY, bx.other.maxY),
    })
  if (by)
    guides.push({
      axis: 'y',
      at: by.at,
      from: Math.min(moved.minX, by.other.minX),
      to: Math.max(moved.maxX, by.other.maxX),
    })
  return { dx, dy, guides }
}
