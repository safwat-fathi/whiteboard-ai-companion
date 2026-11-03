import { decodePng } from '../../e2e/helpers/diff'

/** Browser picture against server picture: the share of pixels with any channel off by more than `channelThreshold`. */
export function comparePngBuffers(
  actualPng: Buffer,
  expectedPng: Buffer,
  channelThreshold = 24,
): {
  ratio: number
  differing: number
  total: number
  w: number
  h: number
  diffRgba: Uint8Array
} {
  const act = decodePng(actualPng)
  const exp = decodePng(expectedPng)
  const w = Math.min(act.width, exp.width)
  const h = Math.min(act.height, exp.height)
  let differing = 0
  const total = w * h
  const diffRgba = new Uint8Array(w * h * 4)

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const ai = (y * act.width + x) * 4
      const ei = (y * exp.width + x) * 4
      const di = (y * w + x) * 4
      let diff = false
      for (let k = 0; k < 4; k++) {
        if (
          Math.abs((act.data[ai + k] ?? 0) - (exp.data[ei + k] ?? 0)) >
          channelThreshold
        ) {
          diff = true
          break
        }
      }
      if (diff) {
        differing++
        diffRgba[di] = 255
        diffRgba[di + 1] = 0
        diffRgba[di + 2] = 0
        diffRgba[di + 3] = 255
      } else {
        const lum = Math.round(
          ((act.data[ai] ?? 255) +
            (act.data[ai + 1] ?? 255) +
            (act.data[ai + 2] ?? 255)) /
            3,
        )
        diffRgba[di] = lum
        diffRgba[di + 1] = lum
        diffRgba[di + 2] = lum
        diffRgba[di + 3] = 80
      }
    }
  }

  return {
    ratio: total === 0 ? 0 : differing / total,
    differing,
    total,
    w,
    h,
    diffRgba,
  }
}
