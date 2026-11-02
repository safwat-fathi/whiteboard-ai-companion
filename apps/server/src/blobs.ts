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
  BlobError,
  type BlobStore,
  hashBytes,
  sniffMime,
} from '@whiteboard/core'
import type { BlobsDb } from './db'

export const MAX_BLOB_BYTES = 10 * 2 ** 20 // 10 MB

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
