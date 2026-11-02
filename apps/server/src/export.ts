import { createCanvas, loadImage } from '@napi-rs/canvas'
import {
  type BlobStore,
  bounds as boundsOfElement,
  createScene,
  type Element,
  type ImageBitmapEntry,
  type ImageProvider,
  type MathProvider,
  type Platform,
  RenderCache,
  render,
} from '@whiteboard/core'
import { nodePlatform, registerBundledFonts } from '@whiteboard/core/node'
import type { Bounds } from './db'
import { apiError } from './errors'

export const EXPORT_WIDTH = { min: 16, max: 4096 } as const
export const EXPORT_MAX_HEIGHT = 8192
const PAD = 24 // world units around the content of a default export

let ready: Promise<{ platform: Platform; math: MathProvider }> | undefined
/** Fonts, the Node platform and MathJax are set up once, on the first export, so the server itself starts fast. */
function setup() {
  ready ??= (async () => {
    registerBundledFonts()
    const { createNodeMathProvider } = await import('@whiteboard/math/node')
    return {
      platform: nodePlatform(),
      math: createNodeMathProvider() as unknown as MathProvider,
    }
  })()
  return ready
}

const finite = (n: number) => typeof n === 'number' && Number.isFinite(n)

/** The default rect of an export: the scene's bounds plus padding (an empty board gets a small blank page). */
export function defaultRect(scene: Element[]): Bounds {
  if (scene.length === 0) return { x: 0, y: 0, w: 800, h: 600 }
  const rs = scene.map(boundsOfElement)
  const minX = Math.min(...rs.map((r) => r.minX)) - PAD
  const minY = Math.min(...rs.map((r) => r.minY)) - PAD
  const maxX = Math.max(...rs.map((r) => r.maxX)) + PAD
  const maxY = Math.max(...rs.map((r) => r.maxY)) + PAD
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY }
}

const intersects = (el: Element, r: Bounds) => {
  const b = boundsOfElement(el)
  return (
    b.maxX >= r.x && b.minX <= r.x + r.w && b.maxY >= r.y && b.minY <= r.y + r.h
  )
}

/**
 * A PNG of `rect` (world units) at `width` px wide: core's `render()` on a Node canvas. Everything asynchronous (MathJax,
 * image decoding) is awaited first, so the one synchronous render() finds it all in cache; an image whose blob is
 * missing draws core's labelled placeholder. Output size is bounded (width 16..4096, height at most 8192).
 */
export async function renderBoardPng(
  scene: Element[],
  rect: Bounds,
  width: number,
  deps: { blobs: BlobStore },
): Promise<Buffer> {
  if (
    ![rect.x, rect.y, rect.w, rect.h].every(finite) ||
    rect.w <= 0 ||
    rect.h <= 0
  )
    throw apiError(
      'validation_failed',
      'x, y, w and h must be finite numbers with w and h above 0',
      { field: 'rect' },
    )
  if (!finite(width) || width < EXPORT_WIDTH.min || width > EXPORT_WIDTH.max)
    throw apiError(
      'validation_failed',
      `width must be ${EXPORT_WIDTH.min} to ${EXPORT_WIDTH.max}`,
      { field: 'width' },
    )
  const height = Math.max(1, Math.round((width * rect.h) / rect.w))
  if (height > EXPORT_MAX_HEIGHT)
    throw apiError(
      'validation_failed',
      `the image would be ${height} px tall; the limit is ${EXPORT_MAX_HEIGHT}`,
      { field: 'height' },
    )

  const { platform, math } = await setup()
  const visible = scene.filter((el) => intersects(el, rect))

  await Promise.all(
    visible.flatMap((el) =>
      el.type === 'math'
        ? [
            new Promise<void>((r) =>
              math.request(el.data.latex, el.data.display, el.style.stroke, r),
            ),
          ]
        : [],
    ),
  )

  const decoded = new Map<string, ImageBitmapEntry | 'missing'>()
  await Promise.all(
    [
      ...new Set(
        visible.flatMap((el) => (el.type === 'image' ? [el.data.blobId] : [])),
      ),
    ].map(async (blobId) => {
      const rec = await deps.blobs.get(blobId)
      if (!rec) return void decoded.set(blobId, 'missing')
      try {
        const img = await loadImage(Buffer.from(rec.bytes))
        decoded.set(blobId, {
          bitmap: img as unknown as CanvasImageSource,
          w: img.width,
          h: img.height,
        })
      } catch {
        decoded.set(blobId, 'missing')
      }
    }),
  )
  const images: ImageProvider = {
    peek: (id) => decoded.get(id),
    request: () => {},
  }

  const canvas = createCanvas(width, height)
  const cache = new RenderCache()
  try {
    render(
      canvas.getContext('2d') as unknown as CanvasRenderingContext2D,
      createScene(visible),
      { x: rect.x, y: rect.y, zoom: width / rect.w },
      { width, height, dpr: 1 },
      { ...platform, math, images },
      { cache },
    )
    return await canvas.encode('png')
  } finally {
    cache.dispose()
  }
}
