import { z } from 'zod'
import { bounds, type Rect } from '../geometry'
import type { ToolCtx } from './registry'
import { ToolError } from './registry'

export const PlacementSchema = z
  .union([
    z.literal('auto'),
    z.object({ x: z.number(), y: z.number() }),
    z.object({
      relativeTo: z.string().min(1),
      side: z.enum(['right', 'left', 'above', 'below']),
      gap: z.number().min(0).max(500).optional(),
    }),
  ])
  .describe(
    'Where to put it: "auto" (nearest free space to the selection, else the visible area), {x,y} for the top-left corner, or {relativeTo: elementId, side, gap}.',
  )
export type Placement = z.infer<typeof PlacementSchema>

const PAD = 16 // breathing room kept between a new element and its neighbours
const STEP = 40 // search granularity for "auto"

const hit = (a: Rect, b: Rect, pad = 0) =>
  a.minX < b.maxX + pad &&
  a.maxX > b.minX - pad &&
  a.minY < b.maxY + pad &&
  a.maxY > b.minY - pad
const rectAt = (x: number, y: number, w: number, h: number): Rect => ({
  minX: x,
  minY: y,
  maxX: x + w,
  maxY: y + h,
})
const union = (rs: Rect[]): Rect | null =>
  rs.length === 0
    ? null
    : {
        minX: Math.min(...rs.map((r) => r.minX)),
        minY: Math.min(...rs.map((r) => r.minY)),
        maxX: Math.max(...rs.map((r) => r.maxX)),
        maxY: Math.max(...rs.map((r) => r.maxY)),
      }

/**
 * The top-left corner for a new element of `size`. `taken` are rectangles reserved earlier in the same batch.
 * Absolute placement is honoured exactly. Relative placement slides along its side until it is clear. "auto" looks for the
 * free spot nearest to the selection (else the visible area, else the right edge of the content).
 * ponytail: a ring scan over every element's bounds; build a SpatialIndex query if boards with thousands of elements make it slow.
 */
export function resolvePlacement(
  p: Placement | undefined,
  size: { w: number; h: number },
  ctx: ToolCtx,
  taken: Rect[] = [],
): { x: number; y: number } {
  const all = [...ctx.scene.els.values()]
  const rects = [...all.map(bounds), ...taken]
  const clear = (x: number, y: number) => {
    const r = rectAt(x, y, size.w, size.h)
    return !rects.some((o) => hit(r, o, PAD))
  }
  if (p && p !== 'auto' && 'x' in p) return { x: p.x, y: p.y }

  if (p && p !== 'auto' && 'relativeTo' in p) {
    const base = ctx.scene.els.get(p.relativeTo)
    if (!base)
      throw new ToolError(
        `placement.relativeTo: no element ${p.relativeTo} on the board`,
        'placement.relativeTo',
      )
    const b = bounds(base)
    const gap = p.gap ?? 24
    const cx = (b.minX + b.maxX) / 2
    const cy = (b.minY + b.maxY) / 2
    const at = (extra: number) => {
      switch (p.side) {
        case 'right':
          return { x: b.maxX + gap + extra, y: cy - size.h / 2 }
        case 'left':
          return { x: b.minX - gap - size.w - extra, y: cy - size.h / 2 }
        case 'below':
          return { x: cx - size.w / 2, y: b.maxY + gap + extra }
        case 'above':
          return { x: cx - size.w / 2, y: b.minY - gap - size.h - extra }
      }
    }
    const along = p.side === 'right' || p.side === 'left' ? size.w : size.h
    for (let i = 0; i < 20; i++) {
      const c = at(i * (along / 2 + PAD))
      if (clear(c.x, c.y)) return c
    }
    return at(0)
  }

  // auto
  const sel = ctx.selection.flatMap((id) => {
    const el = ctx.scene.els.get(id)
    return el ? [bounds(el)] : []
  })
  const content = union(all.map(bounds))
  const view =
    ctx.viewport &&
    rectAt(ctx.viewport.x, ctx.viewport.y, ctx.viewport.w, ctx.viewport.h)
  const anchorRect = union(sel) ?? view ?? content
  const ax = anchorRect ? (anchorRect.minX + anchorRect.maxX) / 2 : 0
  const ay = anchorRect ? (anchorRect.minY + anchorRect.maxY) / 2 : 0
  const cands: { x: number; y: number; d: number }[] = []
  for (let ring = 0; ring <= 40; ring++)
    for (let i = -ring; i <= ring; i++)
      for (const [dx, dy] of ring === 0
        ? [[0, 0]]
        : [
            [i, -ring],
            [i, ring],
            [-ring, i],
            [ring, i],
          ]) {
        const x = ax - size.w / 2 + (dx as number) * STEP
        const y = ay - size.h / 2 + (dy as number) * STEP
        cands.push({
          x,
          y,
          d: Math.hypot((dx as number) * STEP, (dy as number) * STEP),
        })
      }
  cands.sort((a, b) => a.d - b.d)
  const inView = (c: { x: number; y: number }) =>
    !view ||
    (c.x >= view.minX &&
      c.y >= view.minY &&
      c.x + size.w <= view.maxX &&
      c.y + size.h <= view.maxY)
  const found =
    cands.find((c) => inView(c) && clear(c.x, c.y)) ??
    cands.find((c) => clear(c.x, c.y))
  if (found) return { x: found.x, y: found.y }
  return { x: (content?.maxX ?? 0) + 80, y: content?.minY ?? 0 }
}

export const rectOf = rectAt
