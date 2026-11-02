import { hashBytes } from '@whiteboard/core'
import { describe, expect, it, vi } from 'vitest'
import { createHttpBlobStore } from './blobs-http'

const sampleBytes = new Uint8Array([1, 2, 3, 4, 5])

describe('HttpBlobStore', () => {
  describe('put', () => {
    it('returns the blob id on 201 or 200 response when id matches hashBytes', async () => {
      const id = await hashBytes(sampleBytes)
      const mockFetch = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ id, mime: 'image/png', bytes: 5 }), {
          status: 201,
          headers: { 'Content-Type': 'application/json' },
        }),
      )

      const store = createHttpBlobStore('http://localhost:4000', mockFetch)
      const result = await store.put(sampleBytes, 'image/png')
      expect(result).toBe(id)

      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:4000/api/blobs',
        expect.objectContaining({
          method: 'POST',
          headers: { 'Content-Type': 'image/png' },
        }),
      )
    })

    it('normalizes base url by stripping trailing slash', async () => {
      const id = await hashBytes(sampleBytes)
      const mockFetch = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ id }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      )

      const store = createHttpBlobStore('http://localhost:4000/', mockFetch)
      await store.put(sampleBytes, 'image/png')
      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:4000/api/blobs',
        expect.anything(),
      )
    })

    it('throws unsupported BlobError on status 400', async () => {
      const mockFetch = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            error: {
              code: 'validation_failed',
              message: 'unsupported image format',
            },
          }),
          { status: 400, headers: { 'Content-Type': 'application/json' } },
        ),
      )

      const store = createHttpBlobStore('http://localhost:4000', mockFetch)
      await expect(store.put(sampleBytes, 'image/svg+xml')).rejects.toThrow(
        expect.objectContaining({ code: 'unsupported' }),
      )
    })

    it('throws too-large BlobError on status 413', async () => {
      const mockFetch = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            error: {
              code: 'payload_too_large',
              message: 'image exceeds 10 MB',
            },
          }),
          { status: 413, headers: { 'Content-Type': 'application/json' } },
        ),
      )

      const store = createHttpBlobStore('http://localhost:4000', mockFetch)
      await expect(store.put(sampleBytes, 'image/png')).rejects.toThrow(
        expect.objectContaining({ code: 'too-large' }),
      )
    })

    it('throws unavailable BlobError on network failure', async () => {
      const mockFetch = vi
        .fn()
        .mockRejectedValue(new Error('Connection failed'))

      const store = createHttpBlobStore('http://localhost:4000', mockFetch)
      await expect(store.put(sampleBytes, 'image/png')).rejects.toThrow(
        expect.objectContaining({ code: 'unavailable' }),
      )
    })

    it('throws unavailable BlobError on non-ok status like 500', async () => {
      const mockFetch = vi
        .fn()
        .mockResolvedValue(new Response('Server Error', { status: 500 }))

      const store = createHttpBlobStore('http://localhost:4000', mockFetch)
      await expect(store.put(sampleBytes, 'image/png')).rejects.toThrow(
        expect.objectContaining({ code: 'unavailable' }),
      )
    })

    it('throws unavailable BlobError if server id does not match content hash', async () => {
      const wrongId = '0'.repeat(64)
      const mockFetch = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ id: wrongId }), {
          status: 201,
          headers: { 'Content-Type': 'application/json' },
        }),
      )

      const store = createHttpBlobStore('http://localhost:4000', mockFetch)
      await expect(store.put(sampleBytes, 'image/png')).rejects.toThrow(
        expect.objectContaining({ code: 'unavailable' }),
      )
    })
  })

  describe('get', () => {
    it('returns bytes and mime on 200 response', async () => {
      const mockFetch = vi.fn().mockResolvedValue(
        new Response(sampleBytes, {
          status: 200,
          headers: { 'Content-Type': 'image/png' },
        }),
      )

      const store = createHttpBlobStore('http://localhost:4000', mockFetch)
      const res = await store.get('abc123')
      expect(res).toBeDefined()
      expect(res?.bytes).toEqual(sampleBytes)
      expect(res?.mime).toBe('image/png')
      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:4000/api/blobs/abc123',
      )
    })

    it('returns undefined on 404 response', async () => {
      const mockFetch = vi
        .fn()
        .mockResolvedValue(new Response(null, { status: 404 }))

      const store = createHttpBlobStore('http://localhost:4000', mockFetch)
      const res = await store.get('unknown')
      expect(res).toBeUndefined()
    })

    it('returns undefined on network failure or other error', async () => {
      const mockFetch = vi.fn().mockRejectedValue(new Error('Network error'))

      const store = createHttpBlobStore('http://localhost:4000', mockFetch)
      const res = await store.get('abc123')
      expect(res).toBeUndefined()
    })

    it('returns undefined on 500 response', async () => {
      const mockFetch = vi
        .fn()
        .mockResolvedValue(new Response(null, { status: 500 }))

      const store = createHttpBlobStore('http://localhost:4000', mockFetch)
      const res = await store.get('abc123')
      expect(res).toBeUndefined()
    })
  })

  describe('has', () => {
    it('returns true on 200 HEAD response', async () => {
      const mockFetch = vi
        .fn()
        .mockResolvedValue(new Response(null, { status: 200 }))

      const store = createHttpBlobStore('http://localhost:4000', mockFetch)
      const exists = await store.has('abc123')
      expect(exists).toBe(true)
      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:4000/api/blobs/abc123',
        { method: 'HEAD' },
      )
    })

    it('returns false on 404 response', async () => {
      const mockFetch = vi
        .fn()
        .mockResolvedValue(new Response(null, { status: 404 }))

      const store = createHttpBlobStore('http://localhost:4000', mockFetch)
      const exists = await store.has('abc123')
      expect(exists).toBe(false)
    })

    it('returns false on network failure', async () => {
      const mockFetch = vi.fn().mockRejectedValue(new Error('Network error'))

      const store = createHttpBlobStore('http://localhost:4000', mockFetch)
      const exists = await store.has('abc123')
      expect(exists).toBe(false)
    })
  })
})
