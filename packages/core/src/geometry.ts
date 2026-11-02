import type { Scene } from './scene'
import type { Binding, Element } from './schema'

export type Point = { x: number; y: number }
export type Rect = { minX: number; minY: number; maxX: number; maxY: number }
export type Handle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w'
/** Dotted-leaf keys only, so it is a valid `set` for a `patch` op. */
export type Patch = Record<string, unknown>

const centre = (el: Element): Point => ({
  x: el.x + el.w / 2,
  y: el.y + el.h / 2,
})

const rot = (p: Point, c: Point, a: number): Point => {
  const cos = Math.cos(a)
  const sin = Math.sin(a)
  const dx = p.x - c.x
  const dy = p.y - c.y
  return { x: c.x + dx * cos - dy * sin, y: c.y + dx * sin + dy * cos }
}

/** World point -> the element's unrotated frame (inverse-rotate about its centre). */
export const toLocal = (el: Element, p: Point): Point =>
  rot(p, centre(el), -el.rotation)

const isLinear = (el: Element) =>
  el.type === 'shape' && (el.data.kind === 'line' || el.data.kind === 'arrow')

// Arrow/line `data.points` are RELATIVE to the element's x,y and are never rotated.
const worldPoints = (el: Element): Point[] =>
  el.type === 'shape'
    ? (el.data.points ?? []).map(([px, py]) => ({ x: el.x + px, y: el.y + py }))
    : []

export function bounds(el: Element): Rect {
  // Linear elements ignore rotation. Empty/missing points fall back to a degenerate rect at (x, y) so bounds stay finite.
  const lin = worldPoints(el)
  const pts = isLinear(el)
    ? lin.length
      ? lin
      : [{ x: el.x, y: el.y }]
    : [
        { x: el.x, y: el.y },
        { x: el.x + el.w, y: el.y },
        { x: el.x + el.w, y: el.y + el.h },
        { x: el.x, y: el.y + el.h },
      ].map((p) => rot(p, centre(el), el.rotation))
  const pad = isLinear(el) ? el.style.strokeWidth / 2 : 0
  const xs = pts.map((p) => p.x)
  const ys = pts.map((p) => p.y)
  return {
    minX: Math.min(...xs) - pad,
    minY: Math.min(...ys) - pad,
    maxX: Math.max(...xs) + pad,
    maxY: Math.max(...ys) + pad,
  }
}

export const boundsOf = bounds

export function lockedAspect(el: Element): number | null {
  if (el.type === 'math' || el.type === 'image')
    return el.w > 0 && el.h > 0 ? el.w / el.h : 1
  return null
}

/** MathJax em metrics -> world `{w, h}` at `size`. */
export function fitMath(
  metrics: { width: number; height: number; depth: number },
  size: number,
): { w: number; h: number } {
  return {
    w: metrics.width * size,
    h: (metrics.height + metrics.depth) * size,
  }
}

function segDist(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const l2 = dx * dx + dy * dy
  const t = l2
    ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2))
    : 0
  return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy)
}

const polyDist = (p: Point, pts: Point[], closed: boolean) => {
  const a = pts[0]
  if (pts.length === 1 && a) return segDist(p, a, a) // one point: degenerate segment
  let d = Infinity
  for (let i = 0; i < pts.length - (closed ? 0 : 1); i++)
    d = Math.min(
      d,
      segDist(p, pts[i] as Point, pts[(i + 1) % pts.length] as Point),
    )
  return d
}

function inside(p: Point, pts: Point[]): boolean {
  let hit = false
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[i] as Point
    const b = pts[j] as Point
    if (
      a.y > p.y !== b.y > p.y &&
      p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x
    )
      hit = !hit
  }
  return hit
}

/** Outline of a closed shape in the unrotated frame; hit testing and the editor's selection outline both trace it. ponytail: ellipse is a 64-gon (error ~0.0012*r); corner radius ignored. */
export function outline(el: Element): Point[] {
  const { x, y, w, h } = el
  const kind = el.type === 'shape' ? el.data.kind : 'rect'
  if (kind === 'diamond')
    return [
      { x: x + w / 2, y },
      { x: x + w, y: y + h / 2 },
      { x: x + w / 2, y: y + h },
      { x, y: y + h / 2 },
    ]
  if (kind === 'triangle')
    return [
      { x: x + w / 2, y },
      { x: x + w, y: y + h },
      { x, y: y + h },
    ]
  if (kind === 'ellipse')
    return Array.from({ length: 64 }, (_, i) => {
      const a = (i / 64) * 2 * Math.PI
      return {
        x: x + w / 2 + (w / 2) * Math.cos(a),
        y: y + h / 2 + (h / 2) * Math.sin(a),
      }
    })
  return [
    { x, y },
    { x: x + w, y },
    { x: x + w, y: y + h },
    { x, y: y + h },
  ]
}

