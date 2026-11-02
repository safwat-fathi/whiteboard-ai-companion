import { describe, expect, it } from 'vitest'
import { BlobError, hashBytes, sniffMime } from './blob'

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
