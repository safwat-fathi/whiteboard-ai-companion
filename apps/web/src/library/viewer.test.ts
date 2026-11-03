import { describe, expect, it } from 'vitest'
import { clampPage, pageCaption } from './viewer'

describe('clampPage', () => {
  it('keeps a page inside 1..pages and survives junk', () => {
    expect(clampPage(5, 10)).toBe(5)
    expect(clampPage(0, 10)).toBe(1)
    expect(clampPage(-3, 10)).toBe(1)
    expect(clampPage(99, 10)).toBe(10)
    expect(clampPage(2.7, 10)).toBe(2)
    expect(clampPage(Number.NaN, 10)).toBe(1)
    expect(clampPage(3, 0)).toBe(1)
  })
})

describe('pageCaption', () => {
  it('shows the printed label and the position in the file', () => {
    expect(pageCaption({ label: '42', page: 48, pages: 652 })).toBe(
      'p. 42 (file page 48 of 652)',
    )
  })
  it('does not repeat itself when the label is the file page', () => {
    expect(pageCaption({ label: '48', page: 48, pages: 652 })).toBe(
      'p. 48 of 652',
    )
  })
  it('works before the label has loaded', () => {
    expect(pageCaption({ label: null, page: 3, pages: 10 })).toBe(
      'page 3 of 10',
    )
  })
})
