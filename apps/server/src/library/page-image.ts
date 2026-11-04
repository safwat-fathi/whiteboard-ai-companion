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
import type { PdfService } from './pdf-service'

export const PAGE_IMAGE_WIDTH = { min: 256, max: 2048, dflt: 1000 } as const

/** Renders in flight, by cache file: concurrent requests for one page share a single render. */
const inflight = new Map<string, Promise<void>>()

/**
 * A page of a book as a PNG `width` px wide, rendered once and kept under `DATA_DIR/cache/pages`. The page viewer and the
 * tutor's `add_book_figure` both read it from here. The render itself runs in the PDF service (a worker thread).
 */
export async function pageRaster(o: {
  dataDir: string
  book: BookRow
  n: number
  width: number
  pdf: Pick<PdfService, 'render'>
}): Promise<Buffer> {
  const { dataDir, book, n } = o
  const width = Math.min(
    PAGE_IMAGE_WIDTH.max,
    Math.max(PAGE_IMAGE_WIDTH.min, Math.round(o.width)),
  )
  const cached = join(dataDir, 'cache', 'pages', book.id, `${n}@${width}.png`)
  if (!existsSync(cached)) {
    let job = inflight.get(cached)
    if (!job) {
      job = (async () => {
        const png = await o.pdf.render(
          blobPath(dataDir, book.fileBlob),
          n,
          width,
        )
        mkdirSync(dirname(cached), { recursive: true })
        const tmp = `${cached}.${randomUUID()}.tmp`
        writeFileSync(tmp, png)
        renameSync(tmp, cached) // atomic: a reader sees all of the image or none of it
      })().finally(() => inflight.delete(cached))
      inflight.set(cached, job)
    }
    await job
  }
  return readFileSync(cached)
}
