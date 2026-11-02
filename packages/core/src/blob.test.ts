import { describe, expect, it } from 'vitest'
import { BlobError, hashBytes, parseImageHeader, sniffMime } from './blob'
import {
  gif,
  gifFrames,
  jpeg,
  jpegSofs,
  png,
  webp,
  webpAnimated,
  webpLossless,
  webpLossy,
  webpMismatch,
  webpNoImage,
} from './test-images'

describe('blob utilities', () => {
  it('hashes bytes to a 64-char lowercase SHA-256 hex string', async () => {
    const empty = await hashBytes(new Uint8Array(0))
    expect(empty).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    )
    const abc = await hashBytes(new TextEncoder().encode('abc'))
    expect(abc).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    )
  })

  it('constructs BlobError with code and message', () => {
    const err = new BlobError('too-large', 'File exceeds 10 MB')
    expect(err).toBeInstanceOf(Error)
    expect(err.code).toBe('too-large')
    expect(err.message).toBe('File exceeds 10 MB')
  })
})

describe('sniffMime', () => {
  const bytes = (...b: number[]) => new Uint8Array(b)
  const ascii = (s: string) => new TextEncoder().encode(s)

  it('recognises the four allowed image types by magic bytes', () => {
    expect(
      sniffMime(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0)),
    ).toBe('image/png')
    expect(sniffMime(bytes(0xff, 0xd8, 0xff, 0xe0))).toBe('image/jpeg')
    expect(sniffMime(ascii('GIF87a'))).toBe('image/gif')
    expect(sniffMime(ascii('GIF89a'))).toBe('image/gif')
    expect(
      sniffMime(ascii('RIFF....WEBPVP8 '.replace('....', '\0\0\0\0'))),
    ).toBe('image/webp')
  })

  it('refuses SVG, HTML, text, truncated headers and empty input', () => {
    expect(
      sniffMime(ascii('<svg xmlns="http://www.w3.org/2000/svg"/>')),
    ).toBeNull()
    expect(
      sniffMime(ascii('<!doctype html><script>alert(1)</script>')),
    ).toBeNull()
    expect(sniffMime(ascii('hello'))).toBeNull()
    expect(sniffMime(bytes(0x89, 0x50, 0x4e))).toBeNull()
    expect(sniffMime(new Uint8Array(0))).toBeNull()
  })
})

describe('parseImageHeader', () => {
  it('reads the size of each allowed type from the header alone', () => {
    expect(parseImageHeader(png(120, 80, 10), 'image/png')).toEqual({
      width: 120,
      height: 80,
      exifOrientation: 1,
    })
    expect(parseImageHeader(gif(300, 200), 'image/gif')).toEqual({
      width: 300,
      height: 200,
      exifOrientation: 1,
    })
    expect(parseImageHeader(jpeg(1000, 750, 5), 'image/jpeg')).toEqual({
      width: 1000,
      height: 750,
      exifOrientation: 1,
    })
    expect(parseImageHeader(webp(640, 480), 'image/webp')).toEqual({
      width: 640,
      height: 480,
      exifOrientation: 1,
    })
    expect(parseImageHeader(webpLossy(321, 123), 'image/webp')).toEqual({
      width: 321,
      height: 123,
      exifOrientation: 1,
    })
    expect(parseImageHeader(webpLossless(4000, 3001), 'image/webp')).toEqual({
      width: 4000,
      height: 3001,
      exifOrientation: 1,
    })
  })

  it('reads a huge claimed size without allocating anything', () => {
    expect(parseImageHeader(png(100_000, 100_000), 'image/png')).toMatchObject({
      width: 100_000,
      height: 100_000,
    })
    expect(parseImageHeader(jpeg(65_535, 65_535), 'image/jpeg')).toMatchObject({
      width: 65_535,
      height: 65_535,
    })
  })

  it('returns null for a truncated or unrecognised header', () => {
    expect(parseImageHeader(png(10, 10).slice(0, 12), 'image/png')).toBeNull()
    expect(parseImageHeader(gif(10, 10).slice(0, 8), 'image/gif')).toBeNull()
    expect(
      parseImageHeader(
        new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 2]),
        'image/jpeg',
      ),
    ).toBeNull()
    expect(parseImageHeader(webp(10, 10).slice(0, 20), 'image/webp')).toBeNull()
    expect(parseImageHeader(new Uint8Array(40), 'image/webp')).toBeNull()
  })

  it('fixtures are recognised by sniffMime', () => {
    expect(
      [png(1, 1), jpeg(1, 1), gif(1, 1), webp(1, 1)].map(sniffMime),
    ).toEqual(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])
  })
})

