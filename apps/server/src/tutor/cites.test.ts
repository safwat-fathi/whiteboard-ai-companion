import { describe, expect, it } from 'vitest'
import { sanitizeCites } from './cites'

const A = 'a'.repeat(64)
const B = 'b'.repeat(64)
const sources = [{ bookId: A, pageStart: 40, pageEnd: 44 }]

describe('sanitizeCites', () => {
  it('keeps a citation to a page the model was shown', () => {
    const t = `Chloroplasts [p. 41](cite:${A}#41) and [p. 44](cite:${A}#44).`
    expect(sanitizeCites(t, sources)).toEqual({ text: t, stripped: 0 })
  })
  it('turns an unseen page, another book, or a malformed link into its plain label and counts them', () => {
    const t = `[p. 99](cite:${A}#99), [p. 41](cite:${B}#41), [x](cite:nonsense) and [ok](cite:${A}#42).`
    expect(sanitizeCites(t, sources)).toEqual({
      text: `p. 99, p. 41, x and [ok](cite:${A}#42).`,
      stripped: 3,
    })
  })
  it('leaves every other link and text alone, and strips everything when nothing was shown', () => {
    expect(
      sanitizeCites('see [docs](https://x.test) and [el](board:el_1)', []),
    ).toEqual({
      text: 'see [docs](https://x.test) and [el](board:el_1)',
      stripped: 0,
    })
    expect(sanitizeCites(`[p. 1](cite:${A}#1)`, []).text).toBe('p. 1')
  })
})
