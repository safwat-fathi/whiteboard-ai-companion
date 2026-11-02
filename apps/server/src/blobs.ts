import { randomBytes } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import {
  type AllowedMime,
  BlobError,
  type BlobStore,
  hashBytes,
  parseImageHeader,
  sniffMime,
} from '@whiteboard/core'
import type { BlobsDb } from './db'

export const MAX_BLOB_BYTES = 10 * 2 ** 20 // 10 MB
/** The image element schema's naturalW/H limit; the web downscales every import to 4096 on the long edge. */
export const MAX_IMAGE_SIDE = 8192
/** Decoded RGBA is 4 bytes a pixel, so this bounds a decode at 160 MB however small the file is. */
export const MAX_IMAGE_PIXELS = 40_000_000

/** Whether a width and height are within the side and pixel limits (used on the declared size and again on the decoded one). */
export const sizeAllowed = (w: number, h: number) =>
  w <= MAX_IMAGE_SIDE && h <= MAX_IMAGE_SIDE && w * h <= MAX_IMAGE_PIXELS

/**
 * What is wrong with the size an image's header declares, read without decoding (a 10 MB PNG can declare gigapixels).
 * 'too-large' is over a limit; 'unsupported' is a header that cannot be read or declares no pixels.
 */
export function checkImageSize(
  bytes: Uint8Array,
  mime: AllowedMime,
):
  | { ok: true }
  | { ok: false; code: 'unsupported' | 'too-large'; message: string } {
  const h = parseImageHeader(bytes, mime)
  if (!h || h.width < 1 || h.height < 1)
    return {
      ok: false,
      code: 'unsupported',
      message: 'the image header cannot be read',
    }
  if (!sizeAllowed(h.width, h.height))
    return {
      ok: false,
      code: 'too-large',
      message: `the image is ${h.width} x ${h.height} px; the limits are ${MAX_IMAGE_SIDE} px a side and ${MAX_IMAGE_PIXELS / 1e6} megapixels`,
    }
  return { ok: true }
}

/** A SHA-256 hex id. Every store method checks this first, so an id can never become a path outside blobs/. */
export const isBlobId = (s: string): boolean => /^[0-9a-f]{64}$/.test(s)

/**
 * Content-addressed blobs on disk: `DATA_DIR/blobs/<id[0:2]>/<id[2:4]>/<id>`, id = SHA-256 of the bytes. The claimed
 * type is ignored: the real one is sniffed from the magic bytes (PNG, JPEG, WebP, GIF; SVG and everything else is refused).
 */
export function createDiskBlobStore(o: {
  dataDir: string
  db: BlobsDb
  maxBytes?: number
  now?: () => number
}): BlobStore & { path(id: string): string } {
  const max = o.maxBytes ?? MAX_BLOB_BYTES
  const now = o.now ?? Date.now
  const path = (id: string) =>
    join(o.dataDir, 'blobs', id.slice(0, 2), id.slice(2, 4), id)

  return {
    path,

    async put(bytes: Uint8Array, _claimed: string): Promise<string> {
      if (bytes.length > max)
        throw new BlobError(
          'too-large',
          `file is ${bytes.length} bytes; the limit is ${max}`,
        )
      const mime = sniffMime(bytes)
      if (!mime)
        throw new BlobError(
          'unsupported',
          'only PNG, JPEG, WebP and GIF images are accepted',
        )
      const size = checkImageSize(bytes, mime)
      if (!size.ok) throw new BlobError(size.code, size.message)
      const id = await hashBytes(bytes)
      const file = path(id)
      if (!existsSync(file)) {
        mkdirSync(dirname(file), { recursive: true })
        const tmp = `${file}.${randomBytes(6).toString('hex')}.tmp`
        writeFileSync(tmp, bytes)
        renameSync(tmp, file) // atomic: readers see all of the file or none of it
      }
      o.db.insert({ id, mime, bytes: bytes.length, createdAt: now() }) // idempotent; also heals a lost row
      return id
    },

    async get(id: string) {
      if (!isBlobId(id)) return undefined
      const row = o.db.get(id)
      if (!row) return undefined
      try {
        return { bytes: new Uint8Array(readFileSync(path(id))), mime: row.mime }
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined
        throw e
      }
    },

    async has(id: string): Promise<boolean> {
      return isBlobId(id) && !!o.db.get(id) && existsSync(path(id))
    },
  }
}
