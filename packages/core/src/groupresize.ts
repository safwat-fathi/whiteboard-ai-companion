import { bounds, type Handle, type Patch, type Point } from './geometry'
import type { Platform } from './platform'
import type { Element, Id } from './schema'
import { layoutText } from './text'

const MIN = 1
const hundredth = (n: number) => Math.round(n * 100) / 100
const tenth = (n: number) => Math.round(n * 10) / 10 + 0

/**
 * Resizing several elements at once (R12): the selection's box is dragged by `handle` to `to`, the opposite edge or corner
 * stays, and every member is scaled with it by its type. Returns each member's patch (one batch for the caller to build), or
 * null for one element, a locked member, or a drag that changes nothing. Rotated members scale about their own centre as if
 * unrotated (an approximation).
 */
export function resizeGroup(
  els: Element[],
  handle: Handle,
  to: Point,
  keepAspect: boolean,
  platform: Platform,
): Map<Id, Patch> | null {
  if (els.length < 2 || els.some((e) => e.locked)) return null
  const bs = els.map(bounds)
  const b = {
    minX: Math.min(...bs.map((r) => r.minX)),
    minY: Math.min(...bs.map((r) => r.minY)),
    maxX: Math.max(...bs.map((r) => r.maxX)),
    maxY: Math.max(...bs.map((r) => r.maxY)),
  }
  const w0 = b.maxX - b.minX
  const h0 = b.maxY - b.minY
  if (w0 <= 0 || h0 <= 0) return null
  let left = b.minX
  let right = b.maxX
  let top = b.minY
  let bottom = b.maxY
  if (handle.includes('w')) left = Math.min(to.x, right - MIN)
  if (handle.includes('e')) right = Math.max(to.x, left + MIN)
  if (handle.includes('n')) top = Math.min(to.y, bottom - MIN)
  if (handle.includes('s')) bottom = Math.max(to.y, top + MIN)
  let sx = (right - left) / w0
  let sy = (bottom - top) / h0
  if (keepAspect && handle.length === 2) {
    const s = Math.max(sx, sy)
    sx = s
    sy = s
    if (handle.includes('w')) left = right - w0 * s
    else right = left + w0 * s
    if (handle.includes('n')) top = bottom - h0 * s
    else bottom = top + h0 * s
  }
  if (sx === 1 && sy === 1 && left === b.minX && top === b.minY) return null
  const s = Math.min(sx, sy)
  const X = (x: number) => hundredth(left + (x - b.minX) * sx)
  const Y = (y: number) => hundredth(top + (y - b.minY) * sy)
  const out = new Map<Id, Patch>()
  for (const el of els) {
    const p: Patch = { x: X(el.x), y: Y(el.y) }
    if (el.type === 'shape') {
      p.w = hundredth(el.w * sx)
      p.h = hundredth(el.h * sy)
      if (el.data.points)
        p['data.points'] = el.data.points.map(([a, c]) => [
          hundredth(a * sx),
          hundredth(c * sy),
        ])
    } else if (el.type === 'freehand') {
      p.w = tenth(el.w * sx)
      p.h = tenth(el.h * sy)
      p['data.points'] = el.data.points.map(([a, c]) => [
        tenth(a * sx),
        tenth(c * sy),
      ])
    } else if (el.type === 'text') {
      const size = Math.max(1, Math.min(1000, Math.round(el.data.size * s)))
      const data = {
        ...el.data,
        size,
        ...(el.data.maxWidth
          ? { maxWidth: hundredth(el.data.maxWidth * sx) }
          : {}),
      }
      const lay = layoutText({ ...el, data }, platform)
      p['data.size'] = size
      if (el.data.maxWidth) p['data.maxWidth'] = data.maxWidth
      p.w = lay.width
      p.h = lay.height
    } else if (el.type === 'math') {
      p['data.size'] = Math.max(8, Math.min(1000, Math.round(el.data.size * s)))
      p.w = hundredth(el.w * s)
      p.h = hundredth(el.h * s)
    } else {
      // image, chart: keep the aspect ratio
      p.w = hundredth(el.w * s)
      p.h = hundredth(el.h * s)
    }
    out.set(el.id, p)
  }
  return out
}
