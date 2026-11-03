import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, renameSync, rmSync } from 'node:fs'
import { open } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { blobPath } from '../blobs'
import type { BlobsDb } from '../db'
import { apiError } from '../errors'

export const MAX_PDF_BYTES = 200 * 2 ** 20 // auth-security.md: 200 MB
const HEADER_WINDOW = 1024 // pdfjs accepts the %PDF- header anywhere in the first KB

/**
 * Streams an upload into the blob layout (`blobs/ab/cd/<sha256>`) without holding it in memory: temp file under
 * `DATA_DIR/tmp` while hashing, `%PDF-` required in the first KB, then an atomic rename. The blob store proper is
 * images only (10 MB), so PDFs have their own put; the `blobs` row (mime `application/pdf`) is what `books.file_blob`
 * points at. Whatever goes wrong, nothing is left in `tmp`.
 */
export async function putPdf(
  src: AsyncIterable<Uint8Array>,
  o: { dataDir: string; blobs: BlobsDb; maxBytes?: number; now?: () => number },
): Promise<{ id: string; bytes: number }> {
  const max = o.maxBytes ?? MAX_PDF_BYTES
  mkdirSync(join(o.dataDir, 'tmp'), { recursive: true })
  const tmp = join(o.dataDir, 'tmp', `${randomBytes(8).toString('hex')}.pdf`)
  const hash = createHash('sha256')
  const fh = await open(tmp, 'w')
  let size = 0
  let head = Buffer.alloc(0)
  let checked = false
  const notPdf = () =>
    apiError('validation_failed', 'the body is not a PDF (no %PDF- header)', {
      field: 'body',
    })
  try {
    for await (const chunk of src) {
      size += chunk.length
      if (size > max)
        throw apiError(
          'payload_too_large',
          `the PDF may be at most ${max} bytes`,
          { limit: max },
        )
      if (!checked) {
        head = Buffer.concat([head, chunk]).subarray(0, HEADER_WINDOW)
        if (head.length >= HEADER_WINDOW) {
          if (!head.includes('%PDF-')) throw notPdf()
          checked = true
        }
      }
      hash.update(chunk)
      await fh.write(chunk)
    }
    if (!checked && !head.includes('%PDF-')) throw notPdf()
    await fh.close()
    const id = hash.digest('hex')
    const file = blobPath(o.dataDir, id)
    if (existsSync(file)) rmSync(tmp)
    else {
      mkdirSync(dirname(file), { recursive: true })
      renameSync(tmp, file) // atomic: readers see all of the file or none of it
    }
    o.blobs.insert({
      id,
      mime: 'application/pdf',
      bytes: size,
      createdAt: (o.now ?? Date.now)(),
    }) // idempotent; also heals a lost row
    return { id, bytes: size }
  } catch (e) {
    await fh.close().catch(() => {})
    rmSync(tmp, { force: true })
    throw e
  }
}
