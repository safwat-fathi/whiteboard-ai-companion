import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createCanvas, loadImage } from '@napi-rs/canvas'

type Opts = { maxMeanDiff?: number; maxBigDiffRatio?: number }
type Png = {
  width: number
  height: number
  toBuffer(mime: 'image/png'): Buffer
}

const dir = resolve(dirname(fileURLToPath(import.meta.url)), 'golden')

const rgba = (c: {
  width: number
  height: number
  getContext(t: '2d'): unknown
}) =>
  (c.getContext('2d') as CanvasRenderingContext2D).getImageData(
    0,
    0,
    c.width,
    c.height,
  ).data

/**
 * Compares by mean absolute RGBA difference (0..255) and the ratio of pixels whose worst channel differs by > 64.
 * Defaults come from S1 (browser vs server measured 2.2 and 1.48%). `UPDATE_GOLDEN=1` (re)writes the PNG.
 */
export async function matchesGolden(
  canvas: Png,
  name: string,
  { maxMeanDiff = 2.5, maxBigDiffRatio = 0.02 }: Opts = {},
): Promise<void> {
  const path = resolve(dir, `${name}.png`)
  if (process.env.UPDATE_GOLDEN === '1') {
    mkdirSync(dir, { recursive: true })
    writeFileSync(path, canvas.toBuffer('image/png'))
    return
  }
  if (!existsSync(path))
    throw new Error(`missing golden ${name}.png (run with UPDATE_GOLDEN=1)`)
  const img = await loadImage(readFileSync(path))
  if (img.width !== canvas.width || img.height !== canvas.height)
    throw new Error(
      `golden ${name}: size ${canvas.width}x${canvas.height} != ${img.width}x${img.height}`,
    )
  const g = createCanvas(img.width, img.height)
  g.getContext('2d').drawImage(img, 0, 0)
  const a = rgba(g)
  const b = rgba(canvas as never)
  let sum = 0
  let big = 0
  for (let i = 0; i < a.length; i += 4) {
    let worst = 0
    for (let k = 0; k < 4; k++) {
      const d = Math.abs((a[i + k] as number) - (b[i + k] as number))
      sum += d
      worst = Math.max(worst, d)
    }
    if (worst > 64) big++
  }
  const mean = sum / a.length
  const ratio = big / (a.length / 4)
  if (mean > maxMeanDiff || ratio > maxBigDiffRatio)
    throw new Error(
      `golden ${name}: mean diff ${mean.toFixed(3)} (max ${maxMeanDiff}), big-diff ratio ${ratio.toFixed(4)} (max ${maxBigDiffRatio})`,
    )
}
