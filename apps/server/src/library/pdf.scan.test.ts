import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createCanvas, loadImage } from '@napi-rs/canvas'
import { describe, expect, it } from 'vitest'
import { openPdf } from './pdf'

// The real scanned book is the owner's own and not in the repo (spikes/books is ignored): this runs where it exists.
const book = fileURLToPath(
  new URL('../../../../spikes/books/الجبر الخطي.pdf', import.meta.url),
)

describe.skipIf(!existsSync(book))(
  'rendering a scanned page (real book)',
  () => {
    it('draws the JBIG2 scan instead of a blank page', async () => {
      const pdf = await openPdf(new Uint8Array(readFileSync(book)))
      try {
        const png = await pdf.renderPage(45, 600)
        const img = await loadImage(Buffer.from(png))
        const canvas = createCanvas(img.width, img.height)
        const ctx = canvas.getContext('2d')
        ctx.drawImage(img, 0, 0)
        const { data } = ctx.getImageData(0, 0, img.width, img.height)
        let dark = 0
        for (let i = 0; i < data.length; i += 4)
          if ((data[i] as number) < 128) dark++
        // a page of printed text is a few percent ink; a blank page is none
        expect(dark / (img.width * img.height)).toBeGreaterThan(0.01)
      } finally {
        await pdf.close()
      }
    }, 30_000)
  },
)
