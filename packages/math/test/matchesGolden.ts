import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createCanvas, loadImage } from '@napi-rs/canvas'

export type DiffOpts = {
  channelThreshold?: number
  maxDiffRatio?: number
}

export type PngCanvas = {
  width: number
  height: number
  getContext(t: '2d'): unknown
  toBuffer(mime: 'image/png'): Buffer
}

const dir = resolve(dirname(fileURLToPath(import.meta.url)), 'golden')

export function rgbaData(c: {
  width: number
  height: number
  getContext(t: '2d'): unknown
}): Uint8ClampedArray {
  return (c.getContext('2d') as CanvasRenderingContext2D).getImageData(
    0,
    0,
    c.width,
    c.height,
  ).data
}

export function diffRatio(
  a: Uint8ClampedArray,
  b: Uint8ClampedArray,
  channelThreshold = 16,
): number {
  let differing = 0
  const totalPixels = a.length / 4
  for (let i = 0; i < a.length; i += 4) {
    let diff = false
    for (let k = 0; k < 4; k++) {
      if (Math.abs((a[i + k] ?? 0) - (b[i + k] ?? 0)) > channelThreshold) {
        diff = true
        break
      }
    }
    if (diff) differing++
  }
  return totalPixels === 0 ? 0 : differing / totalPixels
}

export async function matchesGolden(
  canvas: PngCanvas,
  name: string,
  { channelThreshold = 16, maxDiffRatio = 0.005 }: DiffOpts = {},
): Promise<void> {
  const path = resolve(dir, `${name}.png`)
  if (process.env.UPDATE_GOLDEN === '1') {
    mkdirSync(dir, { recursive: true })
    writeFileSync(path, canvas.toBuffer('image/png'))
    return
  }
  if (!existsSync(path)) {
    throw new Error(`missing golden ${name}.png (run with UPDATE_GOLDEN=1)`)
  }
  const img = await loadImage(readFileSync(path))
  if (img.width !== canvas.width || img.height !== canvas.height) {
    throw new Error(
      `golden ${name}: size ${canvas.width}x${canvas.height} != ${img.width}x${img.height}`,
    )
  }
  const expected = createCanvas(img.width, img.height)
  expected.getContext('2d').drawImage(img, 0, 0)
  const ratio = diffRatio(
    rgbaData(expected),
    rgbaData(canvas),
    channelThreshold,
  )
  if (ratio > maxDiffRatio) {
    throw new Error(
      `golden ${name}: differing pixel ratio ${ratio.toFixed(4)} > ${maxDiffRatio}`,
    )
  }
}
