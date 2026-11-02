import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { deflateSync, inflateSync } from 'node:zlib'

const GOLDEN_DIR = resolve(process.cwd(), 'packages/math/test/golden')

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  if (pa <= pb && pa <= pc) return a
  if (pb <= pc) return b
  return c
}

export function decodePng(buf: Buffer): {
  width: number
  height: number
  data: Uint8Array
} {
  let pos = 8
  let width = 0
  let height = 0
  let colorType = 6
  const idats: Buffer[] = []
  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos)
    const type = buf.toString('ascii', pos + 4, pos + 8)
    const chunk = buf.subarray(pos + 8, pos + 8 + len)
    pos += 12 + len
    if (type === 'IHDR') {
      width = chunk.readUInt32BE(0)
      height = chunk.readUInt32BE(4)
      colorType = chunk[9] ?? 6
    } else if (type === 'IDAT') {
      idats.push(chunk)
    } else if (type === 'IEND') {
      break
    }
  }
  const raw = inflateSync(Buffer.concat(idats))
  const bpp = colorType === 6 ? 4 : 3
  const stride = width * bpp
  const recon = new Uint8Array(width * height * bpp)
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)] ?? 0
    const rowIn = y * (stride + 1) + 1
    const rowOut = y * stride
    for (let x = 0; x < stride; x++) {
      const byte = raw[rowIn + x] ?? 0
      const a = x >= bpp ? (recon[rowOut + x - bpp] ?? 0) : 0
      const b = y > 0 ? (recon[rowOut - stride + x] ?? 0) : 0
      const c = y > 0 && x >= bpp ? (recon[rowOut - stride + x - bpp] ?? 0) : 0
      let val = byte
      if (filter === 1) val = (byte + a) & 0xff
      else if (filter === 2) val = (byte + b) & 0xff
      else if (filter === 3) val = (byte + ((a + b) >> 1)) & 0xff
      else if (filter === 4) val = (byte + paeth(a, b, c)) & 0xff
      recon[rowOut + x] = val
    }
  }
  if (bpp === 4) return { width, height, data: recon }
  const rgba = new Uint8Array(width * height * 4)
  for (let i = 0; i < width * height; i++) {
    rgba[i * 4] = recon[i * 3] ?? 0
    rgba[i * 4 + 1] = recon[i * 3 + 1] ?? 0
    rgba[i * 4 + 2] = recon[i * 3 + 2] ?? 0
    rgba[i * 4 + 3] = 255
  }
  return { width, height, data: rgba }
}

function crc32(buf: Buffer): number {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i] ?? 0
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    }
  }
  return (c ^ 0xffffffff) >>> 0
}

function makeChunk(type: string, data: Buffer): Buffer {
  const out = Buffer.alloc(12 + data.length)
  out.writeUInt32BE(data.length, 0)
  out.write(type, 4, 4, 'ascii')
  data.copy(out, 8)
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length)
  return out
}

export function encodePng(
  width: number,
  height: number,
  rgba: Uint8Array,
): Buffer {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  const stride = width * 4
  const raw = Buffer.alloc(height * (stride + 1))
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(
      raw,
      y * (stride + 1) + 1,
    )
  }
  const idat = deflateSync(raw)
  return Buffer.concat([
    sig,
    makeChunk('IHDR', ihdr),
    makeChunk('IDAT', idat),
    makeChunk('IEND', Buffer.alloc(0)),
  ])
}

export function getGoldenDimensions(name: string): {
  width: number
  height: number
} {
  const goldenPath = resolve(GOLDEN_DIR, `${name}.png`)
  const buf = readFileSync(goldenPath)
  return {
    width: buf.readUInt32BE(16),
    height: buf.readUInt32BE(20),
  }
}

export function comparePngBufferToGolden(
  actualPng: Buffer,
  name: string,
  {
    channelThreshold = 24,
    maxDiffRatio = 0.015,
    outDir = resolve(process.cwd(), 'test-results'),
  }: {
    channelThreshold?: number
    maxDiffRatio?: number
    outDir?: string
  } = {},
): { ratio: number; width: number; height: number } {
  const goldenPath = resolve(GOLDEN_DIR, `${name}.png`)
  if (!existsSync(goldenPath)) {
    throw new Error(`missing golden ${name}.png`)
  }
  const expectedBytes = readFileSync(goldenPath)
  const exp = decodePng(expectedBytes)
  const act = decodePng(actualPng)
  const w = exp.width
  const h = exp.height

  let differing = 0
  const totalPixels = w * h
  const diffRgba = new Uint8Array(w * h * 4)

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4
      const ai = x < act.width && y < act.height ? (y * act.width + x) * 4 : -1
      let diff = ai < 0
      if (!diff) {
        for (let k = 0; k < 4; k++) {
          if (
            Math.abs((exp.data[i + k] ?? 0) - (act.data[ai + k] ?? 0)) >
            channelThreshold
          ) {
            diff = true
            break
          }
        }
      }
      if (diff) {
        differing++
        diffRgba[i] = 255
        diffRgba[i + 1] = 0
        diffRgba[i + 2] = 0
        diffRgba[i + 3] = 255
      } else {
        const lum = Math.round(
          ((exp.data[i] ?? 255) +
            (exp.data[i + 1] ?? 255) +
            (exp.data[i + 2] ?? 255)) /
            3,
        )
        diffRgba[i] = lum
        diffRgba[i + 1] = lum
        diffRgba[i + 2] = lum
        diffRgba[i + 3] = 80
      }
    }
  }

  const ratio = totalPixels === 0 ? 0 : differing / totalPixels
  if (ratio > maxDiffRatio) {
    mkdirSync(outDir, { recursive: true })
    writeFileSync(resolve(outDir, `${name}-expected.png`), expectedBytes)
    writeFileSync(resolve(outDir, `${name}-actual.png`), actualPng)
    writeFileSync(
      resolve(outDir, `${name}-diff.png`),
      encodePng(w, h, diffRgba),
    )
    throw new Error(
      `golden ${name}: differing pixel ratio ${ratio.toFixed(4)} > ${maxDiffRatio} (saved diff to ${outDir})`,
    )
  }
  return { ratio, width: w, height: h }
}
