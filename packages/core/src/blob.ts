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
