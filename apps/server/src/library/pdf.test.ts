import { describe, expect, it } from 'vitest'
import type { ApiError } from '../errors'
import { cleanText, MAX_PDF_PAGES, openPdf } from './pdf'
import { makeTestPdf } from './test-pdf'

const fail = async (p: Promise<unknown>) =>
  (await p.catch((e) => e)) as ApiError

describe('cleanText', () => {
  it('strips control characters and private-use glyphs but keeps newlines and tabs', () => {
    expect(
      cleanText(`a\x01b${String.fromCharCode(0xe001)}c\x1Fd\x00e\x7Ff`),
    ).toBe('abcdef')
    expect(cleanText('line1\nline2\tx\r')).toBe('line1\nline2\tx')
  })
})

describe('openPdf', () => {
  const bytes = makeTestPdf({
    pages: ['Hello world\nsecond line', '', 'Third page: x = 2 + 3'],
    outline: [
      {
        title: 'Chapter 1',
        page: 1,
        children: [{ title: 'Section 1.1', page: 2 }],
      },
      { title: 'Chapter 2', page: 3 },
    ],
    labels: [
      { from: 1, style: 'r' },
      { from: 3, style: 'D', start: 1 },
    ],
  })

  it('reads the page count, text, labels and nested outline', async () => {
    const pdf = await openPdf(bytes)
    try {
      expect(pdf.numPages).toBe(3)
      const t1 = await pdf.pageText(1)
      expect(t1).toContain('Hello world')
      expect(t1).toContain('second line')
      expect(t1.split('\n').length).toBeGreaterThan(1)
      expect(await pdf.pageText(2)).toBe('')
      expect(await pdf.pageText(3)).toContain('x = 2 + 3')
      expect(pdf.labels).toEqual(['i', 'ii', '1'])
      expect(pdf.outline).toEqual([
        {
          title: 'Chapter 1',
          page: 1,
          children: [{ title: 'Section 1.1', page: 2, children: [] }],
        },
        { title: 'Chapter 2', page: 3, children: [] },
      ])
    } finally {
      await pdf.close()
    }
  })

  it('falls back to the file page number as the label and to an empty outline', async () => {
    const pdf = await openPdf(makeTestPdf({ pages: ['a', 'b'] }))
    expect(pdf.labels).toEqual(['1', '2'])
    expect(pdf.outline).toEqual([])
    await pdf.close()
  })

  it('renders a page to a PNG of the asked width', async () => {
    const pdf = await openPdf(bytes)
    const png = await pdf.renderPage(1, 306)
    await pdf.close()
    expect([...png.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10])
    const width = new DataView(png.buffer, png.byteOffset).getUint32(16)
    expect(width).toBe(306)
  })

  it('caps the longest side of a render at 4000 px', async () => {
    const pdf = await openPdf(bytes)
    const png = await pdf.renderPage(1, 99999)
    await pdf.close()
    const dv = new DataView(png.buffer, png.byteOffset)
    expect(Math.max(dv.getUint32(16), dv.getUint32(20))).toBe(4000)
  })

  it('refuses a corrupt file as ingest_failed', async () => {
    const e = await fail(openPdf(new TextEncoder().encode('%PDF-1.7 garbage')))
    expect(e.code).toBe('ingest_failed')
  })

  it('refuses more than 2,000 pages as ingest_failed naming the limit', async () => {
    const big = makeTestPdf({ pages: Array(MAX_PDF_PAGES + 1).fill('') })
    const e = await fail(openPdf(big))
    expect(e.code).toBe('ingest_failed')
    expect(e.details).toMatchObject({ limit: 2000 })
  })
})
