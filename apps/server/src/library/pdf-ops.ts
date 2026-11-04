import { readFileSync } from 'node:fs'
import { ApiError } from '../errors'
import { type OpenPdf, openPdf } from './pdf'
import { analyzePdf, type PageStats } from './route'

// The PDF jobs the server runs outside request handlers' thread (see pdf-service.ts). Each takes a path, not bytes: the
// file is read where it is parsed, so a 200 MB book is never copied between threads.

async function withPdf<T>(
  file: string,
  fn: (pdf: OpenPdf) => Promise<T>,
): Promise<T> {
  let bytes: Uint8Array
  try {
    bytes = readFileSync(file)
  } catch {
    throw new ApiError('not_found', 'no file for this book')
  }
  const pdf = await openPdf(bytes) // copies what it needs: pdfjs may take ownership of the buffer it is given
  try {
    return await fn(pdf)
  } finally {
    await pdf.close()
  }
}

export type ReadPages = {
  numPages: number
  pages: { n: number; label: string; text: string; png: Uint8Array }[]
}

export const pdfOps = {
  pageCount: (file: string): Promise<number> =>
    withPdf(file, async (pdf) => pdf.numPages),

  /** Text statistics of every page: what the router and the cost estimate need. */
  analyze: (file: string): Promise<PageStats[]> => withPdf(file, analyzePdf),

  /** Label, text layer and a PNG `width` px wide for each requested page, in the order asked. */
  readPages: (
    file: string,
    pages: number[],
    width: number,
  ): Promise<ReadPages> =>
    withPdf(file, async (pdf) => {
      const bad = pages.find((n) => n < 1 || n > pdf.numPages)
      if (bad !== undefined)
        throw new ApiError(
          'validation_failed',
          `pages ${bad} is past the last page (${pdf.numPages})`,
          { field: 'pages' },
        )
      const out: ReadPages['pages'] = []
      for (const n of pages)
        out.push({
          n,
          label: pdf.labels[n - 1] ?? String(n),
          text: await pdf.pageText(n),
          png: await pdf.renderPage(n, width),
        })
      return { numPages: pdf.numPages, pages: out }
    }),

  render: (file: string, n: number, width: number): Promise<Uint8Array> =>
    withPdf(file, async (pdf) => {
      if (!Number.isInteger(n) || n < 1 || n > pdf.numPages)
        throw new ApiError('not_found', 'no such page')
      return pdf.renderPage(n, width)
    }),
}

export type PdfOps = typeof pdfOps
