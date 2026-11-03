import { createCanvas, loadImage } from '@napi-rs/canvas'
import {
  type CanvasLike,
  createScene,
  DEFAULT_STYLE,
  type Element,
  type Platform,
} from '@whiteboard/core'
import { nodePlatform, registerBundledFonts } from '@whiteboard/core/node'
import { describe, expect, it } from 'vitest'
import {
  LONG_SIDE,
  pictureSize,
  rectOfElements,
  renderPicture,
} from './pictures'

registerBundledFonts()
const platform: Platform = nodePlatform()
const box = (
  id: string,
  x: number,
  y: number,
  w: number,
  h: number,
  fill = '#ff0000',
): Element =>
  ({
    id,
    type: 'shape',
    x,
    y,
    w,
    h,
    rotation: 0,
    z: `a${id}`,
    style: { ...DEFAULT_STYLE, fill },
    locked: false,
    author: { kind: 'human', id: 'owner' },
    v: 0,
    data: { kind: 'rect' },
  }) as Element
const encode = async (c: CanvasLike) =>
  (c as unknown as { toBuffer(t: string): Buffer }).toBuffer('image/png')
const make = (w: number, h: number) =>
  createCanvas(w, h) as unknown as CanvasLike

describe('rectOfElements and pictureSize', () => {
  it('pads the union of the elements, and is null for none', () => {
    const r = rectOfElements(
      [box('a', 0, 0, 100, 50), box('b', 400, 300, 100, 100)],
      24,
    )
    expect(r).toEqual({ minX: -24, minY: -24, maxX: 524, maxY: 424 })
    expect(rectOfElements([])).toBeNull()
  })
  it('fits the long side to 1600 px, but enlarges a small crop at most twice', () => {
    expect(pictureSize({ minX: 0, minY: 0, maxX: 3200, maxY: 1600 })).toEqual({
      scale: 0.5,
      width: 1600,
      height: 800,
    })
    expect(pictureSize({ minX: 0, minY: 0, maxX: 100, maxY: 50 })).toEqual({
      scale: 2,
      width: 200,
      height: 100,
    })
    const tall = pictureSize({ minX: 0, minY: 0, maxX: 500, maxY: 4000 })
    expect(Math.max(tall.width, tall.height)).toBeLessThanOrEqual(LONG_SIDE)
  })
})

describe('renderPicture', () => {
  it('draws only the scene, on white, at the right size', async () => {
    const scene = createScene([box('a', 100, 100, 100, 100)])
    const { png, width, height } = await renderPicture({
      scene,
      platform,
      rect: { minX: 76, minY: 76, maxX: 224, maxY: 224 },
      createCanvas: make,
      encode,
    })
    const img = await loadImage(png)
    expect([img.width, img.height, width, height]).toEqual([296, 296, 296, 296])
    const px = createCanvas(img.width, img.height)
    const g = px.getContext('2d')
    g.drawImage(img, 0, 0)
    const at = (x: number, y: number) => [
      ...g.getImageData(x, y, 1, 1).data.slice(0, 3),
    ]
    expect(at(5, 5)).toEqual([255, 255, 255]) // the margin is white
    expect(at(148, 148)).toEqual([255, 0, 0]) // the element's fill, in the middle
  })
  it('a crop of two far-apart elements shows both', async () => {
    const scene = createScene([
      box('a', 0, 0, 50, 50, '#00ff00'),
      box('b', 1000, 1000, 50, 50, '#0000ff'),
    ])
    const rect = rectOfElements([...scene.els.values()], 24) as NonNullable<
      ReturnType<typeof rectOfElements>
    >
    const { png, width, height } = await renderPicture({
      scene,
      platform,
      rect,
      createCanvas: make,
      encode,
    })
    expect(Math.max(width, height)).toBeLessThanOrEqual(LONG_SIDE)
    const img = await loadImage(png)
    const c = createCanvas(img.width, img.height)
    const g = c.getContext('2d')
    g.drawImage(img, 0, 0)
    const s = width / (rect.maxX - rect.minX)
    const at = (wx: number, wy: number) => [
      ...g
        .getImageData(
          Math.round((wx - rect.minX) * s),
          Math.round((wy - rect.minY) * s),
          1,
          1,
        )
        .data.slice(0, 3),
    ]
    expect(at(25, 25)).toEqual([0, 255, 0])
    expect(at(1025, 1025)).toEqual([0, 0, 255])
  })
})
