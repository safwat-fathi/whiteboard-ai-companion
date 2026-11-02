import { describe, expect, it } from 'vitest'
import { BlobError, hashBytes } from './blob'

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
