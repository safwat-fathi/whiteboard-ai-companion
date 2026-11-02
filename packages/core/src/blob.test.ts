import { describe, expect, it } from 'vitest'
import { BlobError, hashBytes, parseImageHeader, sniffMime } from './blob'
import { gif, jpeg, png, webp, webpLossless, webpLossy } from './test-images'

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
