import { describe, expect, it } from 'vitest'
import { openPdf } from './pdf'
import { analyzePdf, estimate, pageStats, routePage } from './route'
import { makeTestPdf } from './test-pdf'

const prose =
  'The quick brown fox jumps over the lazy dog and keeps running through the long green meadow beside the river.'
const math =
  'x = 2 + 3 \u00d7 4 \u00f7 5 = 6 + 7 - 8 + 9 = 10 + 11 \u00d7 12 '.repeat(2)

describe('routePage', () => {
  it('sends a nearly empty page (a scan) and a math-dense page to R4, prose to R1', () => {
    expect(routePage(pageStats(''))).toBe('R4')
    expect(routePage(pageStats('p. 12'))).toBe('R4')
    expect(routePage(pageStats(math))).toBe('R4')
    expect(routePage(pageStats(prose))).toBe('R1')
  })

  it('treats exactly 50 characters of plain text as text and 49 as a scan', () => {
    expect(routePage(pageStats('a'.repeat(50)))).toBe('R1')
    expect(routePage(pageStats('a'.repeat(49)))).toBe('R4')
  })

  it('does not count surrounding whitespace toward the 50 characters', () => {
    expect(routePage(pageStats(`  \n${'a'.repeat(30)}\n  `))).toBe('R4')
  })
})

describe('estimate', () => {
  it('counts pages per rung and prices the opt-in and the embeddings', () => {
    const stats = [
      pageStats(prose),
      pageStats(''),
      pageStats(math),
      pageStats(prose),
    ]
    const e = estimate(stats)
    expect(e).toMatchObject({
      pages: 4,
      r1: 2,
      r4: 2,
      scanned: 1,
      mathDense: 1,
    })
    expect(e.r3Usd).toBeCloseTo(2 * 0.00205, 10)
    expect(e.embedUsd).toBeGreaterThan(0)
    expect(e.embedUsd).toBeLessThan(0.001)
  })
})

describe('analyzePdf', () => {
  it('measures every page of a real PDF', async () => {
    const pdf = await openPdf(
      makeTestPdf({ pages: [prose, '', `${math}\n${math}`] }),
    )
    const stats = await analyzePdf(pdf)
    await pdf.close()
    expect(stats.map(routePage)).toEqual(['R1', 'R4', 'R4'])
  })
})
