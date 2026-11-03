import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { apiError } from '../errors'

export const MAX_PDF_PAGES = 2000 // auth-security.md: 200 MB, 2,000 pages
const MAX_RENDER_SIDE = 4000 // px; a decompression-bomb guard for page rasters

export type OutlineItem = {
  title: string
  /** 1-based page index, or null when the entry points nowhere we can resolve */
  page: number | null
  children: OutlineItem[]
}

export type OpenPdf = {
  numPages: number
  outline: OutlineItem[]
  /** The printed page label of each page (index 0 = page 1); the file page number when the PDF has none. */
  labels: string[]
  /** Cleaned text of a page (1-based), lines kept; '' for a page with no text layer. */
  pageText(n: number): Promise<string>
  /** PNG of a page at `width` px (white background); no side is ever longer than 4,000 px. */
  renderPage(n: number, width: number): Promise<Uint8Array>
  close(): Promise<void>
}

/** pdfjs emits raw control characters and private-use glyphs on math fonts (S4b): both are dropped; \n and \t stay. */
export const cleanText = (s: string): string =>
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the point
  s.replace(/[\x00-\x08\x0B-\x1F\x7F-]/g, '')

const assets = (() => {
  const dir = dirname(
    createRequire(import.meta.url).resolve('pdfjs-dist/package.json'),
  )
  return {
    standardFontDataUrl: `${pathToFileURL(join(dir, 'standard_fonts')).href}/`,
    cMapUrl: `${pathToFileURL(join(dir, 'cmaps')).href}/`,
  }
})()

type Dest = unknown[] | string | null
type RawOutline = { title: string; dest: Dest; items?: RawOutline[] }

/**
 * Opens a PDF with pdfjs (its legacy Node build; v5 dropped the `isEvalSupported` option, so there is nothing to switch off). A corrupt, encrypted or too-long file is an
 * `ingest_failed`. The bytes are copied because pdfjs may take ownership of the buffer it is given.
 */
export async function openPdf(bytes: Uint8Array): Promise<OpenPdf> {
  let doc: Awaited<ReturnType<typeof getDocument>['promise']>
  try {
    doc = await getDocument({
      data: new Uint8Array(bytes),
      verbosity: 0,
      ...assets,
      cMapPacked: true,
    }).promise
  } catch (e) {
    const encrypted = (e as Error)?.name === 'PasswordException'
    throw apiError(
      'ingest_failed',
      encrypted ? 'the PDF is encrypted' : 'the PDF could not be read',
      { step: 'open' },
    )
  }
  if (doc.numPages > MAX_PDF_PAGES) {
    const pages = doc.numPages
    await doc.destroy()
    throw apiError(
      'ingest_failed',
      `the PDF has ${pages} pages; the limit is ${MAX_PDF_PAGES}`,
      { step: 'open', limit: MAX_PDF_PAGES, pages },
    )
  }

  const pageOf = async (dest: Dest): Promise<number | null> => {
    try {
      const d = typeof dest === 'string' ? await doc.getDestination(dest) : dest
      const ref = Array.isArray(d) ? d[0] : null
      if (ref === null || ref === undefined) return null
      return typeof ref === 'number'
        ? ref + 1
        : (await doc.getPageIndex(
            ref as Parameters<typeof doc.getPageIndex>[0],
          )) + 1
    } catch {
      return null
    }
  }
  const walk = async (items: RawOutline[]): Promise<OutlineItem[]> => {
    const out: OutlineItem[] = []
    for (const it of items)
      out.push({
        title: cleanText(it.title).trim(),
        page: await pageOf(it.dest),
        children: await walk(it.items ?? []),
      })
    return out
  }
  const outline = await walk(((await doc.getOutline()) ?? []) as RawOutline[])
  const raw = await doc.getPageLabels()
  const labels = Array.from(
    { length: doc.numPages },
    (_, i) => cleanText(raw?.[i] ?? '').trim() || String(i + 1),
  )

  return {
    numPages: doc.numPages,
    outline,
    labels,
    async pageText(n) {
      const page = await doc.getPage(n)
      try {
        const tc = await page.getTextContent()
        let text = ''
        for (const it of tc.items)
          if ('str' in it) text += cleanText(it.str) + (it.hasEOL ? '\n' : ' ')
        return text
          .split('\n')
          .map((l) => l.replace(/[ \t]+/g, ' ').trim())
          .join('\n')
          .replace(/\n{3,}/g, '\n\n')
          .trim()
      } finally {
        page.cleanup()
      }
    },
    async renderPage(n, width) {
      const page = await doc.getPage(n)
      try {
        const base = page.getViewport({ scale: 1 })
        const scale = Math.min(
          width / base.width,
          MAX_RENDER_SIDE / base.width,
          MAX_RENDER_SIDE / base.height,
        )
        const viewport = page.getViewport({ scale })
        const { canvas, context } = (
          doc as unknown as {
            canvasFactory: {
              create(
                w: number,
                h: number,
              ): {
                canvas: { toBuffer(type: string): Buffer }
                context: unknown
              }
            }
          }
        ).canvasFactory.create(
          Math.max(1, Math.round(viewport.width)),
          Math.max(1, Math.round(viewport.height)),
        )
        await page.render({
          canvasContext: context,
          canvas,
          viewport,
          background: 'rgb(255,255,255)',
        } as unknown as Parameters<typeof page.render>[0]).promise
        return new Uint8Array(canvas.toBuffer('image/png'))
      } finally {
        page.cleanup()
      }
    },
    close: () => doc.destroy(),
  }
}