/** `tolWorld` is in world units (callers pass 6 / zoom). Text uses its stored box, not a layout. */
export function hitTest(el: Element, p: Point, tolWorld: number): boolean {
  if (isLinear(el)) {
    const d = polyDist(p, worldPoints(el), false)
    return d <= tolWorld + el.style.strokeWidth / 2
  }
  const q = toLocal(el, p)
  if (el.type === 'text' || el.type === 'math' || el.type === 'image')
    return (
      q.x >= el.x - tolWorld &&
      q.x <= el.x + el.w + tolWorld &&
      q.y >= el.y - tolWorld &&
      q.y <= el.y + el.h + tolWorld
    )
  const pts = outline(el)
  if (el.style.fill !== null && inside(q, pts)) return true
  return polyDist(q, pts, true) <= tolWorld + el.style.strokeWidth / 2
}

/**
 * Binding fractions are of the target's UNROTATED box, then rotated about its centre.
 * A linear target ignores rotation (treated as 0), consistent with bounds/hitTest.
 */
export const resolveEnd = (b: Binding, target: Element): Point =>
  rot(
    { x: target.x + b.fx * target.w, y: target.y + b.fy * target.h },
    centre(target),
    isLinear(target) ? 0 : target.rotation,
  )

/**
 * Arrow points, relative to the arrow's x,y (same convention as `data.points`).
 * Bound ends follow their target; unbound or missing-target ends keep the stored point.
 */
export function routeArrow(arrow: Element, scene: Scene): [number, number][] {
  const pts: [number, number][] =
    arrow.type === 'shape'
      ? (arrow.data.points ?? []).map(([a, b]) => [a, b])
      : []
  if (arrow.type !== 'shape' || pts.length === 0) return pts
  const ends: [Binding | undefined, number][] = [
    [arrow.data.start, 0],
    [arrow.data.end, pts.length - 1],
  ]
  for (const [b, i] of ends) {
    const t = b && scene.els.get(b.id)
    if (t) {
      const w = resolveEnd(b, t)
      pts[i] = [w.x - arrow.x, w.y - arrow.y]
    }
  }
  return pts
}

const MIN = 1

/**
 * Linear elements (line/arrow) are never box-resized or rotated in M1: returns `{}`. The select tool
 * must show endpoint handles for them and edit `data.points` itself.
 * `to` is a world point; the handle acts in the element's rotated frame, the opposite anchor stays fixed in world space. */
export function resizeBox(
  el: Element,
  handle: Handle,
  to: Point,
  keepAspect: boolean,
): Patch {
  if (isLinear(el)) return {}
  const q = toLocal(el, to)
  const west = handle.includes('w')
  const east = handle.includes('e')
  const north = handle.includes('n')
  const south = handle.includes('s')
  let left = el.x
  let right = el.x + el.w
  let top = el.y
  let bottom = el.y + el.h
  if (west) left = Math.min(q.x, right - MIN)
  if (east) right = Math.max(q.x, left + MIN)
  if (north) top = Math.min(q.y, bottom - MIN)
  if (south) bottom = Math.max(q.y, top + MIN)
  if ((keepAspect || lockedAspect(el) !== null) && el.w > 0 && el.h > 0) {
    const corner = (west || east) && (north || south)
    let nw = right - left
    let nh = bottom - top
    if (corner) {
      const s = Math.max(nw / el.w, nh / el.h)
      nw = Math.max(el.w * s, MIN)
      nh = Math.max(el.h * s, MIN)
    } else if (west || east) nh = Math.max((el.h * nw) / el.w, MIN)
    else nw = Math.max((el.w * nh) / el.h, MIN)
    if (west) left = right - nw
    else if (east) right = left + nw
    else {
      const m = (left + right) / 2
      left = m - nw / 2
      right = m + nw / 2
    }
    if (north) top = bottom - nh
    else if (south) bottom = top + nh
    else {
      const m = (top + bottom) / 2
      top = m - nh / 2
      bottom = m + nh / 2
    }
  }
  // The new centre in the old unrotated frame, rotated back to world; x,y follow from it.
  const c = rot(
    { x: (left + right) / 2, y: (top + bottom) / 2 },
    centre(el),
    el.rotation,
  )
  const w = right - left
  const h = bottom - top
  return { x: c.x - w / 2, y: c.y - h / 2, w, h }
}

/** Returns `{}` for linear elements (see resizeBox). */
export function rotateTo(el: Element, angle: number, snap15: boolean): Patch {
  if (isLinear(el)) return {}
  const step = Math.PI / 12
  return { rotation: (snap15 ? Math.round(angle / step) * step : angle) + 0 }
}
