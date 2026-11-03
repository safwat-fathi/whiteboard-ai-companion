import { bounds, type Rect } from './geometry'
import type { Scene } from './scene'
import { type Batch, type Element, newId, type Op } from './schema'
import { rerouteArrows } from './tools/board'

// Align, distribute and stack as pure batch builders: the tutor's `arrange` tool and the Arrange menu share them (R9).
// Everything is measured by what is seen (`bounds`: rotation and a stroke's ink included) and moves only x and y. Who may
// move what is the caller's business, except for the arrows that follow as a side effect (`mayEdit`).

export type AlignTo = 'left' | 'centre' | 'right' | 'top' | 'middle' | 'bottom'
type Opts = { mayEdit?: (el: Element) => boolean }
type Delta = { dx: number; dy: number }

const hundredth = (n: number) => Math.round(n * 100) / 100
const boxes = (els: Element[]) => els.map((el) => ({ el, b: bounds(el) }))
const union = (rs: Rect[]): Rect => ({
  minX: Math.min(...rs.map((r) => r.minX)),
  minY: Math.min(...rs.map((r) => r.minY)),
  maxX: Math.max(...rs.map((r) => r.maxX)),
  maxY: Math.max(...rs.map((r) => r.maxY)),
})

function moveBatch(
  scene: Scene,
  moves: Map<string, Delta>,
  els: Element[],
  label: string,
  mayEdit?: (el: Element) => boolean,
): Batch | null {
  const ops: Op[] = []
  const moved = new Map<string, Record<string, unknown>>()
  for (const el of els) {
    const d = moves.get(el.id)
    if (!d) continue
    const set: Record<string, unknown> = {}
    if (Math.abs(d.dx) > 1e-9) set.x = hundredth(el.x + d.dx)
    if (Math.abs(d.dy) > 1e-9) set.y = hundredth(el.y + d.dy)
    if (Object.keys(set).length === 0) continue
    ops.push({ op: 'patch', id: el.id, set })
    moved.set(el.id, set)
  }
  if (ops.length === 0) return null
  ops.push(...rerouteArrows(scene, moved, mayEdit).ops)
  return { batchId: newId(), label, ops }
}

export function alignBatch(
  scene: Scene,
  els: Element[],
  to: AlignTo,
  o: Opts = {},
): Batch | null {
  const items = boxes(els)
  const u = union(items.map((i) => i.b))
  const moves = new Map<string, Delta>()
  for (const { el, b } of items) {
    const d = { dx: 0, dy: 0 }
    if (to === 'left') d.dx = u.minX - b.minX
    else if (to === 'right') d.dx = u.maxX - b.maxX
    else if (to === 'centre')
      d.dx = (u.minX + u.maxX) / 2 - (b.minX + b.maxX) / 2
    else if (to === 'top') d.dy = u.minY - b.minY
    else if (to === 'bottom') d.dy = u.maxY - b.maxY
    else d.dy = (u.minY + u.maxY) / 2 - (b.minY + b.maxY) / 2
    moves.set(el.id, d)
  }
  return moveBatch(scene, moves, els, `Align ${to}`, o.mayEdit)
}

/** Equal gaps between neighbours along an axis, the two outermost staying where they are. Needs three. */
export function distributeBatch(
  scene: Scene,
  els: Element[],
  axis: 'horizontal' | 'vertical',
  o: Opts = {},
): Batch | null {
  if (els.length < 3) return null
  const h = axis === 'horizontal'
  const lo = (r: Rect) => (h ? r.minX : r.minY)
  const hi = (r: Rect) => (h ? r.maxX : r.maxY)
  const items = boxes(els).sort(
    (p, q) => lo(p.b) - lo(q.b) || (p.el.id < q.el.id ? -1 : 1),
  )
  const first = items[0]
  const last = items[items.length - 1]
  if (!first || !last) return null
  const sizes = items.reduce((n, i) => n + (hi(i.b) - lo(i.b)), 0)
  const gap = (hi(last.b) - lo(first.b) - sizes) / (items.length - 1)
  const moves = new Map<string, Delta>()
  let cursor = lo(first.b)
  for (const { el, b } of items) {
    const d = cursor - lo(b)
    moves.set(el.id, h ? { dx: d, dy: 0 } : { dx: 0, dy: d })
    cursor += hi(b) - lo(b) + gap
  }
  return moveBatch(scene, moves, els, `Distribute ${axis}`, o.mayEdit)
}

/** One after another in a row or a column, in the order they are now, `gap` apart, from where the first one is. */
export function stackBatch(
  scene: Scene,
  els: Element[],
  direction: 'row' | 'column',
  gap = 24,
  align: 'start' | 'centre' | 'end' = 'start',
  o: Opts = {},
): Batch | null {
  const row = direction === 'row'
  const main = (r: Rect): [number, number] =>
    row ? [r.minX, r.maxX] : [r.minY, r.maxY]
  const cross = (r: Rect): [number, number] =>
    row ? [r.minY, r.maxY] : [r.minX, r.maxX]
  const items = boxes(els).sort(
    (p, q) => main(p.b)[0] - main(q.b)[0] || (p.el.id < q.el.id ? -1 : 1),
  )
  const first = items[0]
  if (!first) return null
  const [cLo, cHi] = cross(union(items.map((i) => i.b)))
  const moves = new Map<string, Delta>()
  let cursor = main(first.b)[0]
  for (const { el, b } of items) {
    const [mLo, mHi] = main(b)
    const [xLo, xHi] = cross(b)
    const dm = cursor - mLo
    const dc =
      align === 'start'
        ? cLo - xLo
        : align === 'end'
          ? cHi - xHi
          : (cLo + cHi) / 2 - (xLo + xHi) / 2
    moves.set(el.id, row ? { dx: dm, dy: dc } : { dx: dc, dy: dm })
    cursor += mHi - mLo + gap
  }
  return moveBatch(scene, moves, els, `Stack ${direction}`, o.mayEdit)
}
