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
