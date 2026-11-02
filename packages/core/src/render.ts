import { bounds, type Point, type Rect, routeArrow } from './geometry'
import type { SpatialIndex } from './index'
import { type CanvasLike, FONT_STACK, type Platform } from './platform'
import { ordered, type Scene } from './scene'
import {
  type Camera,
  type Element,
  type Viewport,
  ZOOM_MAX,
  ZOOM_MIN,
} from './schema'
import { layoutText } from './text'

export type RenderStats = { drawn: number; culled: number }

// Camera convention: (x, y) is the world point at the viewport's top-left (S1 used the centre; this differs deliberately),
// zoom is CSS px per world unit.
export const worldToScreen = (
  p: Point,
  c: Camera,
  _viewport: Viewport,
): Point => ({
  x: (p.x - c.x) * c.zoom,
  y: (p.y - c.y) * c.zoom,
})
export const screenToWorld = (
  p: Point,
  c: Camera,
  _viewport: Viewport,
): Point => ({
  x: p.x / c.zoom + c.x,
  y: p.y / c.zoom + c.y,
})

/** Zooms by `factor` (clamped to ZOOM_MIN..ZOOM_MAX) keeping the world point under `screenPoint` (CSS px) fixed. */
export function zoomAt(c: Camera, screenPoint: Point, factor: number): Camera {
  if (!Number.isFinite(factor) || factor <= 0) return c
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
 * Text is the only user so far; bitmaps over MAX_BITMAP px a side are drawn directly, never cached.
 */
export class RenderCache {
  // Map insertion order is the LRU order: get() re-inserts, eviction takes the first entry.
  private m = new Map<string, { v: number; b: Closable; bytes: number }>()
  private total = 0

  constructor(private readonly maxBytes = 256 * 2 ** 20) {}

  get<B extends Closable>(
    bucket: number,
    id: string,
    v: number,
  ): B | undefined {
    const k = `${bucket}|${id}`
    const e = this.m.get(k)
    if (e?.v !== v) return undefined
    this.m.delete(k)
    this.m.set(k, e)
    return e.b as B
  }

  /** `bytes` is the bitmap's memory (w * h * 4); the least recently used entries are closed once the cap is exceeded. */
  set(bucket: number, id: string, v: number, b: Closable, bytes = 0): void {
    const k = `${bucket}|${id}`
    this.drop(k)
    this.m.set(k, { v, b, bytes })
    this.total += bytes
    for (const old of this.m.keys()) {
      if (this.total <= this.maxBytes || this.m.size <= 1) break
      this.drop(old)
    }
  }

  private drop(k: string): void {
    const e = this.m.get(k)
    if (!e) return
    e.b.close()
    this.total -= e.bytes
    this.m.delete(k)
  }

  dispose(): void {
    for (const e of this.m.values()) e.b.close()
    this.m.clear()
    this.total = 0
  }
}

const MAX_BITMAP = 4096

type TextEl = Element & { type: 'text' }

const metrics = new WeakMap<
  Platform,
  Map<string, { ascent: number; descent: number } | null>
>()
function fontMetrics(platform: Platform, font: string) {
  let m = metrics.get(platform)
  if (!m) {
    m = new Map()
    metrics.set(platform, m)
  }
  if (!m.has(font)) m.set(font, platform.fontMetrics?.(font) ?? null)
  return m.get(font) ?? null
}

function drawLines(
  ctx: CanvasRenderingContext2D,
  el: TextEl,
  lines: ReturnType<typeof layoutText>['lines'],
  platform: Platform,
) {
  const { size } = el.data
  ctx.font = `${size}px ${FONT_STACK}`
  // Same baseline as a CSS line box: the font's content area (ascent + descent) centred in the 1.4 line.
  const fm = fontMetrics(platform, `${size}px ${FONT_STACK}`)
  const lh = size * 1.4
  ctx.fillStyle = el.style.stroke // text colour is the style's stroke
  ctx.textAlign = 'left' // line.x is the visual left edge, whatever the direction
  ctx.textBaseline = fm ? 'alphabetic' : 'middle'
  for (const l of lines) {
    ctx.direction = l.dir
    ctx.fillText(
      l.text,
      l.x,
      l.y + (fm ? (lh - (fm.ascent + fm.descent)) / 2 + fm.ascent : lh / 2),
    )
  }
}

/** Draws a text element at its origin (the caller has set the world transform, alpha and rotation). */
function drawText(
  ctx: CanvasRenderingContext2D,
  el: TextEl,
  platform: Platform,
  scale: number,
  cache?: RenderCache,
) {
  const { lines, width, height } = layoutText(el, platform)
  const bucket = zoomBucket(scale)
  const pw = Math.ceil(width * bucket)
  const ph = Math.ceil(height * bucket)
  if (pw < 1 || ph < 1 || pw > MAX_BITMAP || ph > MAX_BITMAP || !cache) {
    ctx.save()
    ctx.translate(el.x, el.y)
    drawLines(ctx, el, lines, platform)
    ctx.restore()
    return
  }
  let bmp = cache.get<TextBitmap>(bucket, el.id, el.v)
  if (!bmp) {
    const canvas = platform.createCanvas(pw, ph)
    const c = canvas.getContext('2d') as CanvasRenderingContext2D
    c.scale(bucket, bucket)
    drawLines(c, el, lines, platform)
    bmp = {
      canvas,
      close() {
        canvas.width = 0
        canvas.height = 0
      },
    }
    cache.set(bucket, el.id, el.v, bmp, pw * ph * 4)
  }
  ctx.drawImage(
    bmp.canvas as unknown as CanvasImageSource,
    el.x,
    el.y,
    pw / bucket,
    ph / bucket,
  )
}
type TextBitmap = { canvas: CanvasLike; close(): void }

// Geometry in world space, built once per element object (elements are replaced, never mutated). Keyed per platform
// because a Path2D from one platform's constructor is not valid on another's context.
const paths = new WeakMap<Platform, WeakMap<Element, Path2D>>()

const HEAD = 12
const headSize = (el: Element) => Math.max(HEAD, el.style.strokeWidth * 4)
function arrowHead(p: Path2D, tip: Point, from: Point, size: number) {
  const a = Math.atan2(tip.y - from.y, tip.x - from.x)
  for (const d of [2.6, -2.6]) {
    p.moveTo(tip.x, tip.y)
    p.lineTo(tip.x + size * Math.cos(a + d), tip.y + size * Math.sin(a + d))
  }
}

function build(el: Element, scene: Scene, platform: Platform): Path2D {
  const { x, y, w, h } = el
  const p = platform.createPath2D()
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
    const size = headSize(el)
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

const isBound = (el: Element) =>
  el.type === 'shape' && (el.data.start || el.data.end)

function pathOf(el: Element, scene: Scene, platform: Platform): Path2D {
  if (isBound(el)) return build(el, scene, platform) // follows its targets, so never cached
  let m = paths.get(platform)
  if (!m) {
    m = new WeakMap()
    paths.set(platform, m)
  }
  const hit = m.get(el)
  if (hit) return hit
  const p = build(el, scene, platform)
  m.set(el, p)
  return p
}

const inflate = (r: Rect, d: number): Rect => ({
  minX: r.minX - d,
  minY: r.minY - d,
  maxX: r.maxX + d,
  maxY: r.maxY + d,
})

// Stroke and arrowheads reach past bounds(), and a bound arrow's routed points differ from its stored ones, so
// lines/arrows are culled here by their routed points plus stroke and head extent.
function linearRect(el: Element, scene: Scene): Rect {
  const pts = routeArrow(el, scene).map(([px, py]) => ({
    x: el.x + px,
    y: el.y + py,
  }))
  if (!pts.length) pts.push({ x: el.x, y: el.y })
  const xs = pts.map((p) => p.x)
  const ys = pts.map((p) => p.y)
  const r = {
    minX: Math.min(...xs),
    minY: Math.min(...ys),
    maxX: Math.max(...xs),
    maxY: Math.max(...ys),
  }
  return inflate(r, el.style.strokeWidth / 2 + headSize(el))
}

// Max stroke is 100, so strokeWidth / 2 <= 50 for the index query.
const MAX_STROKE_PAD = 50

const intersects = (a: Rect, b: Rect) =>
  a.minX <= b.maxX && a.maxX >= b.minX && a.minY <= b.maxY && a.maxY >= b.minY

/** Draws the scene's shapes in z order. Pure given its inputs: it repaints the whole viewport on a white background. */
export function render(
  ctx: CanvasRenderingContext2D,
  scene: Scene,
  camera: Camera,
  viewport: Viewport,
  platform: Platform,
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
  // ponytail: the linear scan is O(n) per frame; keep a separate index of lines/arrows if that ever shows in profiles.
  const closed = (
    opts.index
      ? opts.index
          .search(inflate(view, MAX_STROKE_PAD))
          .flatMap((f) => scene.els.get(f.id) ?? [])
      : ordered(scene)
  ).filter(
    (el) =>
      !isLinear(el) &&
      intersects(inflate(bounds(el), el.style.strokeWidth / 2), view),
  )
  const linear = ordered(scene).filter(
    (el) => isLinear(el) && intersects(linearRect(el, scene), view),
  )
  const visible = [...closed, ...linear].sort((a, b) =>
    a.z < b.z ? -1 : a.z > b.z ? 1 : a.id < b.id ? -1 : 1,
  )

  let drawn = 0
  for (const el of visible) {
    if (el.type === 'text') {
      ctx.save()
      ctx.globalAlpha = el.style.opacity
      if (el.rotation) {
        const cx = el.x + el.w / 2
        const cy = el.y + el.h / 2
        ctx.translate(cx, cy)
        ctx.rotate(el.rotation)
        ctx.translate(-cx, -cy)
      }
      drawText(ctx, el, platform, s, opts.cache)
      ctx.restore()
      drawn++
      continue
    }
    const path = pathOf(el, scene, platform)
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
