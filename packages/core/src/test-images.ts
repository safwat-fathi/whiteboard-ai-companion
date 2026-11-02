// Test fixtures: tiny files with a valid header for the given size and `pad` zero bytes after it (the bytes after the
// header are not decodable image data). Enough for sniffMime and parseImageHeader, and for size-limit tests that must
// not allocate pixels. Used by core's and the server's tests; not exported from main.ts.
const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0))
const be16 = (n: number) => [(n >> 8) & 255, n & 255]
const le16 = (n: number) => [n & 255, (n >> 8) & 255]
const be32 = (n: number) => [
  (n >>> 24) & 255,
  (n >>> 16) & 255,
  (n >>> 8) & 255,
  n & 255,
]
const le32 = (n: number) => [
  n & 255,
  (n >>> 8) & 255,
  (n >>> 16) & 255,
  (n >>> 24) & 255,
]
const le24 = (n: number) => [n & 255, (n >> 8) & 255, (n >> 16) & 255]
const file = (head: number[], pad: number, fill = 0) => {
  const out = new Uint8Array(head.length + pad).fill(fill)
  out.set(head, 0)
  return out
}

export const png = (w: number, h: number, pad = 0, fill = 0) =>
  file(
    [
      0x89,
      0x50,
      0x4e,
      0x47,
      0x0d,
      0x0a,
      0x1a,
      0x0a,
      ...be32(13),
      ...ascii('IHDR'),
      ...be32(w),
      ...be32(h),
      8,
      6,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
    ],
    pad,
    fill,
  )

export const gif = (w: number, h: number, pad = 0, fill = 0) =>
  file([...ascii('GIF89a'), ...le16(w), ...le16(h), 0, 0, 0], pad, fill)

/** A JPEG whose SOF0 segment carries the size. */
export const jpeg = (w: number, h: number, pad = 0, fill = 0) =>
  file(
    [
      0xff,
      0xd8,
      0xff,
      0xc0,
      0,
      17,
      8,
      ...be16(h),
      ...be16(w),
      3,
      1,
      0x22,
      0,
      2,
      0x11,
      1,
      3,
      0x11,
      1,
    ],
    pad,
    fill,
  )

/** WebP, extended format (VP8X): canvas size minus one in 24 bits at bytes 24 and 27. */
export const webp = (w: number, h: number, pad = 0, fill = 0) =>
  file(
    [
      ...ascii('RIFF'),
      0,
      0,
      0,
      0,
      ...ascii('WEBP'),
      ...ascii('VP8X'),
      ...le32(10),
      0,
      0,
      0,
      0,
      ...le24(w - 1),
      ...le24(h - 1),
    ],
    pad,
    fill,
  )

/** WebP, lossy (VP8): 14-bit size at bytes 26 and 28. */
export const webpLossy = (w: number, h: number) =>
  file(
    [
      ...ascii('RIFF'),
      0,
      0,
      0,
      0,
      ...ascii('WEBP'),
      ...ascii('VP8 '),
      ...le32(10),
      0,
      0,
      0,
      0x9d,
      0x01,
      0x2a,
      ...le16(w),
      ...le16(h),
    ],
    0,
  )

/** WebP, lossless (VP8L): two packed 14-bit sizes minus one at bytes 21 to 24. */
export const webpLossless = (w: number, h: number) => {
  const W = w - 1
  const H = h - 1
  return file(
    [
      ...ascii('RIFF'),
      0,
      0,
      0,
      0,
      ...ascii('WEBP'),
      ...ascii('VP8L'),
      ...le32(5),
      0x2f,
      W & 255,
      ((W >> 8) & 0x3f) | ((H & 3) << 6),
      (H >> 2) & 255,
      (H >> 10) & 0x0f,
      0,
      0,
      0,
      0,
      0,
    ],
    0,
  )
}
