import { bounds, type Point, type Rect, routeArrow } from './geometry'
import type { SpatialIndex } from './index'
import { inkReach, strokeOutline } from './ink'
import {
  type CanvasLike,
  FONT_STACK,
  type ImageProvider,
  type MathBitmapSource,
  type MathPaths,
  type MathProvider,
  type Platform,
} from './platform'
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

export type CacheTier = 'bucket' | 'original'

/**
 * Bitmaps for expensive elements (text, math, images), keyed (zoomBucket, id, v).
 * Bitmaps over MAX_BITMAP px a side or larger than `cap` are drawn directly and never retained.
 */
export class RenderCache {
  // Map insertion order is the LRU order: get() re-inserts, eviction takes 'original' tier first then 'bucket'.
  private m = new Map<
    string,
    { v: number; b: Closable; bytes: number; tier: CacheTier }
  >()
  private total = 0

  constructor(private readonly maxBytes = 1024 * 2 ** 20) {}

  /** Bytes currently held (sum of the `bytes` given to set()). */
  get bytes(): number {
    return this.total
  }

  /** Maximum byte budget configured for this cache. */
  get cap(): number {
    return this.maxBytes
  }

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

  /** `bytes` is the bitmap's memory (w * h * 4); 'original' tier entries are evicted before 'bucket' entries. */
  set(
    bucket: number,
    id: string,
    v: number,
    b: Closable,
    bytes = 0,
    tier: CacheTier = 'bucket',
  ): void {
    const k = `${bucket}|${id}`
    this.drop(k)
    if (bytes > this.maxBytes) return
    this.m.set(k, { v, b, bytes, tier })
    this.total += bytes
    while (this.total > this.maxBytes && this.m.size > 1) {
      let victim: string | undefined
      for (const [key, entry] of this.m) {
        if (key !== k && entry.tier === 'original') {
          victim = key
          break
        }
      }
      if (!victim) {
        for (const key of this.m.keys()) {
          if (key !== k) {
            victim = key
            break
          }
        }
      }
      if (!victim) break
      this.drop(victim)
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
  const bucket = zoomBucket(scale)
  // A hit carries its own size, so a frame that only redraws cached bitmaps never lays text out.
  let bmp = cache?.get<TextBitmap>(bucket, el.id, el.v)
  if (!bmp) {
    const { lines, width, height } = layoutText(el, platform)
    const pw = Math.ceil(width * bucket)
    const ph = Math.ceil(height * bucket)
    if (pw < 1 || ph < 1 || pw > MAX_BITMAP || ph > MAX_BITMAP || !cache) {
      ctx.save()
      ctx.translate(el.x, el.y)
      drawLines(ctx, el, lines, platform)
      ctx.restore()
      return
    }
    const canvas = platform.createCanvas(pw, ph)
    const c = canvas.getContext('2d') as CanvasRenderingContext2D
    c.scale(bucket, bucket)
    drawLines(c, el, lines, platform)
    // Browser: freeze the pixels into an ImageBitmap (what S1 measured). It draws faster than an OffscreenCanvas
    // source; Node canvases have no such method and are drawn as they are.
    const frozen = (
      canvas as { transferToImageBitmap?: () => ImageBitmap }
    ).transferToImageBitmap?.()
    bmp = {
      canvas: frozen ?? canvas,
      pw,
      ph,
      close() {
        if (frozen) frozen.close()
        else {
          canvas.width = 0
          canvas.height = 0
        }
      },
    }
    const byteSize = pw * ph * 4
    cache.set(bucket, el.id, el.v, bmp, byteSize)
    ctx.drawImage(
      bmp.canvas as unknown as CanvasImageSource,
      el.x,
      el.y,
      bmp.pw / bucket,
      bmp.ph / bucket,
    )
    if (byteSize > cache.cap) bmp.close()
    return
  }
  ctx.drawImage(
    bmp.canvas as unknown as CanvasImageSource,
    el.x,
    el.y,
    bmp.pw / bucket,
    bmp.ph / bucket,
  )
}
type TextBitmap = {
  canvas: CanvasLike | ImageBitmap
  pw: number
  ph: number
  close(): void
}

type MathEl = Element & { type: 'math' }
type MathBitmap = {
  bmp: MathBitmapSource
  dx: number
  dy: number
  dw: number
  dh: number
  close(): void
}

const mathPending = new WeakMap<MathProvider, Set<string>>()

function drawPlaceholder(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  scale: number,
  label?: string,
  platform?: Platform,
) {
  ctx.save()
  ctx.fillStyle = 'rgba(148, 163, 184, 0.12)'
  ctx.fillRect(x, y, w, h)
  ctx.strokeStyle = '#64748b'
  ctx.lineWidth = Math.max(1 / scale, 1)
  ctx.setLineDash([4 / scale, 4 / scale])
  ctx.strokeRect(x, y, w, h)
  if (label && platform) {
    const fontSize = Math.min(14, Math.max(8, Math.min(w, h) * 0.22))
    ctx.font = `${fontSize}px ${FONT_STACK}`
    ctx.fillStyle = '#475569'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(label, x + w / 2, y + h / 2)
  }
  ctx.restore()
}

function drawVectorMath(
  ctx: CanvasRenderingContext2D,
  mp: MathPaths,
  x: number,
  y: number,
  w: number,
  h: number,
  color: string,
  platform: Platform,
) {
  const [vx, vy, vw, vh] = mp.viewBox
  if (vw <= 0 || vh <= 0) return
  ctx.save()
  ctx.translate(x, y)
  ctx.scale(w / vw, h / vh)
  ctx.translate(-vx, -vy)
  for (const item of mp.items) {
    ctx.save()
    const [a, b, c, d, e, f] = item.m
    ctx.transform(a, b, c, d, e, f)
    ctx.fillStyle = item.fill === 'currentColor' ? color : item.fill
    ctx.fill(platform.createPath2D(item.d))
    ctx.restore()
  }
  ctx.restore()
}

function drawMathError(
  ctx: CanvasRenderingContext2D,
  el: MathEl,
  platform: Platform,
  scale: number,
) {
  const { x, y, w, h } = el
  ctx.save()
  ctx.fillStyle = 'rgba(220, 38, 38, 0.08)'
  ctx.fillRect(x, y, w, h)
  ctx.strokeStyle = '#dc2626'
  ctx.lineWidth = Math.max(1 / scale, 1)
  ctx.setLineDash([3 / scale, 3 / scale])
  ctx.strokeRect(x, y, w, h)

  const fontSize = Math.max(10, Math.min(16, el.data.size * 0.6))
  const font = `${fontSize}px ${FONT_STACK}`
  ctx.font = font
  ctx.fillStyle = '#dc2626'
  ctx.textAlign = 'left'
  ctx.textBaseline = 'top'
  ctx.direction = 'ltr'

  const pad = 4
  const maxW = Math.max(8, w - pad * 2)
  const src = el.data.latex
  const lines: string[] = []
  let cur = ''
  for (const ch of src) {
    const next = cur + ch
    if (cur.length > 0 && platform.measureText(font, next) > maxW) {
      lines.push(cur)
      cur = ch
    } else {
      cur = next
    }
  }
  if (cur) lines.push(cur)

  const lh = fontSize * 1.3
  for (let i = 0; i < lines.length; i++) {
    const ly = y + pad + i * lh
    if (ly + fontSize > y + h + 2 && i > 0) break
    ctx.fillText(lines[i] as string, x + pad, ly)
  }
  ctx.restore()
}

function drawMath(
  ctx: CanvasRenderingContext2D,
  el: MathEl,
  platform: Platform,
  scale: number,
  cache?: RenderCache,
) {
  const bucket = zoomBucket(scale)
  const hit = cache?.get<MathBitmap>(bucket, el.id, el.v)
  if (hit) {
    ctx.drawImage(hit.bmp, el.x + hit.dx, el.y + hit.dy, hit.dw, hit.dh)
    return
  }

  const provider = platform.math
  const { latex, display } = el.data
  const color = el.style.stroke
  const rKey = `${display ? 1 : 0}|${color}|${latex}`
  const entry = provider?.peek(latex, display, color)
  if (!entry) {
    drawPlaceholder(ctx, el.x, el.y, el.w, el.h, scale)
    if (provider) {
      let pend = mathPending.get(provider)
      if (!pend) {
        pend = new Set()
        mathPending.set(provider, pend)
      }
      if (!pend.has(rKey)) {
        pend.add(rKey)
        provider.request(latex, display, color, () => {
          pend?.delete(rKey)
        })
      }
    }
    return
  }
  mathPending.get(provider as MathProvider)?.delete(rKey)

  if (!entry.ok) {
    drawMathError(ctx, el, platform, scale)
    return
  }

  const emW = Math.max(1e-6, entry.width)
  const emH = Math.max(1e-6, entry.height + entry.depth)
  const worldPerEm = Math.min(el.w / emW, el.h / emH)
  const dw = emW * worldPerEm
  const dh = emH * worldPerEm
  const dx = (el.w - dw) / 2
  const dy = (el.h - dh) / 2
  const pxPerEm = worldPerEm * bucket
  const pw = Math.max(1, Math.ceil(dw * bucket))
  const ph = Math.max(1, Math.ceil(dh * bucket))
  const bmpW = pw / bucket
  const bmpH = ph / bucket

  if (pw > MAX_BITMAP || ph > MAX_BITMAP) {
    const mp = entry.paths()
    if (mp) {
      drawVectorMath(ctx, mp, el.x + dx, el.y + dy, dw, dh, color, platform)
      return
    }
    const maxEm = Math.max(emW, emH)
    const cappedPxPerEm = Math.max(1, Math.floor(MAX_BITMAP / maxEm))
    const bmp = entry.bitmapFor(cappedPxPerEm)
    if (bmp) {
      ctx.drawImage(bmp, el.x + dx, el.y + dy, dw, dh)
      bmp.close?.()
    }
    return
  }

  const bmp = entry.bitmapFor(pxPerEm)
  if (!bmp) {
    const mp = entry.paths()
    if (mp) {
      drawVectorMath(ctx, mp, el.x + dx, el.y + dy, dw, dh, color, platform)
    } else {
      drawPlaceholder(ctx, el.x, el.y, el.w, el.h, scale)
    }
    return
  }

  if (cache) {
    const item: MathBitmap = {
      bmp,
      dx,
      dy,
      dw: bmpW,
      dh: bmpH,
      close() {
        bmp.close?.()
      },
    }
    const byteSize = pw * ph * 4
    cache.set(bucket, el.id, el.v, item, byteSize)
    ctx.drawImage(bmp, el.x + dx, el.y + dy, bmpW, bmpH)
    if (byteSize > cache.cap) item.close()
    return
  }
  ctx.drawImage(bmp, el.x + dx, el.y + dy, bmpW, bmpH)
}

type ImageEl = Element & { type: 'image' }
type ImageBucketBitmap = {
  bmp: CanvasImageSource
  close(): void
}

const imagePending = new WeakMap<ImageProvider, Set<string>>()

function drawImage(
  ctx: CanvasRenderingContext2D,
  el: ImageEl,
  platform: Platform,
  scale: number,
  cache?: RenderCache,
) {
  const provider = platform.images
  const { blobId, naturalW, naturalH, crop } = el.data
  const sx = crop ? crop.x : 0
  const sy = crop ? crop.y : 0
  const sw = crop ? crop.w : naturalW
  const sh = crop ? crop.h : naturalH
  if (sw <= 0 || sh <= 0) return

  const ratio = Math.max((el.w * scale) / sw, (el.h * scale) / sh)
  const bucket = zoomBucket(ratio)
  const cropKey = crop ? `${crop.x},${crop.y},${crop.w},${crop.h}` : 'full'
  const cacheId = `img:${blobId}:${cropKey}`

  // The bucket copy first: originals share the cache and are evicted before buckets, so once a copy exists the
  // original is not needed at all (peeking it first re-decoded it every frame when two photos did not fit the cap).
  if (bucket < 1 && cache) {
    const hit = cache.get<ImageBucketBitmap>(bucket, cacheId, 0)
    if (hit) {
      ctx.drawImage(hit.bmp, el.x, el.y, el.w, el.h)
      return
    }
  }

  const entry = provider?.peek(blobId)
  if (entry === undefined) {
    drawPlaceholder(ctx, el.x, el.y, el.w, el.h, scale)
    if (provider) {
      let pend = imagePending.get(provider)
      if (!pend) {
        pend = new Set()
        imagePending.set(provider, pend)
      }
      if (!pend.has(blobId)) {
        pend.add(blobId)
        provider.request(blobId, () => {
          pend?.delete(blobId)
        })
      }
    }
    return
  }
  imagePending.get(provider as ImageProvider)?.delete(blobId)

  if (entry === 'missing') {
    drawPlaceholder(
      ctx,
      el.x,
      el.y,
      el.w,
      el.h,
      scale,
      'missing image',
      platform,
    )
    return
  }

  // Zoom-in or 1:1 with source draws the original bitmap directly
  if (bucket >= 1 || !cache) {
    ctx.drawImage(entry.bitmap, sx, sy, sw, sh, el.x, el.y, el.w, el.h)
    return
  }

  const bw = Math.max(1, Math.ceil(sw * bucket))
  const bh = Math.max(1, Math.ceil(sh * bucket))
  if (bw > MAX_BITMAP || bh > MAX_BITMAP) {
    ctx.drawImage(entry.bitmap, sx, sy, sw, sh, el.x, el.y, el.w, el.h)
    return
  }
  const c = platform.createCanvas(bw, bh)
  const g = c.getContext('2d') as CanvasRenderingContext2D
  g.imageSmoothingEnabled = true
  g.imageSmoothingQuality = 'high'
  g.drawImage(entry.bitmap, sx, sy, sw, sh, 0, 0, bw, bh)
  const frozen = (
    c as { transferToImageBitmap?: () => ImageBitmap }
  ).transferToImageBitmap?.()
  const made: ImageBucketBitmap = {
    bmp: (frozen ?? c) as unknown as CanvasImageSource,
    close() {
      if (frozen) frozen.close()
      else {
        c.width = 0
        c.height = 0
      }
    },
  }
  const byteSize = bw * bh * 4
  cache.set(bucket, cacheId, 0, made, byteSize, 'bucket')
  ctx.drawImage(made.bmp, el.x, el.y, el.w, el.h)
  if (byteSize > cache.cap) made.close()
}

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
  if (el.type === 'freehand') {
    // the outline in world units, so a zoom change reuses it
    const { points, pressure, smoothing, highlighter } = el.data
    return strokeOutline(
      points.map(([px, py]) => [x + px, y + py]),
      pressure,
      { size: el.style.strokeWidth, smoothing, highlighter },
      platform,
    )
  }
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

/** Turns the context about the element's box centre (text, math, image, strokes and closed shapes rotate this way). */
function rotateAbout(ctx: CanvasRenderingContext2D, el: Element) {
  const cx = el.x + el.w / 2
  const cy = el.y + el.h / 2
  ctx.translate(cx, cy)
  ctx.rotate(el.rotation)
  ctx.translate(-cx, -cy)
}

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
  ctx.globalAlpha = 1
  ctx.setLineDash([])

  const view: Rect = {
    minX: camera.x,
    minY: camera.y,
    maxX: camera.x + width / camera.zoom,
    maxY: camera.y + height / camera.zoom,
  }
  // ponytail: the linear scan is O(n) per frame; keep a separate index of lines/arrows if that ever shows in profiles.
  const found = opts.index
    ? opts.index.search(inflate(view, MAX_STROKE_PAD))
    : ordered(scene)
  const closed: Element[] = []
  for (const f of found) {
    const el = opts.index ? scene.els.get(f.id) : f
    if (!el || isLinear(el)) continue
    // Unrotated boxes (almost all of them) skip bounds(), which allocates four rotated corners.
    const box = el.rotation
      ? bounds(el)
      : { minX: el.x, minY: el.y, maxX: el.x + el.w, maxY: el.y + el.h }
    // bounds() of a stroke already carries its ink reach (it is padded for the index too)
    const pad =
      el.type === 'freehand'
        ? el.rotation
          ? 0
          : inkReach(el)
        : el.style.strokeWidth / 2
    if (intersects(inflate(box, pad), view)) closed.push(el)
  }
  // Every line is tested (a bound arrow's routed path can be anywhere). Z order is restored by the sort below, so no
  // pre-sort of the whole scene here.
  const linear: Element[] = []
  for (const el of scene.els.values())
    if (isLinear(el) && intersects(linearRect(el, scene), view)) linear.push(el)
  const visible = [...closed, ...linear].sort((a, b) =>
    a.z < b.z ? -1 : a.z > b.z ? 1 : a.id < b.id ? -1 : 1,
  )

  let drawn = 0
  for (const el of visible) {
    // save/restore (and the dash array) only for elements that change alpha, dash or transform: at 5,000 elements
    // they cost about a third of a frame's JS time (task 12). Plain elements set every style they use.
    if (el.type === 'text' || el.type === 'math' || el.type === 'image') {
      const state = el.rotation !== 0 || el.style.opacity !== 1
      if (state) {
        ctx.save()
        ctx.globalAlpha = el.style.opacity
        if (el.rotation) rotateAbout(ctx, el)
      }
      if (el.type === 'text') drawText(ctx, el, platform, s, opts.cache)
      else if (el.type === 'math') drawMath(ctx, el, platform, s, opts.cache)
      else drawImage(ctx, el, platform, s, opts.cache)
      if (state) ctx.restore()
      drawn++
      continue
    }
    if (el.type === 'freehand') {
      // Ink is a filled outline in the stroke colour (never stroked, style.fill is ignored). A highlighter multiplies, so
      // it always takes the save/restore: the composite operation must not reach the elements above it.
      const { opacity } = el.style
      const state = el.rotation !== 0 || opacity !== 1 || el.data.highlighter
      if (state) {
        ctx.save()
        ctx.globalAlpha = opacity
        if (el.rotation) rotateAbout(ctx, el)
        if (el.data.highlighter) ctx.globalCompositeOperation = 'multiply'
      }
      ctx.fillStyle = el.style.stroke
      ctx.fill(pathOf(el, scene, platform))
      if (state) ctx.restore()
      drawn++
      continue
    }
    const path = pathOf(el, scene, platform)
    const { stroke, fill, strokeWidth, opacity, dash } = el.style
    const line = isLinear(el)
    const rotated = el.rotation !== 0 && !line
    const state = rotated || opacity !== 1 || dash !== 'solid'
    if (state) {
      ctx.save()
      ctx.globalAlpha = opacity
      if (rotated) rotateAbout(ctx, el)
    }
    if (fill && !line) {
      ctx.fillStyle = fill
      ctx.fill(path)
    }
    if (strokeWidth > 0) {
      ctx.lineWidth = strokeWidth
      ctx.strokeStyle = stroke
      if (dash !== 'solid')
        ctx.setLineDash(
          dash === 'dashed'
            ? [strokeWidth * 4, strokeWidth * 3]
            : [strokeWidth, strokeWidth * 2],
        )
      ctx.stroke(path)
    }
    if (state) ctx.restore()
    drawn++
  }
  return { drawn, culled: scene.els.size - visible.length }
}
