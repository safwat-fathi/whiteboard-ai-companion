import { bounds, type Point, type Rect, routeArrow } from './geometry'
import type { SpatialIndex } from './index'
import type { Platform } from './platform'
import { ordered, type Scene } from './scene'
import {
  type Camera,
  type Element,
  type Viewport,
  ZOOM_MAX,
  ZOOM_MIN,
} from './schema'

export type RenderStats = { drawn: number; culled: number }

// Camera convention: (x, y) is the world point at the viewport's top-left; zoom is CSS px per world unit.
export const worldToScreen = (p: Point, c: Camera, _vp: Viewport): Point => ({
  x: (p.x - c.x) * c.zoom,
  y: (p.y - c.y) * c.zoom,
})
export const screenToWorld = (p: Point, c: Camera, _vp: Viewport): Point => ({
  x: p.x / c.zoom + c.x,
  y: p.y / c.zoom + c.y,
})

/** Zooms by `factor` (clamped to ZOOM_MIN..ZOOM_MAX) keeping the world point under `screenPoint` (CSS px) fixed. */
export function zoomAt(c: Camera, screenPoint: Point, factor: number): Camera {
  const zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, c.zoom * factor))
  return {
    x: c.x + screenPoint.x * (1 / c.zoom - 1 / zoom),
    y: c.y + screenPoint.y * (1 / c.zoom - 1 / zoom),
    zoom,
  }
}

/** Power of two at or above the zoom, so a cached bitmap is never magnified. */
export const zoomBucket = (zoom: number): number =>
  2 ** Math.ceil(Math.log2(zoom))

type Closable = { close(): void }

/**
 * Bitmaps for expensive elements (text, later math/images), keyed (zoomBucket, id, v).
 * Task 7 fills it; ponytail: bitmaps over 4096 px a side should be drawn directly, not cached.
 */
export class RenderCache {
  private buckets = new Map<number, Map<string, { v: number; b: Closable }>>()

  get<B extends Closable>(
    bucket: number,
    id: string,
    v: number,
  ): B | undefined {
    const e = this.buckets.get(bucket)?.get(id)
    return e?.v === v ? (e.b as B) : undefined
  }

  set(bucket: number, id: string, v: number, b: Closable): void {
    const m = this.buckets.get(bucket) ?? new Map()
    this.buckets.set(bucket, m)
    m.get(id)?.b.close()
    m.set(id, { v, b })
  }

  dispose(): void {
    for (const m of this.buckets.values())
      for (const e of m.values()) e.b.close()
    this.buckets.clear()
  }
}

// Geometry in world space, built once per element object (elements are replaced, never mutated).
const paths = new WeakMap<Element, Path2D>()

const HEAD = 12
function arrowHead(p: Path2D, tip: Point, from: Point, size: number) {
  const a = Math.atan2(tip.y - from.y, tip.x - from.x)
  for (const d of [2.6, -2.6]) {
    p.moveTo(tip.x, tip.y)
    p.lineTo(tip.x + size * Math.cos(a + d), tip.y + size * Math.sin(a + d))
  }
}

function build(el: Element, scene: Scene): Path2D {
  const { x, y, w, h } = el
  const p = new Path2D()
  if (el.type !== 'shape') return p
  const { kind, radius } = el.data
  if (kind === 'line' || kind === 'arrow') {
    const pts = routeArrow(el, scene).map(([px, py]) => ({
      x: x + px,
      y: y + py,
    }))
    const [first, ...rest] = pts
    if (!first) return p
    p.moveTo(first.x, first.y)
    for (const q of rest) p.lineTo(q.x, q.y)
    const heads = el.data.arrowheads ?? { start: false, end: kind === 'arrow' }
    const size = Math.max(HEAD, el.style.strokeWidth * 4)
    const second = pts[1]
    const prev = pts[pts.length - 2]
    const last = pts[pts.length - 1]
    if (heads.start && second) arrowHead(p, first, second, size)
    if (heads.end && prev && last) arrowHead(p, last, prev, size)
  } else if (kind === 'ellipse') {
    p.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, 2 * Math.PI)
  } else if (kind === 'diamond') {
    p.moveTo(x + w / 2, y)
    p.lineTo(x + w, y + h / 2)
    p.lineTo(x + w / 2, y + h)
    p.lineTo(x, y + h / 2)
    p.closePath()
  } else if (kind === 'triangle') {
    p.moveTo(x + w / 2, y)
    p.lineTo(x + w, y + h)
    p.lineTo(x, y + h)
    p.closePath()
  } else if (radius) p.roundRect(x, y, w, h, Math.min(radius, w / 2, h / 2))
  else p.rect(x, y, w, h)
  return p
}

const isLinear = (el: Element) =>
  el.type === 'shape' && (el.data.kind === 'line' || el.data.kind === 'arrow')

function pathOf(el: Element, scene: Scene): Path2D {
  const bound = el.type === 'shape' && (el.data.start || el.data.end)
  if (bound) return build(el, scene) // follows its targets, so never cached
  const hit = paths.get(el)
  if (hit) return hit
  const p = build(el, scene)
  paths.set(el, p)
  return p
}

const intersects = (a: Rect, b: Rect) =>
  a.minX <= b.maxX && a.maxX >= b.minX && a.minY <= b.maxY && a.maxY >= b.minY

/** Draws the scene's shapes in z order. Pure given its inputs: it repaints the whole viewport on a white background. */
export function render(
  ctx: CanvasRenderingContext2D,
  scene: Scene,
  camera: Camera,
  viewport: Viewport,
  _platform: Platform, // used by text drawing (Task 7)
  opts: { index?: SpatialIndex; cache?: RenderCache } = {},
): RenderStats {
  const { width, height, dpr } = viewport
  const s = camera.zoom * dpr
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, width * dpr, height * dpr)
  ctx.setTransform(s, 0, 0, s, -camera.x * s, -camera.y * s)
  ctx.lineJoin = 'round'
  ctx.lineCap = 'round'

  const view: Rect = {
    minX: camera.x,
    minY: camera.y,
    maxX: camera.x + width / camera.zoom,
    maxY: camera.y + height / camera.zoom,
  }
  const visible = (
    opts.index
      ? opts.index.search(view).flatMap((f) => scene.els.get(f.id) ?? [])
      : ordered(scene).filter((el) => intersects(bounds(el), view))
  ).sort((a, b) => (a.z < b.z ? -1 : a.z > b.z ? 1 : a.id < b.id ? -1 : 1))

  let drawn = 0
  for (const el of visible) {
    // text: Task 7 (uses opts.cache and the platform)
    if (el.type !== 'shape') continue
    const path = pathOf(el, scene)
    const { stroke, fill, strokeWidth, opacity, dash } = el.style
    ctx.save()
    ctx.globalAlpha = opacity
    if (el.rotation && !isLinear(el)) {
      const cx = el.x + el.w / 2
      const cy = el.y + el.h / 2
      ctx.translate(cx, cy)
      ctx.rotate(el.rotation)
      ctx.translate(-cx, -cy)
    }
    if (fill && !isLinear(el)) {
      ctx.fillStyle = fill
      ctx.fill(path)
    }
    if (strokeWidth > 0) {
      ctx.lineWidth = strokeWidth
      ctx.strokeStyle = stroke
      ctx.setLineDash(
        dash === 'dashed'
          ? [strokeWidth * 4, strokeWidth * 3]
          : dash === 'dotted'
            ? [strokeWidth, strokeWidth * 2]
            : [],
      )
      ctx.stroke(path)
    }
    ctx.restore()
    drawn++
  }
  return { drawn, culled: scene.els.size - visible.length }
}
