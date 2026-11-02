export type BlobErrorCode =
  | 'quota'
  | 'unavailable'
  | 'too-large'
  | 'unsupported'

export class BlobError extends Error {
  constructor(
    public code: BlobErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'BlobError'
  }
}

export interface BlobStore {
  put(bytes: Uint8Array, mime: string): Promise<string>
  get(id: string): Promise<{ bytes: Uint8Array; mime: string } | undefined>
  has(id: string): Promise<boolean>
}

export async function hashBytes(bytes: Uint8Array): Promise<string> {
  const buf = await crypto.subtle.digest(
    'SHA-256',
    bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer,
  )
  return Array.from(new Uint8Array(buf), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('')
}

// Magic-byte sniffing: the claimed type of a file is never trusted (SVG and everything else is refused by callers).
export type AllowedMime =
  | 'image/png'
  | 'image/jpeg'
  | 'image/webp'
  | 'image/gif'

export function sniffMime(bytes: Uint8Array): AllowedMime | null {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return 'image/png'
  }
  if (
    bytes.length >= 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  ) {
    return 'image/jpeg'
  }
  if (
    bytes.length >= 6 &&
    bytes[0] === 0x47 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x38 &&
    (bytes[4] === 0x37 || bytes[4] === 0x39) &&
    bytes[5] === 0x61
  ) {
    return 'image/gif'
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return 'image/webp'
  }
  return null
}

/**
 * GIF: the logical screen is what a decoder allocates, so every frame must lie inside it (and no frame is empty).
 * Walks the blocks (extensions, frames, colour tables) up to the trailer; null when there is no frame or one is outside.
 */
function gifSize(bytes: Uint8Array, dv: DataView) {
  if (bytes.length < 13) return null
  const sw = dv.getUint16(6, true)
  const sh = dv.getUint16(8, true)
  const flags = bytes[10] ?? 0
  let pos = 13 + (flags & 0x80 ? 3 * 2 ** ((flags & 7) + 1) : 0)
  let frames = 0
  const skipSubBlocks = () => {
    while (pos < bytes.length) {
      const n = bytes[pos] ?? 0
      pos += 1 + n
      if (n === 0) return
    }
  }
  let blocks = 0
  for (; blocks < 200_000 && pos < bytes.length; blocks++) {
    const b = bytes[pos]
    if (b === 0x3b) break // trailer
    if (b === 0x21) {
      pos += 2 // introducer and label
      skipSubBlocks()
    } else if (b === 0x2c) {
      if (pos + 10 > bytes.length) return null
      const left = dv.getUint16(pos + 1, true)
      const top = dv.getUint16(pos + 3, true)
      const w = dv.getUint16(pos + 5, true)
      const h = dv.getUint16(pos + 7, true)
      if (w < 1 || h < 1 || left + w > sw || top + h > sh) return null
      const local = bytes[pos + 9] ?? 0
      pos += 10 + (local & 0x80 ? 3 * 2 ** ((local & 7) + 1) : 0)
      pos += 1 // LZW minimum code size
      skipSubBlocks()
      frames++
    } else return null
  }
  if (blocks >= 200_000) return null
  return frames > 0 ? { width: sw, height: sh, exifOrientation: 1 } : null
}

/** The size declared by the first still-image chunk (VP8 or VP8L) after a VP8X header, or null if there is none. */
function webpStillSize(
  bytes: Uint8Array,
  dv: DataView,
): { width: number; height: number } | null {
  let pos = 30 // the first chunk after VP8X
  for (let i = 0; i < 16 && pos + 8 <= bytes.length; i++) {
    const tag = String.fromCharCode(
      bytes[pos] ?? 0,
      bytes[pos + 1] ?? 0,
      bytes[pos + 2] ?? 0,
      bytes[pos + 3] ?? 0,
    )
    if (tag === 'VP8 ' && pos + 18 <= bytes.length)
      return {
        width: dv.getUint16(pos + 14, true) & 0x3fff,
        height: dv.getUint16(pos + 16, true) & 0x3fff,
      }
    if (tag === 'VP8L' && pos + 13 <= bytes.length) {
      const [b0, b1, b2, b3] = [
        bytes[pos + 9] ?? 0,
        bytes[pos + 10] ?? 0,
        bytes[pos + 11] ?? 0,
        bytes[pos + 12] ?? 0,
      ]
      return {
        width: 1 + (b0 | ((b1 & 0x3f) << 8)),
        height: 1 + ((b1 >> 6) | (b2 << 2) | ((b3 & 0x0f) << 10)),
      }
    }
    const size = dv.getUint32(pos + 4, true)
    pos += 8 + size + (size & 1)
  }
  return null
}

