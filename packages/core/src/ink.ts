import { getStroke } from 'perfect-freehand'
import type { Platform } from './platform'

type Pt = [number, number]

export type StrokeOpts = {
  /** The stored width (`style.strokeWidth`): perfect-freehand's `size`, a diameter at pressure 0.5. */
  size: number
  smoothing: number
  highlighter: boolean
  /** Treat the points as a finished stroke (default). A live stroke passes `false` so its end trails the pen. */
  last?: boolean
}

// R2: pressure thins the pen by half; the highlighter has a constant width.
const PEN_THINNING = 0.5

/**
 * How far a stroke's ink reaches from its polyline. perfect-freehand's radius is
 * `size * (0.5 + thinning * (pressure - 0.5))`, largest at pressure 1: a pen draws up to 1.5 x its stored width, so
 * `strokeWidth / 2` is not enough for bounds, hit tests or culling.
 */
export const inkReach = (el: {
  style: { strokeWidth: number }
  data: { highlighter: boolean }
}): number =>
  el.style.strokeWidth * (0.5 + (el.data.highlighter ? 0 : PEN_THINNING) / 2)

/** The closed outline polygon of a stroke. Empty for size <= 0 or no points. */
export function strokePolygon(
  points: readonly Pt[],
  pressure: readonly number[] | undefined,
  o: StrokeOpts,
): Pt[] {
  if (!points.length || !(o.size > 0)) return []
  // Pressure rides in each point as [x, y, p]; a separate array would be ignored (every point reads as 0.5).
  let pts = points.map(([x, y], i) =>
    pressure ? [x, y, pressure[i]] : [x, y],
  ) as number[][]
  const [a, b] = pts as [number[], number[]]
  // A lone point would be drawn as a capsule to point + (1, 1); repeating it gives a dot centred on the point.
  if (pts.length === 1) pts.push(a)
  // Two points: the library interpolates them itself and drops the pressure of all but the first, which would thin
  // the body of a straight stroke (the usual result of RDP). Do the same interpolation with the pressure carried.
  else if (pts.length === 2)
    pts = [0, 0.25, 0.5, 0.75, 1].map((t) =>
      a.map((v, k) => v + ((b[k] as number) - v) * t),
    )
  return getStroke(pts, {
    size: o.size,
    thinning: o.highlighter ? 0 : PEN_THINNING,
    smoothing: o.smoothing,
    streamline: 0.5,
    simulatePressure: !pressure,
    last: o.last ?? true,
  }) as Pt[]
}

/**
 * The stroke as a closed path in the points' own frame: a quadratic curve through the midpoints of the outline, with
 * the vertices as control points. Fill it with the default (nonzero) rule: the outline crosses itself at sharp turns.
 * Used for stored elements (via `render`) and for the live overlay alike.
 */
export function strokeOutline(
  points: readonly Pt[],
  pressure: readonly number[] | undefined,
  o: StrokeOpts,
  platform: Platform,
): Path2D {
  const path = platform.createPath2D()
  const poly = strokePolygon(points, pressure, o)
  const n = poly.length
  if (
    n < 3 ||
    !poly.every(([x, y]) => Number.isFinite(x) && Number.isFinite(y))
  )
    return path
  const at = (i: number) => poly[i % n] as Pt
  const mid = (i: number): Pt => {
    const [ax, ay] = at(i)
    const [bx, by] = at(i + 1)
    return [(ax + bx) / 2, (ay + by) / 2]
  }
  const [sx, sy] = mid(0)
  path.moveTo(sx, sy)
  for (let i = 1; i <= n; i++) {
    const [cx, cy] = at(i)
    const [mx, my] = mid(i)
    path.quadraticCurveTo(cx, cy, mx, my)
  }
  path.closePath()
  return path
}

/**
 * Ramer-Douglas-Peucker (ponytail: O(n log n) on a pen stroke, O(n^2) on a 10,000-point zigzag, about 0.2 s). Keeps both ends; a point survives when it is more than `eps` from the segment between its
 * neighbours' survivors. Only the first two coordinates count, the rest (pressure) ride along, so pass `[x, y, p]`
 * and split afterwards. Returns the same point objects, in order.
 */
export function rdp<P extends readonly [number, number, ...number[]]>(
  pts: readonly P[],
  eps: number,
): P[] {
  const n = pts.length
  if (n < 3) return [...pts]
  const keep = new Uint8Array(n)
  keep[0] = 1
  keep[n - 1] = 1
  const stack: [number, number][] = [[0, n - 1]]
  while (stack.length) {
    const [lo, hi] = stack.pop() as [number, number]
    const a = pts[lo] as P
    const b = pts[hi] as P
    const ax = a[0]
    const ay = a[1]
    const dx = b[0] - ax
    const dy = b[1] - ay
    const l2 = dx * dx + dy * dy
    let far = -1
    let at = lo
    for (let i = lo + 1; i < hi; i++) {
      const p = pts[i] as P
      const px = p[0]
      const py = p[1]
      // distance to the segment, not the infinite line: a loop's ends coincide (l2 = 0) and it is the distance to that point
      const t = l2
        ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2))
        : 0
      const ex = px - ax - t * dx
      const ey = py - ay - t * dy
      const d2 = ex * ex + ey * ey
      if (d2 > far) {
        far = d2
        at = i
      }
    }
    if (far > eps * eps) {
      keep[at] = 1
      stack.push([lo, at], [at, hi])
    }
  }
  return pts.filter((_, i) => keep[i])
}

const tenth = (n: number) => Math.round(n * 10) / 10 + 0 // `+ 0` turns -0 into 0
const hundredth = (n: number) =>
  Math.round(Math.min(1, Math.max(0, n)) * 100) / 100 + 0

/**
 * Samples -> what a `freehand` element stores (R1): points rounded to 0.1 and pressure to 0.01, the tight box of the
 * rounded points as `x, y, w, h`, and the points relative to `(x, y)`. NaN passes through for the schema to reject.
 */
export function quantiseStroke(
  abs: readonly Pt[],
  pressure: readonly number[] | undefined,
): {
  x: number
  y: number
  w: number
  h: number
  points: Pt[]
  pressure: number[] | undefined
} {
  const rounded = abs.map(([px, py]) => [tenth(px), tenth(py)] as Pt)
  const x = Math.min(...rounded.map(([px]) => px))
  const y = Math.min(...rounded.map(([, py]) => py))
  const points = rounded.map(([px, py]) => [tenth(px - x), tenth(py - y)] as Pt)
  return {
    x,
    y,
    w: Math.max(...points.map(([px]) => px)),
    h: Math.max(...points.map(([, py]) => py)),
    points,
    pressure: pressure?.map(hundredth),
  }
}
