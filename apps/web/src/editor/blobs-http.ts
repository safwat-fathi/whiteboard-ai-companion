import { BlobError, type BlobStore, hashBytes } from '@whiteboard/core'

export function createHttpBlobStore(
  base: string,
  fetchImpl: typeof fetch = globalThis.fetch,
): BlobStore {
  const root = base.replace(/\/+$/, '')

  return {
    async put(bytes: Uint8Array, mime: string): Promise<string> {
      const expectedId = await hashBytes(bytes)
      const body =
        bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
          ? bytes
          : bytes.slice()

      let res: Response
      try {
        res = await fetchImpl(`${root}/api/blobs`, {
          method: 'POST',
          headers: { 'Content-Type': mime },
          body: body as BodyInit,
        })
      } catch {
        throw new BlobError('unavailable', 'Network error uploading blob')
      }

      if (res.status === 400) {
        throw new BlobError('unsupported', 'Unsupported image format')
      }
      if (res.status === 413) {
        throw new BlobError('too-large', 'Image is too large')
      }
      if (!res.ok) {
        throw new BlobError(
          'unavailable',
          `Blob upload failed with status ${res.status}`,
        )
      }

      let json: { id?: unknown }
      try {
        json = (await res.json()) as { id?: unknown }
      } catch {
        throw new BlobError('unavailable', 'Invalid JSON response from server')
      }

      if (typeof json.id !== 'string' || json.id !== expectedId) {
        throw new BlobError(
          'unavailable',
          'Blob ID returned by server does not match content hash',
        )
      }

      return json.id
    },

    async get(
      id: string,
    ): Promise<{ bytes: Uint8Array; mime: string } | undefined> {
      let res: Response
      try {
        res = await fetchImpl(`${root}/api/blobs/${encodeURIComponent(id)}`)
      } catch {
        return undefined
      }

      if (res.status === 404 || !res.ok) {
        return undefined
      }

      try {
        const buf = await res.arrayBuffer()
        const mime =
          res.headers.get('content-type') || 'application/octet-stream'
        return { bytes: new Uint8Array(buf), mime }
      } catch {
        return undefined
      }
    },

    async has(id: string): Promise<boolean> {
      try {
        const res = await fetchImpl(
          `${root}/api/blobs/${encodeURIComponent(id)}`,
          {
            method: 'HEAD',
          },
        )
        return res.status === 200
      } catch {
        return false
      }
    },
  }
}