/**
 * Width, height and EXIF orientation read from the file header alone (no decoding), so a caller can refuse an image
 * before allocating its pixels. Null when the header is truncated or unrecognised.
 */
export function parseImageHeader(
  bytes: Uint8Array,
  mime: AllowedMime,
): { width: number; height: number; exifOrientation: number } | null {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (mime === 'image/png') {
    if (bytes.length < 24) return null
    return {
      width: dv.getUint32(16, false),
      height: dv.getUint32(20, false),
      exifOrientation: 1,
    }
  }
  if (mime === 'image/gif') return gifSize(bytes, dv)
  if (mime === 'image/webp') {
    if (bytes.length < 30) return null
    const tag = String.fromCharCode(
      bytes[12] ?? 0,
      bytes[13] ?? 0,
      bytes[14] ?? 0,
      bytes[15] ?? 0,
    )
    if (tag === 'VP8 ') {
      return {
        width: dv.getUint16(26, true) & 0x3fff,
        height: dv.getUint16(28, true) & 0x3fff,
        exifOrientation: 1,
      }
    }
    if (tag === 'VP8L') {
      const b0 = bytes[21] ?? 0
      const b1 = bytes[22] ?? 0
      const b2 = bytes[23] ?? 0
      const b3 = bytes[24] ?? 0
      return {
        width: 1 + (b0 | ((b1 & 0x3f) << 8)),
        height: 1 + ((b1 >> 6) | (b2 << 2) | ((b3 & 0x0f) << 10)),
        exifOrientation: 1,
      }
    }
    if (tag === 'VP8X') {
      const w =
        1 +
        ((bytes[24] ?? 0) | ((bytes[25] ?? 0) << 8) | ((bytes[26] ?? 0) << 16))
      const h =
        1 +
        ((bytes[27] ?? 0) | ((bytes[28] ?? 0) << 8) | ((bytes[29] ?? 0) << 16))
      // A still image's own bitstream must declare the canvas size (libwebp refuses a mismatch); an animation's frames
      // sit in ANMF chunks inside the canvas. Either way the canvas is the size a decoder allocates.
      if ((bytes[20] ?? 0) & 0x02)
        return { width: w, height: h, exifOrientation: 1 }
      const inner = webpStillSize(bytes, dv)
      if (!inner || inner.width !== w || inner.height !== h) return null
      return { width: w, height: h, exifOrientation: 1 }
    }
    return null
  }
  if (mime === 'image/jpeg') {
    let offset = 2
    let width = 0
    let height = 0
    let exifOrientation = 1
    let sawSof = false
    while (offset + 4 <= bytes.length) {
      if (bytes[offset] !== 0xff) break
      while (offset < bytes.length && bytes[offset] === 0xff) offset++
      if (offset >= bytes.length) break
      const marker = bytes[offset++] ?? 0
      if (marker === 0xd9 || marker === 0xda) break
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) continue
      if (offset + 2 > bytes.length) break
      const segLen = dv.getUint16(offset, false)
      if (segLen < 2 || offset + segLen > bytes.length) break

      if (
        marker === 0xe1 &&
        segLen >= 14 &&
        bytes[offset + 2] === 0x45 &&
        bytes[offset + 3] === 0x78 &&
        bytes[offset + 4] === 0x69 &&
        bytes[offset + 5] === 0x66 &&
        bytes[offset + 6] === 0x00 &&
        bytes[offset + 7] === 0x00
      ) {
        const tiff = offset + 8
        const byteOrder = dv.getUint16(tiff, false)
        const le = byteOrder === 0x4949
        if (le || byteOrder === 0x4d4d) {
          const ifdOffset = dv.getUint32(tiff + 4, le)
          const dir = tiff + ifdOffset
          if (dir + 2 <= offset + segLen) {
            const count = dv.getUint16(dir, le)
            for (let i = 0; i < count; i++) {
              const entry = dir + 2 + i * 12
              if (entry + 12 > offset + segLen) break
              const tag = dv.getUint16(entry, le)
              if (tag === 0x0112) {
                const val = dv.getUint16(entry + 8, le)
                if (val >= 1 && val <= 8) exifOrientation = val
                break
              }
            }
          }
        }
      } else if (
        (marker >= 0xc0 && marker <= 0xc3) ||
        (marker >= 0xc5 && marker <= 0xc7) ||
        (marker >= 0xc9 && marker <= 0xcb) ||
        (marker >= 0xcd && marker <= 0xcf)
      ) {
        if (sawSof) return null // two SOF markers: a decoder may use either
        sawSof = true
        if (offset + 7 <= bytes.length) {
          height = dv.getUint16(offset + 3, false)
          width = dv.getUint16(offset + 5, false)
        }
      }
      offset += segLen
    }
    if (width > 0 && height > 0) {
      return { width, height, exifOrientation }
    }
  }
  return null
}
