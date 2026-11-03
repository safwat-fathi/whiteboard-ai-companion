import {
  bounds,
  type CanvasLike,
  type Element,
  type Platform,
  type Rect,
  RenderCache,
  render,
  type Scene,
} from '@whiteboard/core'

// Pictures of the board for the tutor (board-context.md "Pictures"): the browser's own renderer, scene only (no handles,
// no overlays), white background. No server round trip, and no dependency on server-side Arabic shaping.

export const LONG_SIDE = 1600
export const PICTURE_PAD = 24
const MAX_UPSCALE = 2 // a small selection is shown at most twice its size, not blown up to fill 1600 px
const READY_TIMEOUT_MS = 3000

export const rectOfElements = (els: Element[], pad = 0): Rect | null => {
  if (els.length === 0) return null
  const bs = els.map(bounds)
  return {
    minX: Math.min(...bs.map((b) => b.minX)) - pad,
    minY: Math.min(...bs.map((b) => b.minY)) - pad,
    maxX: Math.max(...bs.map((b) => b.maxX)) + pad,
    maxY: Math.max(...bs.map((b) => b.maxY)) + pad,
  }
}

/** Output size and scale for a world rect: long side at most 1600 px, never enlarged more than 2x. */
export function pictureSize(rect: Rect) {
  const w = Math.max(1, rect.maxX - rect.minX)
  const h = Math.max(1, rect.maxY - rect.minY)
  const scale = Math.min(MAX_UPSCALE, LONG_SIDE / Math.max(w, h))
  return {
    scale,
    width: Math.max(1, Math.round(w * scale)),
    height: Math.max(1, Math.round(h * scale)),
  }
}

/** Waits for the formulas and images in `rect` to be decoded (render() only reads what is already in cache). */
async function ready(scene: Scene, platform: Platform, rect: Rect) {
  const waits: Promise<void>[] = []
  for (const el of scene.els.values()) {
    const b = bounds(el)
    if (
      b.maxX < rect.minX ||
      b.minX > rect.maxX ||
      b.maxY < rect.minY ||
      b.minY > rect.maxY
    )
      continue
    if (el.type === 'math' && platform.math)
      waits.push(
        new Promise((r) =>
          platform.math?.request(
            el.data.latex,
            el.data.display,
            el.style.stroke,
            r,
          ),
        ),
      )
    else if (el.type === 'image' && platform.images)
      waits.push(
        new Promise((r) => platform.images?.request(el.data.blobId, r)),
      )
  }
  await Promise.race([
    Promise.all(waits),
    new Promise((r) => setTimeout(r, READY_TIMEOUT_MS)),
  ])
}

/** A PNG of `rect` (world units). `createCanvas` and `encode` are the platform's, so the same code runs in the browser and in tests. */
export async function renderPicture<T>(o: {
  scene: Scene
  platform: Platform
  rect: Rect
  createCanvas: (w: number, h: number) => CanvasLike
  encode: (canvas: CanvasLike) => Promise<T>
}): Promise<{ png: T; width: number; height: number }> {
  const { width, height, scale } = pictureSize(o.rect)
  await ready(o.scene, o.platform, o.rect)
  const canvas = o.createCanvas(width, height)
  const ctx = canvas.getContext('2d') as CanvasRenderingContext2D
  render(
    ctx,
    o.scene,
    { x: o.rect.minX, y: o.rect.minY, zoom: scale },
    { width, height, dpr: 1 },
    o.platform,
    { cache: new RenderCache(64 * 2 ** 20) },
  )
  return { png: await o.encode(canvas), width, height }
}