// A header size is only a safe bound if the decoder will use that same size, so ambiguous structures are refused.
describe('parseImageHeader refuses structures a decoder could read differently', () => {
  const size = (b: Uint8Array, m: Parameters<typeof parseImageHeader>[1]) =>
    parseImageHeader(b, m)

  it('GIF: every frame must lie inside the logical screen', () => {
    expect(
      size(gifFrames([100, 80], [[0, 0, 100, 80]]), 'image/gif'),
    ).toMatchObject({ width: 100, height: 80 })
    expect(
      size(
        gifFrames(
          [100, 80],
          [
            [10, 10, 20, 20],
            [0, 0, 100, 80],
          ],
        ),
        'image/gif',
      ),
    ).toMatchObject({ width: 100, height: 80 })
    expect(
      size(gifFrames([10, 10], [[0, 0, 60_000, 60_000]]), 'image/gif'),
    ).toBeNull() // a tiny screen hiding a huge frame
    expect(
      size(gifFrames([100, 80], [[90, 0, 20, 20]]), 'image/gif'),
    ).toBeNull() // sticks out to the right
    expect(
      size(gifFrames([100, 80], [[0, 70, 20, 20]]), 'image/gif'),
    ).toBeNull() // sticks out of the bottom
    expect(
      size(
        gifFrames(
          [100, 80],
          [
            [0, 0, 100, 80],
            [0, 0, 60_000, 60_000],
          ],
        ),
        'image/gif',
      ),
    ).toBeNull() // a later frame
    expect(size(gifFrames([100, 80], [[0, 0, 0, 80]]), 'image/gif')).toBeNull() // an empty frame
  })

  it('GIF: reads past a global colour table and extension blocks, and refuses a file with no frame', () => {
    expect(
      size(
        gifFrames([5, 5], [[0, 0, 5, 5]], {
          globalTable: true,
          extension: true,
        }),
        'image/gif',
      ),
    ).toMatchObject({ width: 5, height: 5 })
    expect(size(gifFrames([5, 5], [], {}), 'image/gif')).toBeNull() // trailer only
    expect(
      size(
        gifFrames([5, 5], [[0, 0, 5, 5]], { trailerFirst: true }),
        'image/gif',
      ),
    ).toBeNull()
    expect(
      size(gifFrames([5, 5], [[0, 0, 5, 5]], { noTrailer: true }), 'image/gif'),
    ).toMatchObject({ width: 5, height: 5 }) // truncated after a valid frame
    expect(size(gif(7, 7), 'image/gif')).toMatchObject({ width: 7, height: 7 })
  })

  it('GIF: refuses a file with more than 200,000 extension blocks followed by an oversized frame', () => {
    const blockCount = 200_005
    const head = [
      0x47,
      0x49,
      0x46,
      0x38,
      0x39,
      0x61, // GIF89a
      100,
      0,
      100,
      0, // sw=100, sh=100
      0,
      0,
      0,
    ]
    const validFrame = [
      0x2c,
      0,
      0,
      0,
      0,
      10,
      0,
      10,
      0, // left=0, top=0, w=10, h=10
      0,
      2,
      0, // flags, min code size, empty sub-blocks
    ]
    const oversizedFrame = [
      0x2c,
      0,
      0,
      0,
      0,
      200,
      0,
      200,
      0, // left=0, top=0, w=200, h=200
      0,
      2,
      0,
    ]
    const trailer = [0x3b]
    const totalLen =
      head.length +
      validFrame.length +
      blockCount * 3 +
      oversizedFrame.length +
      trailer.length
    const buf = new Uint8Array(totalLen)
    let p = 0
    buf.set(head, p)
    p += head.length
    buf.set(validFrame, p)
    p += validFrame.length
    for (let i = 0; i < blockCount; i++) {
      buf[p++] = 0x21
      buf[p++] = 0x01
      buf[p++] = 0x00
    }
    buf.set(oversizedFrame, p)
    p += oversizedFrame.length
    buf.set(trailer, p)
    p += trailer.length
    expect(p).toBe(totalLen)

    expect(size(buf, 'image/gif')).toBeNull()
  })

  it('JPEG: a second SOF marker is ambiguous and refused, whichever comes first', () => {
    expect(size(jpegSofs([[40, 30]]), 'image/jpeg')).toMatchObject({
      width: 40,
      height: 30,
    })
    expect(
      size(
        jpegSofs([
          [40, 30],
          [60_000, 60_000],
        ]),
        'image/jpeg',
      ),
    ).toBeNull()
    expect(
      size(
        jpegSofs([
          [60_000, 60_000],
          [40, 30],
        ]),
        'image/jpeg',
      ),
    ).toBeNull()
  })

  it('WebP: a VP8X canvas must match the still image inside it', () => {
    expect(size(webp(640, 480), 'image/webp')).toMatchObject({
      width: 640,
      height: 480,
    })
    expect(
      size(webpMismatch([10, 10], [16_000, 16_000]), 'image/webp'),
    ).toBeNull() // a small canvas hiding a big bitstream
    expect(
      size(webpMismatch([16_000, 16_000], [10, 10]), 'image/webp'),
    ).toBeNull()
    expect(size(webpNoImage(10, 10), 'image/webp')).toBeNull()
    expect(size(webpAnimated(300, 200), 'image/webp')).toMatchObject({
      width: 300,
      height: 200,
    }) // frames are in ANMF chunks
  })
})
