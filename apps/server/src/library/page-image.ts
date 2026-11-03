import { randomUUID } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { blobPath } from '../blobs'
import type { BookRow } from '../db'
import { ApiError } from '../errors'
import { openPdf } from './pdf'

export const PAGE_IMAGE_WIDTH = { min: 256, max: 2048, dflt: 1000 } as const

/**
 * A page of a book as a PNG `width` px wide, rendered once and kept under `DATA_DIR/cache/pages`. The page viewer and the
 * tutor's `add_book_figure` both read it from here.
 */
export async function pageRaster(o: {
  dataDir: string
  book: BookRow
  n: number
  width: number
}): Promise<Buffer> {
  const { dataDir, book, n } = o
  const width = Math.min(
    PAGE_IMAGE_WIDTH.max,
    Math.max(PAGE_IMAGE_WIDTH.min, Math.round(o.width)),
  )
  const cached = join(dataDir, 'cache', 'pages', book.id, `${n}@${width}.png`)
  if (!existsSync(cached)) {
    let bytes: Uint8Array
    try {
      bytes = new Uint8Array(readFileSync(blobPath(dataDir, book.fileBlob)))
    } catch {
      throw new ApiError('not_found', 'no file for this book')
    }
    const pdf = await openPdf(bytes)
    try {
      if (n < 1 || n > pdf.numPages)
        throw new ApiError('not_found', 'no such page')
      const png = await pdf.renderPage(n, width)
      mkdirSync(dirname(cached), { recursive: true })
      const tmp = `${cached}.${randomUUID()}.tmp`
      writeFileSync(tmp, png)
      renameSync(tmp, cached) // atomic: a reader sees all of the image or none of it
    } finally {
      await pdf.close()
    }
  }
  return readFileSync(cached)
}
